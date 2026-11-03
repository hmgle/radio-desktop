// Package icy keeps a sidecar HTTP connection to a playing stream and
// parses ICY metadata (StreamTitle) out of it, the same trick radio-cli
// uses for track artwork: one auxiliary connection while the real audio
// plays elsewhere (here: the webview's <audio> element).
package icy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Meta is the metadata pushed on every change.
type Meta struct {
	Name  string `json:"name"`  // icy-name header
	Genre string `json:"genre"` // icy-genre header
	Title string `json:"title"` // StreamTitle
	// ArtworkURL is the current track's cover when the stream provides
	// one (StreamArtwork / image StreamUrl / icy-cover header).
	ArtworkURL string `json:"artworkUrl"`
}

// Sidecar watches one stream URL until stopped.
type Sidecar struct {
	url       string
	userAgent string
	onMeta    func(Meta)

	mu       sync.Mutex
	stopped  bool
	lastRead time.Time
	cancel   context.CancelFunc
	done     chan struct{}
}

// Start launches the sidecar goroutine for url. onMeta is called from
// that goroutine (never from the caller's).
func Start(url, userAgent string, onMeta func(Meta)) *Sidecar {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Sidecar{url: url, userAgent: userAgent, onMeta: onMeta, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		s.run(ctx)
	}()
	return s
}

// Stop ends the sidecar and waits for the goroutine.
func (s *Sidecar) Stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		<-s.done
		return
	}
	s.stopped = true
	s.mu.Unlock()
	s.cancel()
	<-s.done
}

func (s *Sidecar) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

// run reconnects with capped backoff until stopped. A stream without
// icy-metaint cannot carry in-band titles; the header info is pushed once
// and the sidecar quits quietly.
func (s *Sidecar) run(ctx context.Context) {
	backoff := 1 * time.Second
	for {
		if ctx.Err() != nil || s.isStopped() {
			return
		}
		err := s.connect(ctx)
		if ctx.Err() != nil || s.isStopped() {
			return
		}
		if errors.Is(err, errNoMetaInt) {
			return
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff = min(backoff*3, 30*time.Second)
	}
}

var errNoMetaInt = errors.New("icy: stream has no icy-metaint header")

func (s *Sidecar) connect(ctx context.Context) error {
	// The watchdog cancels connCtx to abort a hung response body.
	connCtx, connCancel := context.WithCancel(ctx)
	defer connCancel()

	req, err := http.NewRequestWithContext(connCtx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Icy-MetaData", "1")
	req.Header.Set("User-Agent", s.userAgent)
	// Transparent gzip would shift every frame and misalign metaint.
	req.Header.Set("Accept-Encoding", "identity")

	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = base.Clone()
	}
	transport.ResponseHeaderTimeout = 15 * time.Second
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport} // no overall stream timeout
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("icy: status " + resp.Status)
	}

	meta := Meta{
		Name:       cleanTitle([]byte(resp.Header.Get("icy-name"))),
		Genre:      cleanTitle([]byte(resp.Header.Get("icy-genre"))),
		ArtworkURL: headerArtwork(resp.Header.Get("icy-cover")),
	}
	metaint, _ := strconv.Atoi(resp.Header.Get("icy-metaint"))
	if metaint > 16<<20 {
		return errors.New("icy: metadata interval exceeds 16 MiB")
	}
	if metaint <= 0 {
		if meta.Name != "" || meta.Genre != "" || meta.ArtworkURL != "" {
			s.onMeta(meta)
		}
		return errNoMetaInt
	}
	s.mu.Lock()
	s.lastRead = time.Now()
	s.mu.Unlock()

	// Idle watchdog: streams can hang mid-frame; force a reconnect.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case t := <-ticker.C:
				s.mu.Lock()
				lastRead := s.lastRead
				s.mu.Unlock()
				if !lastRead.IsZero() && t.Sub(lastRead) > 30*time.Second {
					connCancel()
					return
				}
			}
		}
	}()

	title := ""
	artwork := meta.ArtworkURL
	reader := activityReader{Reader: resp.Body, onRead: func() {
		s.mu.Lock()
		s.lastRead = time.Now()
		s.mu.Unlock()
	}}
	buf := make([]byte, metaint)
	metaLen := make([]byte, 1)
	for {
		if _, err := io.ReadFull(reader, buf); err != nil {
			return err
		}
		if _, err := io.ReadFull(reader, metaLen); err != nil {
			return err
		}
		if n := int(metaLen[0]) * 16; n > 0 {
			block := make([]byte, n)
			if _, err := io.ReadFull(reader, block); err != nil {
				return err
			}
			attrs := ParseBlock(block)
			nextTitle := attrs["StreamTitle"]
			nextArtwork, hasArtwork := pickArtwork(attrs)
			if !hasArtwork {
				nextArtwork = artwork
			}
			if nextTitle != title || nextArtwork != artwork {
				title = nextTitle
				artwork = nextArtwork
				meta.Title = title
				meta.ArtworkURL = artwork
				s.onMeta(meta)
			}
		}
	}
}

