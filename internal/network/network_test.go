package network

import (
	"bufio"
	"context"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConfigValidation(t *testing.T) {
	for _, address := range []string{"http://127.0.0.1:8080", "https://proxy.example:443", "socks5://[::1]:1080", "socks5h://proxy.example:1080"} {
		if err := (Config{Mode: "manual", URL: address}).Validate(); err != nil {
			t.Errorf("rejected %s: %v", address, err)
		}
	}
	for _, address := range []string{"", "127.0.0.1:8080", "ftp://proxy.example:21", "http://proxy.example", "http://proxy.example:0", "http://proxy.example:65536", "http://user:secret@proxy.example:8080", "http://proxy.example:8080/path", "http://proxy.example:8080?token=secret", "http://proxy.example:8080#x"} {
		if err := (Config{Mode: "manual", URL: address}).Validate(); err == nil {
			t.Errorf("accepted invalid proxy address")
		}
	}
	if err := (Config{Mode: "unknown"}).Validate(); err == nil {
		t.Fatal("accepted unknown mode")
	}
}

func session(t *testing.T, mode, address string) *Session {
	t.Helper()
	s, err := New(Config{Mode: mode, URL: address})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func readResponse(t *testing.T, raw string, headers http.Header) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(data)
}

func TestManualRelayLoadsAllPlaylistResources(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !req.URL.IsAbs() || req.URL.Hostname() != "station.invalid" {
			t.Errorf("request did not use proxy: %s", req.URL)
		}
		if req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "" {
			t.Error("relay forwarded browser credentials")
		}
		mu.Lock()
		seen[req.URL.Path]++
		mu.Unlock()
		switch req.URL.Path {
		case "/start":
			http.Redirect(w, req, "http://station.invalid/base/master.m3u8", http.StatusFound)
		case "/base/master.m3u8":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio.m3u8\"\nvideo.m3u8\n")
		case "/base/video.m3u8":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"/key?k=1\"\n#EXT-X-MAP:URI=\"init.mp4\"\nsegment.ts?token=example\n#EXT-X-ENDLIST\n")
		case "/base/audio.m3u8":
			fmt.Fprint(w, "#EXTM3U\naudio.aac\n#EXT-X-ENDLIST\n")
		case "/base/segment.ts":
			if req.URL.RawQuery != "token=example" || req.Header.Get("Range") != "bytes=2-3" {
				t.Error("range or query was lost")
			}
			w.Header().Set("Content-Range", "bytes 2-3/6")
			w.WriteHeader(http.StatusPartialContent)
			fmt.Fprint(w, "cd")
		default:
			fmt.Fprint(w, "resource")
		}
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	// Explicit settings override inherited environment configuration.
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	var walk func(string)
	walk = func(raw string) {
		code, body := readResponse(t, raw, http.Header{"Range": {"bytes=2-3"}, "Cookie": {"secret"}, "Authorization": {"secret"}})
		if code != http.StatusOK && code != http.StatusPartialContent {
			t.Fatalf("relay status %d: %s", code, body)
		}
		if !strings.HasPrefix(body, "#EXTM3U") {
			return
		}
		for _, line := range strings.Split(body, "\n") {
			if line == "" {
				continue
			}
			if !strings.HasPrefix(line, "#") {
				if !strings.HasPrefix(line, s.relay.base+"/") {
					t.Fatalf("playlist leaked upstream URL: %s", line)
				}
				walk(line)
			}
			for _, match := range playlistURI.FindAllStringSubmatch(line, -1) {
				if !strings.HasPrefix(match[1], s.relay.base+"/") {
					t.Fatal("playlist attribute escaped relay")
				}
				walk(match[1])
			}
		}
	}
	walk(s.MediaURL("http://station.invalid/start"))
	mu.Lock()
	defer mu.Unlock()
	for _, path := range []string{"/start", "/base/master.m3u8", "/base/video.m3u8", "/base/audio.m3u8", "/key", "/base/init.mp4", "/base/segment.ts", "/base/audio.aac"} {
		if seen[path] != 1 {
			t.Errorf("proxy received %s %d times", path, seen[path])
		}
	}
}

func TestRelayCancellationAndAccessControl(t *testing.T) {
	cancelled := make(chan struct{})
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fmt.Fprint(w, "12345678")
		w.(http.Flusher).Flush()
		<-req.Context().Done()
		close(cancelled)
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.MediaURL("http://station.invalid/stream")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatal(err)
	}
	cancel()
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not cancel upstream stream")
	}
	if code, _ := readResponse(t, strings.Replace(raw, "/media", "tampered/media", 1), nil); code != http.StatusForbidden {
		t.Fatalf("tampered token accepted: %d", code)
	}
	bad, _ := http.NewRequest(http.MethodGet, raw, nil)
	bad.Host = "untrusted.example"
	response, err := http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatal("untrusted host accepted")
	}
}

