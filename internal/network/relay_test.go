package network

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRelayPlaylistRangesUseRewrittenRepresentation(t *testing.T) {
	const playlist = "#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n"
	for _, target := range []string{"http://station.invalid/live.m3u8", "http://station.invalid/redirect"} {
		t.Run(target, func(t *testing.T) {
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path == "/redirect" {
					http.Redirect(w, req, "http://station.invalid/base/playlist", http.StatusFound)
					return
				}
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
				w.Header().Set("ETag", `"upstream"`)
				http.ServeContent(w, req, "playlist", time.Unix(1, 0), strings.NewReader(playlist))
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			raw := s.MediaURL(target)
			baseURL, _ := http.NewRequest(http.MethodGet, target, nil)
			if strings.HasSuffix(target, "/redirect") {
				baseURL, _ = http.NewRequest(http.MethodGet, "http://station.invalid/base/playlist", nil)
			}
			want, err := s.relay.rewritePlaylist([]byte(playlist), baseURL.URL)
			if err != nil {
				t.Fatal(err)
			}
			for _, tc := range []struct {
				rangeValue string
				start, end int
			}{
				{"bytes=0-1", 0, 2},
				{"bytes=24-50", 24, 51},
				{"bytes=-10", len(want) - 10, len(want)},
				{fmt.Sprintf("bytes=%d-", len(want)-5), len(want) - 5, len(want)},
			} {
				t.Run(tc.rangeValue, func(t *testing.T) {
					req := httptest.NewRequest(http.MethodGet, raw, nil)
					req.Header.Set("Range", tc.rangeValue)
					w := httptest.NewRecorder()
					s.relay.ServeHTTP(w, req)
					if w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), want[tc.start:tc.end]) {
						t.Fatalf("range response: %d %q; want 206 %q", w.Code, w.Body.Bytes(), want[tc.start:tc.end])
					}
					if got, expected := w.Header().Get("Content-Range"), fmt.Sprintf("bytes %d-%d/%d", tc.start, tc.end-1, len(want)); got != expected {
						t.Fatalf("Content-Range = %q; want %q", got, expected)
					}
					if w.Header().Get("Content-Length") != strconv.Itoa(tc.end-tc.start) {
						t.Fatal("incorrect range content length")
					}
					if w.Header().Get("Last-Modified") != "" || w.Header().Get("ETag") == `"upstream"` {
						t.Fatal("rewritten playlist retained upstream validators")
					}
				})
			}
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				req := httptest.NewRequest(method, raw, nil)
				w := httptest.NewRecorder()
				s.relay.ServeHTTP(w, req)
				if w.Code != http.StatusOK || w.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
					t.Fatalf("%s does not describe rewritten playlist: %d %v", method, w.Code, w.Header())
				}
				if method == http.MethodHead && w.Body.Len() != 0 {
					t.Fatal("HEAD returned a body")
				}
			}
			for _, validator := range []string{`"upstream"`, `"stale"`} {
				req := httptest.NewRequest(http.MethodGet, raw, nil)
				req.Header.Set("Range", "bytes=0-1")
				req.Header.Set("If-Range", validator)
				w := httptest.NewRecorder()
				s.relay.ServeHTTP(w, req)
				if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), want) {
					t.Fatal("If-Range for an upstream representation must return the complete rewritten playlist")
				}
			}
			full := httptest.NewRecorder()
			s.relay.ServeHTTP(full, httptest.NewRequest(http.MethodGet, raw, nil))
			matching := httptest.NewRequest(http.MethodGet, raw, nil)
			matching.Header.Set("Range", "bytes=0-1")
			matching.Header.Set("If-Range", full.Header().Get("ETag"))
			partial := httptest.NewRecorder()
			s.relay.ServeHTTP(partial, matching)
			if full.Header().Get("ETag") == "" || partial.Code != http.StatusPartialContent || partial.Body.String() != "#E" {
				t.Fatal("If-Range did not recognize the rewritten representation")
			}
			req := httptest.NewRequest(http.MethodGet, raw, nil)
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", len(want)))
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusRequestedRangeNotSatisfiable || w.Header().Get("Content-Range") != fmt.Sprintf("bytes */%d", len(want)) {
				t.Fatalf("unsatisfiable range: %d %v", w.Code, w.Header())
			}
			req.Header.Set("Range", "bytes=0-1,24-30")
			w = httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			_, params, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
			if w.Code != http.StatusPartialContent || err != nil || params["boundary"] == "" {
				t.Fatalf("multiple ranges: %d %v", w.Code, w.Header())
			}
			parts := multipart.NewReader(w.Body, params["boundary"])
			for _, expected := range [][]byte{want[:2], want[24:31]} {
				part, err := parts.NextPart()
				if err != nil {
					t.Fatal(err)
				}
				data, _ := io.ReadAll(part)
				if !bytes.Equal(data, expected) {
					t.Fatalf("multipart range = %q; want %q", data, expected)
				}
			}
		})
	}
}

