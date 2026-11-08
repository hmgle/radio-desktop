package network

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type relay struct {
	secret       [32]byte
	base         string
	server       *http.Server
	client       *http.Client
	types        sync.Map
	probeTimeout time.Duration
}

func newRelay(t *http.Transport) (*relay, error) {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	r := &relay{base: "http://" + l.Addr().String(), probeTimeout: defaultProbeTimeout}
	if _, err := rand.Read(r.secret[:]); err != nil {
		l.Close()
		return nil, err
	}
	// Streams have no overall deadline; header waits remain bounded.
	t = t.Clone()
	t.ResponseHeaderTimeout = 15 * time.Second
	r.client = &http.Client{Transport: t}
	r.server = &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go r.server.Serve(l)
	return r, nil
}

func remoteURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || len(raw) > 8192 {
		return nil, errors.New("invalid media URL")
	}
	return u, nil
}

func (r *relay) signature(target string, kind resourceKind) []byte {
	h := hmac.New(sha256.New, r.secret[:])
	h.Write([]byte(string(kind) + "\x00" + target))
	return h.Sum(nil)
}

func (r *relay) mediaURL(raw string) string {
	kind := resourceUnknown
	if u, err := remoteURL(raw); err == nil && playlistURL(u) {
		kind = resourcePlaylist
	}
	return r.typedURL(raw, kind)
}

func (r *relay) typedURL(raw string, kind resourceKind) string {
	if _, err := remoteURL(raw); err != nil {
		return ""
	}
	encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
	sig := base64.RawURLEncoding.EncodeToString(r.signature(encoded, kind))
	return r.base + "/" + sig + "/" + encoded + "/" + string(kind)
}

func (r *relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Exact Host and per-process signatures prevent DNS rebinding and
	// unauthenticated callers from turning this into an open forward proxy.
	if "http://"+req.Host != r.base {
		http.Error(w, "invalid host", http.StatusForbidden)
		return
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/"), "/")
	if len(parts) != 3 {
		http.NotFound(w, req)
		return
	}
	kind := resourceKind(parts[2])
	if kind != resourceUnknown && kind != resourcePlaylist && kind != resourceBinary {
		http.Error(w, "invalid media type", http.StatusForbidden)
		return
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !hmac.Equal(sig, r.signature(parts[1], kind)) {
		http.Error(w, "invalid media token", http.StatusForbidden)
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		http.Error(w, "invalid media target", http.StatusBadRequest)
		return
	}
	u, err := remoteURL(string(raw))
	if err != nil {
		http.Error(w, "invalid media target", http.StatusBadRequest)
		return
	}
	if err := mergeDeliveryDirectives(u, req.URL.RawQuery); err != nil {
		http.Error(w, "invalid HLS delivery directives", http.StatusBadRequest)
		return
	}
	kind, resp, observation, err := r.open(req, u, kind, parts[1])
	// Every error and unsupported response leaves learned routes eligible
	// for another probe. Successful paths finish the observation explicitly.
	defer observation.finish(resourceUnknown)
	fail := func(message string, status int) {
		// Publish the outcome before the client can observe the error and
		// start a retry; deferred cleanup alone would leave a race window.
		observation.finish(resourceUnknown)
		http.Error(w, message, status)
	}
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errProbeTimeout) {
			status = http.StatusGatewayTimeout
		}
		fail("media connection failed", status)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Cache-Control", "no-store")

	if kind == resourcePlaylist && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if resp.StatusCode != http.StatusOK {
			fail("incomplete media playlist", http.StatusBadGateway)
			return
		}
		const maxPlaylist = 2 << 20
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxPlaylist+1))
		if err != nil || req.Context().Err() != nil || len(data) > maxPlaylist || !validPlaylistText(data) {
			fail("invalid media playlist", http.StatusBadGateway)
			return
		}
		data, err = r.rewritePlaylist(data, resp.Request.URL)
		if err != nil {
			fail("unsupported media playlist", http.StatusBadGateway)
			return
		}
		// MIME, redirects, and a prefix are provisional until the complete
		// supported representation has been read, validated, and rewritten.
		observation.finish(resourcePlaylist)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sha256.Sum256(data)))
		http.ServeContent(w, req, "playlist.m3u8", time.Time{}, bytes.NewReader(data))
		return
	}
	if kind == resourceBinary {
		observation.acceptBinary(resp)
	}
	observation.finish(resourceUnknown)
	for _, key := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if v := resp.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if req.Method == http.MethodHead {
		return
	}
	http.NewResponseController(w).Flush()
	io.Copy(flushingWriter{w}, resp.Body)
}