func TestRelayRejectsPlaylistReferencesThatCannotFollowPolicy(t *testing.T) {
	s := session(t, "direct", "")
	for _, playlist := range []string{
		"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"file:///key\"\nsegment.ts\n",
		"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=http://station.invalid/key\nsegment.ts\n",
		"#EXTM3U\n{$host}/segment.ts\n",
		"#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"/steering.json\"\n",
	} {
		base, _ := http.NewRequest(http.MethodGet, "http://station.invalid/base/list.m3u8", nil)
		if _, err := s.relay.rewritePlaylist([]byte(playlist), base.URL); err == nil {
			t.Fatal("unsupported playlist could escape the configured policy")
		}
	}
}

func TestDirectModeAndProxyFailure(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "direct audio") }))
	defer local.Close()
	s := session(t, "direct", "")
	if s.Transport.Proxy != nil {
		t.Fatal("direct transport still uses a proxy")
	}
	if code, body := readResponse(t, s.MediaURL(local.URL), nil); code != http.StatusOK || body != "direct audio" {
		t.Fatalf("direct media: %d, %s", code, body)
	}
	if got := session(t, "auto", "").MediaURL(local.URL); got != local.URL {
		t.Fatal("automatic mode changed native URL")
	}
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := closed.Addr().String()
	closed.Close()
	failing := session(t, "manual", "http://"+address)
	// The target is reachable directly. A proxy failure must not fall back.
	if code, _ := readResponse(t, failing.MediaURL(local.URL), nil); code != http.StatusBadGateway {
		t.Fatalf("failed proxy fell back to direct: %d", code)
	}
}

func TestManualHTTPSConnect(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "secure audio") }))
	defer target.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodConnect || req.Host != "example.com:443" {
			t.Errorf("unexpected CONNECT: %s %s", req.Method, req.Host)
			http.Error(w, "bad tunnel", 502)
			return
		}
		upstream, err := net.Dial("tcp", target.Listener.Addr().String())
		if err != nil {
			t.Error(err)
			return
		}
		defer upstream.Close()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go io.Copy(upstream, conn)
		io.Copy(conn, upstream)
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	roots := x509.NewCertPool()
	roots.AddCert(target.Certificate())
	// Only this synthetic certificate is trusted, without disabling TLS.
	s.relay.client.Transport.(*http.Transport).TLSClientConfig = target.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	s.relay.client.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = false
	s.relay.client.Transport.(*http.Transport).TLSClientConfig.RootCAs = roots
	if code, body := readResponse(t, s.MediaURL("https://example.com/audio"), nil); code != http.StatusOK || body != "secure audio" {
		t.Fatalf("CONNECT response: %d, %s", code, body)
	}
}

func TestManualSOCKS5UsesRemoteDNS(t *testing.T) {
	for _, scheme := range []string{"socks5", "socks5h"} {
		t.Run(scheme, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan error, 1)
			go func() {
				done <- func() error {
					conn, err := listener.Accept()
					if err != nil {
						return err
					}
					defer conn.Close()
					conn.SetDeadline(time.Now().Add(5 * time.Second))
					head := make([]byte, 2)
					if _, err := io.ReadFull(conn, head); err != nil {
						return err
					}
					if head[0] != 5 {
						return fmt.Errorf("not SOCKS5")
					}
					if _, err := io.ReadFull(conn, make([]byte, int(head[1]))); err != nil {
						return err
					}
					conn.Write([]byte{5, 0})
					request := make([]byte, 5)
					if _, err := io.ReadFull(conn, request); err != nil {
						return err
					}
					if request[0] != 5 || request[1] != 1 || request[3] != 3 {
						return fmt.Errorf("DNS was not delegated to SOCKS5")
					}
					host := make([]byte, int(request[4])+2)
					if _, err := io.ReadFull(conn, host); err != nil {
						return err
					}
					if string(host[:len(host)-2]) != "station.invalid" {
						return fmt.Errorf("incorrect remote host")
					}
					conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
					if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
						return err
					}
					_, err = fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nsocks audio")
					return err
				}()
			}()
			s := session(t, "manual", scheme+"://"+listener.Addr().String())
			if code, body := readResponse(t, s.MediaURL("http://station.invalid/audio"), nil); code != 200 || body != "socks audio" {
				t.Fatalf("SOCKS5 relay: %d %s", code, body)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
