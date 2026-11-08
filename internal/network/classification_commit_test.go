package network

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const ordinaryAudio = "0123456789abcdef"

func serveOrdinaryAudio(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("ETag", `"audio"`)
	http.ServeContent(w, req, "audio", time.Time{}, strings.NewReader(ordinaryAudio))
}

func checkOrdinaryAudio(t *testing.T, s *Session, raw string) {
	t.Helper()
	for _, method := range []string{http.MethodGet, http.MethodHead, "range"} {
		httpMethod, status, body := method, http.StatusOK, ordinaryAudio
		if method == "range" {
			httpMethod, status, body = http.MethodGet, http.StatusPartialContent, ordinaryAudio[2:4]
		} else if method == http.MethodHead {
			body = ""
		}
		req := httptest.NewRequest(httpMethod, raw, nil)
		if method == "range" {
			req.Header.Set("Range", "bytes=2-3")
		}
		w := httptest.NewRecorder()
		s.relay.ServeHTTP(w, req)
		if w.Code != status || w.Body.String() != body || w.Header().Get("ETag") != `"audio"` {
			t.Fatalf("audio %s after failed classification = %d %v %q; want %d %q", method, w.Code, w.Header(), w.Body.String(), status, body)
		}
		if method == http.MethodHead && w.Header().Get("Content-Length") != strconv.Itoa(len(ordinaryAudio)) {
			t.Fatal("recovered audio HEAD has a playlist length")
		}
	}
}

func TestFailedPlaylistClassificationRecoversAsAudio(t *testing.T) {
	for _, seed := range []string{"unknown", "binary", "playlist"} {
		for _, method := range []string{http.MethodGet, http.MethodHead, "range"} {
			for _, failure := range []string{"503", "204", "206", "body", "truncated", "oversize", "reference", "header", "encoding", "control", "newline"} {
				t.Run(seed+"/"+method+"/"+failure, func(t *testing.T) {
					var phase atomic.Int32
					proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
						if phase.Load() == 2 || phase.Load() == 0 && seed == "binary" {
							serveOrdinaryAudio(w, req)
							return
						}
						w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
						if phase.Load() == 0 {
							fmt.Fprint(w, recoveredPlaylist)
							return
						}
						switch failure {
						case "503", "204", "206":
							status, _ := strconv.Atoi(failure)
							w.WriteHeader(status)
						case "body":
							fmt.Fprint(w, "temporary upstream error")
						case "truncated":
							w.Header().Set("Content-Length", "1000")
							fmt.Fprint(w, "#EXTM3U\n")
						case "oversize":
							fmt.Fprint(w, "#EXTM3U\n"+strings.Repeat("#comment\n", 300000))
						case "reference":
							fmt.Fprint(w, "#EXTM3U\n#EXT-X-KEY:URI=\"skd://example.invalid/key\"\n")
						case "header":
							fmt.Fprint(w, "#EXTM3Ugarbage\n")
						case "encoding":
							fmt.Fprint(w, "#EXTM3U\n#comment\xff\n")
						case "control":
							fmt.Fprint(w, "#EXTM3U\n#comment\x00\n")
						case "newline":
							fmt.Fprint(w, "#EXTM3U\r")
						}
					}))
					defer proxy.Close()
					s := session(t, "manual", proxy.URL)
					raw := s.MediaURL("http://station.invalid/entry")
					if seed != "unknown" {
						readResponse(t, raw, nil)
					}
					phase.Store(1)
					httpMethod := method
					if method == "range" {
						httpMethod = http.MethodGet
					}
					req := httptest.NewRequest(httpMethod, raw, nil)
					if method == "range" {
						req.Header.Set("Range", "bytes=2-3")
					}
					w := httptest.NewRecorder()
					s.relay.ServeHTTP(w, req)
					wantStatus := http.StatusBadGateway
					if failure == "503" {
						wantStatus = http.StatusServiceUnavailable
					} else if seed == "unknown" && failure == "204" {
						wantStatus = http.StatusNoContent
					}
					if w.Code != wantStatus {
						t.Fatalf("invalid playlist response = %d; want %d", w.Code, wantStatus)
					}
					phase.Store(2)
					checkOrdinaryAudio(t, s, raw)
				})
			}
		}
	}
}

func TestCancelledPlaylistCandidatePreservesNewerAudio(t *testing.T) {
	started := make(chan struct{})
	var rejectFullGET atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Accept") == "application/x-test-slow" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprint(w, "#EXTM3U\n")
			w.(http.Flusher).Flush()
			close(started)
			<-req.Context().Done()
			return
		}
		if rejectFullGET.Load() && req.Method == http.MethodGet && req.Header.Get("Range") == "" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		serveOrdinaryAudio(w, req)
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.MediaURL("http://station.invalid/entry")
	readResponse(t, raw, nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, raw, nil).WithContext(ctx)
	req.Header.Set("Accept", "application/x-test-slow")
	done := make(chan struct{})
	w := httptest.NewRecorder()
	go func() { s.relay.ServeHTTP(w, req); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("playlist candidate did not start")
	}
	// A candidate with an incomplete body must neither pin the type nor
	// keep the cache locked while another request receives normal audio.
	checkOrdinaryAudio(t, s, raw)
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled playlist read did not finish")
	}
	if w.Code != http.StatusBadGateway {
		t.Fatalf("cancelled playlist read = %d; want 502", w.Code)
	}
	// The older cancellation must not clear the newer binary result and
	// force a speculative GET before an otherwise successful range.
	rejectFullGET.Store(true)
	if status, body := readResponse(t, raw, http.Header{"Range": {"bytes=2-3"}}); status != http.StatusPartialContent || body != "23" {
		t.Fatalf("older cancellation replaced newer classification: %d %q", status, body)
	}
}