type activityReader struct {
	io.Reader
	onRead func()
}

func (r activityReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 {
		r.onRead()
	}
	return n, err
}

// ParseBlock parses one ICY metadata block — "key='value';key2='value2'"
// with ” escapes inside single quotes — into its attributes. Sources
// differ in what they send: StreamTitle always, and StreamArtwork /
// StreamUrl for the current track's cover (Live365 DAS, some Icecast).
func ParseBlock(block []byte) map[string]string {
	m := make(map[string]string, 3)
	i := 0
	for i < len(block) {
		for i < len(block) && (block[i] == ';' || block[i] == ' ' || block[i] == '\x00') {
			i++
		}
		eq := bytes.IndexByte(block[i:], '=')
		if eq < 0 {
			break
		}
		if semi := bytes.IndexByte(block[i:i+eq], ';'); semi >= 0 {
			i += semi + 1
			continue
		}
		key := strings.TrimSpace(string(block[i : i+eq]))
		j := i + eq + 1
		if key == "" {
			semi := bytes.IndexByte(block[j:], ';')
			if semi < 0 {
				break
			}
			i = j + semi + 1
			continue
		}
		if j >= len(block) {
			break
		}
		var val []byte
		var next int
		if q := block[j]; q == '\'' || q == '"' {
			k := j + 1
			for k < len(block) {
				c := block[k]
				if c == q {
					if q == '\'' && k+1 < len(block) && block[k+1] == '\'' {
						val = append(val, '\'')
						k += 2
						continue
					}
					break
				}
				val = append(val, c)
				k++
			}
			next = k
			if next < len(block) {
				next++
			}
		} else {
			// Unquoted value: runs to the next separator.
			sep := bytes.IndexByte(block[j:], ';')
			if sep < 0 {
				sep = len(block) - j
			}
			val = append(val, block[j:j+sep]...)
			next = j + sep
		}
		if key != "" {
			m[key] = cleanTitle(val)
		}
		// Resume at the attribute after the next ';'.
		semi := bytes.IndexByte(block[next:], ';')
		if semi < 0 {
			break
		}
		i = next + semi + 1
	}
	return m
}

// pickArtwork selects the track cover URL out of a metadata block. The
// second return reports whether the block spoke about artwork at all —
// streams that never mention it keep their previous cover (e.g. the
// connect-time icy-cover header). Placeholder images (Live365's
// blankart) and non-image StreamUrls (some stations put their homepage
// there) are rejected.
func pickArtwork(attrs map[string]string) (string, bool) {
	if attrs == nil {
		return "", false
	}
	if u, ok := attrs["StreamArtwork"]; ok {
		return cleanArtworkURL(u), true
	}
	if u := attrs["StreamUrl"]; looksLikeImageURL(u) {
		return cleanArtworkURL(u), true
	}
	return "", false
}

func cleanArtworkURL(u string) string {
	if !httpURL(u) || isPlaceholderArtwork(u) {
		return ""
	}
	return u
}

func headerArtwork(header string) string {
	return cleanArtworkURL(header)
}

var placeholderArtwork = []string{"blankart.jpg"}

func isPlaceholderArtwork(u string) bool {
	lu := strings.ToLower(u)
	for _, p := range placeholderArtwork {
		if strings.Contains(lu, p) {
			return true
		}
	}
	return false
}

func looksLikeImageURL(u string) bool {
	if u == "" || !httpURL(u) {
		return false
	}
	lu := strings.ToLower(u)
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".webp", ".gif"} {
		if strings.Contains(lu, ext) {
			return true
		}
	}
	// Query-string URLs without extensions.
	return strings.Contains(lu, "artwork") || strings.Contains(lu, "cover")
}

func httpURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// cleanTitle strips control characters and whitespace noise and caps the
// length, mirroring radio-cli's clean_text.
func cleanTitle(b []byte) string {
	out := make([]byte, 0, len(b))
	for _, c := range b {
		switch {
		case c < 0x20 || c == 0x7f:
			// drop
		default:
			out = append(out, c)
		}
	}
	s := strings.TrimSpace(string(out))
	if len(s) > 1024 {
		s = s[:1024]
	}
	return s
}
