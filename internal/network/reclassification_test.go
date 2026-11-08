package network

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const recoveredPlaylist = "#EXTM3U\n#EXTINF:6,\nhttp://media.invalid/segment.ts\n#EXT-X-ENDLIST\n"

func checkRecoveredPlaylist(t *testing.T, s *Session, raw, method string, want []byte) {
	t.Helper()
	httpMethod := method
	status, body := http.StatusOK, string(want)
	if method == "range" {
		httpMethod, status, body = http.MethodGet, http.StatusPartialContent, string(want[32:44])
	} else if method == http.MethodHead {
		body = ""
	}
	req := httptest.NewRequest(httpMethod, raw, nil)
	if method == "range" {
		req.Header.Set("Range", "bytes=32-43")
	}
	w := httptest.NewRecorder()
	s.relay.ServeHTTP(w, req)
	if w.Code != status || w.Body.String() != body {
		t.Fatalf("recovered %s = %d %q; want %d %q", method, w.Code, w.Body.String(), status, body)
	}
	if w.Header().Get("ETag") == "" || w.Header().Get("ETag") == `"upstream"` {
		t.Fatalf("recovered %s retained an upstream validator: %v", method, w.Header())
	}
	if method == http.MethodHead && w.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
		t.Fatalf("recovered HEAD length = %s; want %d", w.Header().Get("Content-Length"), len(want))
	}
	if method == "range" && w.Header().Get("Content-Range") != fmt.Sprintf("bytes 32-43/%d", len(want)) {
		t.Fatalf("recovered Range described the original content: %v", w.Header())
	}
}

func TestUnknownEntryRecoversFromNonMediaSuccess(t *testing.T) {
	for _, errorType := range []string{"text/html", "application/xhtml+xml", "application/json", "application/problem+json", "text/plain", "application/xml"} {
		for _, recoveryType := range []string{"application/vnd.apple.mpegurl", "application/octet-stream"} {
			for _, firstRecoveredMethod := range []string{http.MethodGet, http.MethodHead, "range"} {
				t.Run(errorType+"/"+recoveryType+"/"+firstRecoveredMethod, func(t *testing.T) {
					var requests atomic.Int32
					proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
						w.Header().Set("ETag", `"upstream"`)
						if requests.Add(1) == 1 {
							w.Header().Set("Content-Type", errorType)
							fmt.Fprint(w, "temporary upstream error")
							return
						}
						w.Header().Set("Content-Type", recoveryType)
						http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(recoveredPlaylist))
					}))
					defer proxy.Close()
					s := session(t, "manual", proxy.URL)
					target := "http://station.invalid/live"
					raw := s.MediaURL(target)
					if status, body := readResponse(t, raw, nil); status != http.StatusOK || body != "temporary upstream error" {
						t.Fatalf("temporary error response = %d %q", status, body)
					}
					want, err := s.relay.rewritePlaylist([]byte(recoveredPlaylist), httptest.NewRequest(http.MethodGet, target, nil).URL)
					if err != nil {
						t.Fatal(err)
					}
					for _, method := range []string{firstRecoveredMethod, http.MethodGet, http.MethodHead, "range"} {
						checkRecoveredPlaylist(t, s, raw, method, want)
					}
				})
			}
		}
	}
}