func TestOlderPlaylistSuccessCannotOverwriteNewerFailure(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{}, 1)
	var failed atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Accept") == "application/x-test-slow" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprint(w, recoveredPlaylist)
			w.(http.Flusher).Flush()
			close(started)
			select {
			case <-release:
			case <-req.Context().Done():
			}
			return
		}
		if failed.Load() {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		serveOrdinaryAudio(w, req)
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.MediaURL("http://station.invalid/entry")
	readResponse(t, raw, nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, raw, nil).WithContext(ctx)
	req.Header.Set("Accept", "application/x-test-slow")
	done := make(chan struct{})
	w := httptest.NewRecorder()
	go func() { s.relay.ServeHTTP(w, req); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("playlist candidate did not start")
	}
	failed.Store(true)
	if status, _ := readResponse(t, raw, nil); status != http.StatusServiceUnavailable {
		t.Fatalf("newer error = %d; want 503", status)
	}
	release <- struct{}{}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("older valid playlist did not finish")
	}
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "media.invalid") {
		t.Fatal("older request did not serve its own rewritten playlist")
	}
	failed.Store(false)
	checkOrdinaryAudio(t, s, raw)
}

func TestPlaylistRefetchFailureRecoversAsAudio(t *testing.T) {
	for _, method := range []string{http.MethodHead, "range"} {
		for _, failure := range []string{"503", "body", "disconnect"} {
			t.Run(method+"/"+failure, func(t *testing.T) {
				var phase atomic.Int32
				proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					if phase.Load() != 1 {
						serveOrdinaryAudio(w, req)
						return
					}
					w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
					if req.Method == http.MethodHead || req.Header.Get("Range") != "" {
						w.WriteHeader(http.StatusPartialContent)
						fmt.Fprint(w, "#E")
						return
					}
					switch failure {
					case "503":
						w.WriteHeader(http.StatusServiceUnavailable)
					case "body":
						fmt.Fprint(w, "temporary upstream error")
					case "disconnect":
						conn, _, _ := w.(http.Hijacker).Hijack()
						conn.Close()
					}
				}))
				defer proxy.Close()
				s := session(t, "manual", proxy.URL)
				raw := s.MediaURL("http://station.invalid/entry")
				readResponse(t, raw, nil)
				phase.Store(1)
				httpMethod := method
				if method == "range" {
					httpMethod = http.MethodGet
				}
				req := httptest.NewRequest(httpMethod, raw, nil)
				if method == "range" {
					req.Header.Set("Range", "bytes=0-1")
				}
				w := httptest.NewRecorder()
				s.relay.ServeHTTP(w, req)
				if w.Code < 400 {
					t.Fatalf("failed refetch returned success: %d", w.Code)
				}
				phase.Store(2)
				checkOrdinaryAudio(t, s, raw)
			})
		}
	}
}

func TestNonMediaProbeCannotEstablishBinaryThroughRange(t *testing.T) {
	var ready atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !ready.Load() {
			w.Header().Set("Content-Type", "text/html")
			http.ServeContent(w, req, "error", time.Time{}, strings.NewReader("temporary upstream error"))
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(recoveredPlaylist))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	target := "http://station.invalid/entry"
	raw := s.MediaURL(target)
	if status, _ := readResponse(t, raw, http.Header{"Range": {"bytes=2-3"}}); status != http.StatusPartialContent {
		t.Fatalf("non-media range = %d; want 206", status)
	}
	ready.Store(true)
	want, err := s.relay.rewritePlaylist([]byte(recoveredPlaylist), httptest.NewRequest(http.MethodGet, target, nil).URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodHead, http.MethodGet, "range"} {
		checkRecoveredPlaylist(t, s, raw, method, want)
	}
}

func TestValidPlaylistTextKeepsUnicodeAndCRLF(t *testing.T) {
	playlist := "#EXTM3U\r\n# 电台 🎵\r\n#EXTINF:6,\r\nsegment.ts\r\n#EXT-X-ENDLIST\r\n"
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		fmt.Fprint(w, playlist)
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	target := "http://station.invalid/entry"
	want, err := s.relay.rewritePlaylist([]byte(playlist), httptest.NewRequest(http.MethodGet, target, nil).URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodHead, http.MethodGet, "range"} {
		checkRecoveredPlaylist(t, s, s.MediaURL(target), method, want)
	}
}
