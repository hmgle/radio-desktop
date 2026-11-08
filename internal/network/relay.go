package network

import (
	"bufio"
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
	"time"
)

type relay struct {
	secret [32]byte
	base   string
	server *http.Server
	client *http.Client
}

func newRelay(t *http.Transport) (*relay, error) {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	r := &relay{base: "http://" + l.Addr().String()}
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

func (r *relay) signature(target string) []byte {
	h := hmac.New(sha256.New, r.secret[:])
	h.Write([]byte(target))
	return h.Sum(nil)
}

func (r *relay) mediaURL(raw string) string {
	u, err := remoteURL(raw)
	if err != nil {
		return "" // never let an unsupported target bypass the policy
	}
	encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
	sig := base64.RawURLEncoding.EncodeToString(r.signature(encoded))
	name := "media"
	if strings.HasSuffix(strings.ToLower(u.Path), ".m3u8") {
		name += ".m3u8"
	}
	return r.base + "/" + sig + "/" + encoded + "/" + name
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
	sig, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !hmac.Equal(sig, r.signature(parts[1])) {
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
	method := req.Method
	knownPlaylist := playlistURL(u)
	if knownPlaylist {
		// A playlist is a different representation after rewriting. Fetch
		// its complete body even for HEAD and evaluate ranges locally.
		method = http.MethodGet
	}
	upstream, err := http.NewRequestWithContext(req.Context(), method, u.String(), nil)
	if err != nil {
		http.Error(w, "invalid media target", http.StatusBadRequest)
		return
	}
	for _, key := range []string{"Range", "If-Range", "Accept"} {
		if knownPlaylist && key != "Accept" {
			continue
		}
		if v := req.Header.Get(key); v != "" {
			upstream.Header.Set(key, v)
		}
	}
	upstream.Header.Set("User-Agent", "radio-desktop/0.2.1")
	upstream.Header.Set("Accept-Encoding", "identity")
	resp, err := r.client.Do(upstream)
	if err != nil {
		// Do not expose target credentials or proxy internals to a page.
		http.Error(w, "media connection failed", http.StatusBadGateway)
		return
	}
	defer func() { resp.Body.Close() }()
	w.Header().Set("Cache-Control", "no-store")
	body := bufio.NewReader(resp.Body)
	playlist := knownPlaylist || playlistResponse(resp)
	if !playlist && resp.Request.Method != http.MethodHead && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		prefix, _ := body.Peek(7)
		playlist = string(prefix) == "#EXTM3U"
	}
	probeUnsatisfiedRange := resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && req.Header.Get("Range") != ""
	probeMultipart := resp.StatusCode == http.StatusPartialContent && strings.HasPrefix(resp.Header.Get("Content-Type"), "multipart/byteranges")
	if (playlist && (resp.StatusCode == http.StatusPartialContent || resp.Request.Method == http.MethodHead)) || probeUnsatisfiedRange || probeMultipart {
		// An extensionless or redirected playlist may only be recognized
		// after a range probe. Never rewrite its partial response as a
		// complete manifest, or reuse its validators for the relay body.
		original := resp
		full := upstream.Clone(req.Context())
		full.Method, full.URL = http.MethodGet, resp.Request.URL
		full.Header.Del("Range")
		full.Header.Del("If-Range")
		next, err := r.client.Do(full)
		if err != nil {
			http.Error(w, "media connection failed", http.StatusBadGateway)
			return
		}
		nextBody := bufio.NewReader(next.Body)
		if !playlist {
			// Error and multipart responses hide the original MIME type.
			// Inspect a full response: an offset may exist only after URI
			// rewriting. Keep the original response for binary resources.
			prefix, _ := nextBody.Peek(7)
			playlist = playlistResponse(next) || string(prefix) == "#EXTM3U"
		}
		if playlist {
			original.Body.Close()
			resp, body = next, nextBody
			if resp.StatusCode != http.StatusOK {
				http.Error(w, "incomplete media playlist", http.StatusBadGateway)
				return
			}
		} else {
			next.Body.Close()
		}
	}
	if playlist && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if resp.StatusCode != http.StatusOK {
			http.Error(w, "incomplete media playlist", http.StatusBadGateway)
			return
		}
		const maxPlaylist = 2 << 20
		data, err := io.ReadAll(io.LimitReader(body, maxPlaylist+1))
		if err != nil || len(data) > maxPlaylist || !bytes.HasPrefix(data, []byte("#EXTM3U")) {
			http.Error(w, "invalid media playlist", http.StatusBadGateway)
			return
		}
		data, err = r.rewritePlaylist(data, resp.Request.URL)
		if err != nil {
			http.Error(w, "unsupported media playlist", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sha256.Sum256(data)))
		http.ServeContent(w, req, "playlist.m3u8", time.Time{}, bytes.NewReader(data))
		return
	}
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
	io.Copy(flushingWriter{w}, body)
}

func playlistURL(u *url.URL) bool {
	return strings.HasSuffix(strings.ToLower(u.Path), ".m3u8")
}

func playlistResponse(resp *http.Response) bool {
	typeName := strings.ToLower(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	return strings.Contains(typeName, "mpegurl") || playlistURL(resp.Request.URL)
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

func (r *relay) rewritePlaylist(data []byte, base *url.URL) ([]byte, error) {
	var rewriteErr error
	rewrite := func(ref string) string {
		if strings.HasPrefix(ref, "data:") {
			return ref
		}
		u, err := url.Parse(ref)
		if err != nil || strings.Contains(ref, "{$") {
			rewriteErr = errors.New("unsupported playlist reference")
			return ""
		}
		result := r.mediaURL(base.ResolveReference(u).String())
		if result == "" {
			rewriteErr = errors.New("unsupported playlist protocol")
		}
		return result
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#EXT-X-CONTENT-STEERING:") {
			return nil, errors.New("unsupported content steering")
		}
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			lines[i] = rewrite(trimmed)
		} else {
			// Native parsers may accept malformed unquoted URI attributes.
			// Refuse any attribute we cannot rewrite, rather than allowing
			// an upstream URL to reach a platform's own network stack.
			if len(playlistURIAttribute.FindAllStringIndex(line, -1)) != len(playlistURI.FindAllStringIndex(line, -1)) {
				return nil, errors.New("malformed playlist URI")
			}
			lines[i] = playlistURI.ReplaceAllStringFunc(line, func(attr string) string {
				pos := strings.Index(attr, `="`)
				return attr[:pos+2] + rewrite(attr[pos+2:len(attr)-1]) + `"`
			})
		}
	}
	return []byte(strings.Join(lines, "\n")), rewriteErr
}