func TestRelayPreservesBinaryRangeResponses(t *testing.T) {
	const data = "0123456789abcdef"
	var fullGETs atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Range") == "" {
			fullGETs.Add(1)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("ETag", `"binary"`)
		http.ServeContent(w, req, "segment", time.Time{}, strings.NewReader(data))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	for _, value := range []string{"bytes=2-3", "bytes=0-1,4-5", "bytes=1000-", "bytes=2-3"} {
		req := httptest.NewRequest(http.MethodGet, s.MediaURL("http://station.invalid/segment"), nil)
		req.Header.Set("Range", value)
		got := httptest.NewRecorder()
		s.relay.ServeHTTP(got, req)
		want := httptest.NewRecorder()
		wreq := httptest.NewRequest(http.MethodGet, "http://station.invalid/segment", nil)
		wreq.Header.Set("Range", value)
		proxy.Config.Handler.ServeHTTP(want, wreq)
		if got.Code != want.Code || got.Header().Get("Content-Range") != want.Header().Get("Content-Range") || got.Header().Get("ETag") != want.Header().Get("ETag") {
			t.Fatalf("binary range response changed: %d %v; want %d %v", got.Code, got.Header(), want.Code, want.Header())
		}
		if value == "bytes=0-1,4-5" {
			_, params, _ := mime.ParseMediaType(got.Header().Get("Content-Type"))
			parts := multipart.NewReader(got.Body, params["boundary"])
			for _, expected := range []string{"01", "45"} {
				part, err := parts.NextPart()
				if err != nil {
					t.Fatal(err)
				}
				content, _ := io.ReadAll(part)
				if string(content) != expected {
					t.Fatalf("binary range body changed: %q", content)
				}
			}
		} else if got.Body.String() != want.Body.String() {
			t.Fatal("binary range body changed")
		}
	}
	if fullGETs.Load() != 1 {
		t.Fatalf("binary classification was lost after multipart or 416: %d probes", fullGETs.Load())
	}
}

func TestRelayRejectsIncompletePlaylistProbe(t *testing.T) {
	for _, status := range []int{http.StatusPartialContent, http.StatusBadGateway} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var requests atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
				w.Header().Set("Content-Length", "2")
				if req.Header.Get("Range") != "" {
					w.Header().Set("Content-Range", "bytes 0-1/200")
					w.WriteHeader(http.StatusPartialContent)
				} else {
					w.WriteHeader(status)
				}
				fmt.Fprint(w, "#E")
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			req := httptest.NewRequest(http.MethodGet, s.MediaURL("http://station.invalid/playlist"), nil)
			req.Header.Set("Range", "bytes=0-1")
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusBadGateway || w.Header().Get("Content-Range") != "" || requests.Load() != 1 {
				t.Fatalf("partial playlist probe: %d %v, requests=%d", w.Code, w.Header(), requests.Load())
			}
		})
	}
}