type flushingWriter struct{ http.ResponseWriter }

func (w flushingWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if err == nil {
		err = http.NewResponseController(w.ResponseWriter).Flush()
	}
	return n, err
}

var playlistURI = regexp.MustCompile(`\b(?:[A-Z-]*URI)="([^"]*)"`)
var playlistURIAttribute = regexp.MustCompile(`\b(?:[A-Z-]*URI)=`)

func validPlaylistText(data []byte) bool {
	header, _, _ := bytes.Cut(data, []byte{'\n'})
	if !utf8.Valid(data) || !bytes.Equal(bytes.TrimSuffix(header, []byte{'\r'}), []byte("#EXTM3U")) {
		return false
	}
	for i, c := range string(data) {
		if c == '\r' {
			if i+1 == len(data) || data[i+1] != '\n' {
				return false
			}
		} else if c < 0x20 && c != '\n' || c >= 0x7f && c <= 0x9f {
			return false
		}
	}
	return true
}

func (r *relay) rewritePlaylist(data []byte, base *url.URL) ([]byte, error) {
	var rewriteErr error
	rewrite := func(ref string, kind resourceKind) string {
		if strings.HasPrefix(ref, "data:") {
			return ref
		}
		u, err := url.Parse(ref)
		if err != nil || strings.Contains(ref, "{$") {
			rewriteErr = errors.New("unsupported playlist reference")
			return ""
		}
		result := r.typedURL(base.ResolveReference(u).String(), kind)
		if result == "" {
			rewriteErr = errors.New("unsupported playlist protocol")
		}
		return result
	}
	lines := strings.Split(string(data), "\n")
	variant := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#EXT-X-CONTENT-STEERING:") {
			return nil, errors.New("unsupported content steering")
		}
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			kind := resourceBinary
			if variant {
				kind = resourcePlaylist
			}
			lines[i] = rewrite(trimmed, kind)
			variant = false
		} else {
			tag, _, _ := strings.Cut(trimmed, ":")
			kind := resourceUnknown
			switch tag {
			case "#EXT-X-STREAM-INF":
				variant = true
			case "#EXT-X-MEDIA", "#EXT-X-I-FRAME-STREAM-INF", "#EXT-X-RENDITION-REPORT", "#EXT-X-IMAGE-STREAM-INF":
				kind = resourcePlaylist
			case "#EXT-X-KEY", "#EXT-X-SESSION-KEY", "#EXT-X-MAP", "#EXT-X-PART", "#EXT-X-PRELOAD-HINT":
				kind = resourceBinary
			}
			// Native parsers may accept malformed unquoted URI attributes.
			// Refuse any attribute we cannot rewrite, rather than allowing
			// an upstream URL to reach a platform's own network stack.
			if len(playlistURIAttribute.FindAllStringIndex(line, -1)) != len(playlistURI.FindAllStringIndex(line, -1)) {
				return nil, errors.New("malformed playlist URI")
			}
			lines[i] = playlistURI.ReplaceAllStringFunc(line, func(attr string) string {
				pos := strings.Index(attr, `="`)
				return attr[:pos+2] + rewrite(attr[pos+2:len(attr)-1], kind) + `"`
			})
		}
	}
	return []byte(strings.Join(lines, "\n")), rewriteErr
}