func TestDetectedBinaryEntryPromotesExplicitHLSResponse(t *testing.T) {
	for _, redirect := range []bool{false, true} {
		for _, method := range []string{http.MethodGet, http.MethodHead, "range"} {
			t.Run(fmt.Sprintf("redirect=%t/%s", redirect, method), func(t *testing.T) {
				var ready atomic.Bool
				var requests atomic.Int32
				proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					requests.Add(1)
					w.Header().Set("ETag", `"upstream"`)
					if !ready.Load() {
						w.Header().Set("Content-Type", "audio/mpeg")
						fmt.Fprint(w, "binary audio bytes")
						return
					}
					if redirect && req.URL.Path == "/live" {
						http.Redirect(w, req, "http://station.invalid/recovered.m3u8", http.StatusFound)
						return
					}
					if redirect {
						w.Header().Set("Content-Type", "application/octet-stream")
					} else {
						w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
					}
					http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(recoveredPlaylist))
				}))
				defer proxy.Close()
				s := session(t, "manual", proxy.URL)
				target := "http://station.invalid/live"
				raw := s.MediaURL(target)
				readResponse(t, raw, nil)
				ready.Store(true)
				if redirect {
					target = "http://station.invalid/recovered.m3u8"
				}
				want, err := s.relay.rewritePlaylist([]byte(recoveredPlaylist), httptest.NewRequest(http.MethodGet, target, nil).URL)
				if err != nil {
					t.Fatal(err)
				}
				checkRecoveredPlaylist(t, s, raw, method, want)
				// Remember the promotion: subsequent requests must request a
				// complete playlist before applying the local range.
				before := requests.Load()
				checkRecoveredPlaylist(t, s, raw, "range", want)
				wantRequests := int32(1)
				if redirect {
					wantRequests = 2
				}
				if requests.Load()-before != wantRequests {
					t.Fatalf("playlist promotion was not retained: %d requests; want %d", requests.Load()-before, wantRequests)
				}
			})
		}
	}
}

func TestDetectedBinaryConcurrentHLSPromotion(t *testing.T) {
	var ready atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !ready.Load() {
			w.Header().Set("Content-Type", "application/octet-stream")
			fmt.Fprint(w, "binary media bytes")
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(recoveredPlaylist))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	target := "http://station.invalid/live"
	raw := s.MediaURL(target)
	readResponse(t, raw, nil)
	ready.Store(true)
	want, err := s.relay.rewritePlaylist([]byte(recoveredPlaylist), httptest.NewRequest(http.MethodGet, target, nil).URL)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			<-start
			req := httptest.NewRequest(http.MethodGet, raw, nil)
			req.Header.Set("Range", "bytes=32-43")
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusPartialContent || w.Body.String() != string(want[32:44]) {
				t.Errorf("concurrent promotion returned original content: %d %q", w.Code, w.Body.String())
			}
		})
	}
	close(start)
	wg.Wait()
	checkRecoveredPlaylist(t, s, raw, http.MethodHead, want)
}

func TestHLSPromotionRefetchFailureCanRecover(t *testing.T) {
	var requests atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if requests.Add(1) == 1 {
			w.Header().Set("Content-Type", "audio/mpeg")
			fmt.Fprint(w, "binary media bytes")
			return
		}
		if fail.Load() && req.Header.Get("Range") == "" {
			// Also fail transport retries on a reused idle connection.
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(recoveredPlaylist))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	target := "http://station.invalid/live"
	raw := s.MediaURL(target)
	readResponse(t, raw, nil)
	status, body := readResponse(t, raw, http.Header{"Range": {"bytes=32-43"}})
	if status != http.StatusBadGateway || strings.Contains(body, "media.invalid") {
		t.Fatalf("failed full fetch exposed an upstream playlist: %d %q", status, body)
	}
	fail.Store(false)
	want, err := s.relay.rewritePlaylist([]byte(recoveredPlaylist), httptest.NewRequest(http.MethodGet, target, nil).URL)
	if err != nil {
		t.Fatal(err)
	}
	checkRecoveredPlaylist(t, s, raw, "range", want)
}

func TestExplicitBinaryIgnoresHLSResponseHints(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("ETag", `"upstream"`)
		http.ServeContent(w, req, "key", time.Time{}, strings.NewReader(recoveredPlaylist))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.ResourceURL("http://station.invalid/key.m3u8")
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		w := httptest.NewRecorder()
		s.relay.ServeHTTP(w, httptest.NewRequest(method, raw, nil))
		wantBody := recoveredPlaylist
		if method == http.MethodHead {
			wantBody = ""
		}
		if w.Code != http.StatusOK || w.Body.String() != wantBody || w.Header().Get("ETag") != `"upstream"` {
			t.Fatalf("explicit binary type changed: %d %v %q", w.Code, w.Header(), w.Body.String())
		}
	}
}
