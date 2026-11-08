package network

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSniffedPlaylistKeepsOneRepresentation(t *testing.T) {
	const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n"
	for _, path := range []string{"/playlist", "/live.m3u", "/live.m3u8"} {
		for _, firstMethod := range []string{http.MethodGet, http.MethodHead, "range", "middle"} {
			t.Run(path+"/"+firstMethod, func(t *testing.T) {
				proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					w.Header().Set("Content-Type", "application/octet-stream")
					w.Header().Set("ETag", `"original"`)
					http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader(playlist))
				}))
				defer proxy.Close()
				s := session(t, "manual", proxy.URL)
				raw := s.MediaURL("http://station.invalid" + path)
				base := httptest.NewRequest(http.MethodGet, "http://station.invalid"+path, nil).URL
				want, err := s.relay.rewritePlaylist([]byte(playlist), base)
				if err != nil {
					t.Fatal(err)
				}
				for _, method := range []string{firstMethod, http.MethodGet, http.MethodHead, "range", "middle"} {
					httpMethod := method
					if method == "range" || method == "middle" {
						httpMethod = http.MethodGet
					}
					req := httptest.NewRequest(httpMethod, raw, nil)
					status, body := http.StatusOK, string(want)
					if method == "range" {
						req.Header.Set("Range", "bytes=0-1")
						status, body = 206, string(want[:2])
					}
					if method == "middle" {
						req.Header.Set("Range", "bytes=50-60")
						status, body = 206, string(want[50:61])
					}
					if method == http.MethodHead {
						body = ""
					}
					w := httptest.NewRecorder()
					s.relay.ServeHTTP(w, req)
					if w.Code != status || w.Body.String() != body || w.Header().Get("ETag") == `"original"` {
						t.Errorf("%s = %d, ETag=%s, body=%q; want %d %q", method, w.Code, w.Header().Get("ETag"), w.Body.String(), status, body)
					}
					if method == http.MethodHead && w.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
						t.Errorf("HEAD length = %s; rewritten length = %d", w.Header().Get("Content-Length"), len(want))
					}
				}
			})
		}
	}
}

func TestRelayReferenceContextDeterminesRepresentation(t *testing.T) {
	const playlist = "#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n"
	for _, tc := range []struct {
		name, reference string
		playlist        bool
	}{
		{"variant", "#EXT-X-STREAM-INF:BANDWIDTH=128000\nchild", true},
		{"audio", `#EXT-X-MEDIA:TYPE=AUDIO,URI="child"`, true},
		{"iframe", `#EXT-X-I-FRAME-STREAM-INF:URI="child"`, true},
		{"rendition", `#EXT-X-RENDITION-REPORT:URI="child"`, true},
		{"key", `#EXT-X-KEY:METHOD=AES-128,URI="child"`, false},
		{"session key", `#EXT-X-SESSION-KEY:METHOD=AES-128,URI="child"`, false},
		{"map", `#EXT-X-MAP:URI="child"`, false},
		{"part", `#EXT-X-PART:DURATION=1,URI="child"`, false},
		{"preload", `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="child"`, false},
		{"segment", "#EXTINF:6,\nchild", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if tc.playlist && (req.Method != http.MethodGet || req.Header.Get("Range") != "") {
					t.Error("child playlist was not fetched in full")
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("ETag", `"original"`)
				// Keys and segments are binary even if their bytes happen to
				// look exactly like an HLS playlist.
				http.ServeContent(w, req, "child", time.Time{}, strings.NewReader(playlist))
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			base := httptest.NewRequest(http.MethodGet, "http://station.invalid/master.m3u8", nil).URL
			master, err := s.relay.rewritePlaylist([]byte("#EXTM3U\n"+tc.reference+"\n"), base)
			if err != nil {
				t.Fatal(err)
			}
			var raw string
			for _, line := range strings.Split(string(master), "\n") {
				if strings.HasPrefix(line, "http:") {
					raw = line
				}
				if attr := playlistURI.FindStringSubmatch(line); attr != nil {
					raw = attr[1]
				}
			}
			want := playlist
			if tc.playlist {
				child := base.ResolveReference(httptest.NewRequest(http.MethodGet, "/child", nil).URL)
				data, err := s.relay.rewritePlaylist([]byte(playlist), child)
				if err != nil {
					t.Fatal(err)
				}
				want = string(data)
			}
			// HEAD must describe the right bytes even before any GET.
			for _, method := range []string{http.MethodHead, http.MethodGet, "range"} {
				httpMethod := method
				if method == "range" {
					httpMethod = http.MethodGet
				}
				req := httptest.NewRequest(httpMethod, raw, nil)
				expectedBody, status := want, http.StatusOK
				if method == http.MethodHead {
					expectedBody = ""
				} else if method == "range" {
					req.Header.Set("Range", "bytes=10-20")
					expectedBody, status = want[10:21], http.StatusPartialContent
				}
				w := httptest.NewRecorder()
				s.relay.ServeHTTP(w, req)
				if w.Code != status || w.Body.String() != expectedBody {
					t.Fatalf("%s = %d %q; want %d %q", method, w.Code, w.Body.String(), status, expectedBody)
				}
				if !tc.playlist && w.Header().Get("ETag") != `"original"` {
					t.Fatal("binary validator changed")
				}
				if method == http.MethodHead && w.Header().Get("Content-Length") != strconv.Itoa(len(want)) {
					t.Fatal("HEAD describes a different representation")
				}
			}
		})
	}
}

func TestBinaryRangeHeadersDoNotWaitForBody(t *testing.T) {
	for _, learned := range []bool{false, true} {
		t.Run(fmt.Sprintf("learned=%t", learned), func(t *testing.T) {
			var fullGETs atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Header.Get("Range") == "" {
					fullGETs.Add(1)
					w.Header().Set("Content-Type", "application/octet-stream")
					fmt.Fprint(w, "0123456789abcdef")
					return
				}
				w.Header().Set("Content-Type", "multipart/byteranges; boundary=sample")
				w.WriteHeader(http.StatusPartialContent)
				w.(http.Flusher).Flush()
				<-req.Context().Done()
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			raw := s.ResourceURL("http://station.invalid/binary")
			if learned {
				raw = s.MediaURL("http://station.invalid/binary")
				readResponse(t, raw, nil)
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
			req.Header.Set("Range", "bytes=0-1,4-5")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("binary range headers waited for a body or probe: %v", err)
			}
			resp.Body.Close()
			wantGETs := int32(0)
			if learned {
				wantGETs = 1
			}
			if resp.StatusCode != http.StatusPartialContent || fullGETs.Load() != wantGETs {
				t.Fatalf("status=%d, full GETs=%d; want 206 and %d", resp.StatusCode, fullGETs.Load(), wantGETs)
			}
		})
	}
}

func TestUnknownProbeTimeoutCanRecover(t *testing.T) {
	for _, stallBody := range []bool{false, true} {
		t.Run(fmt.Sprintf("body=%t", stallBody), func(t *testing.T) {
			var requests atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Method != http.MethodGet || req.Header.Get("Range") != "" {
					t.Error("unknown resource probe did not start at byte zero")
				}
				w.Header().Set("Content-Type", "application/octet-stream")
				if requests.Add(1) == 1 {
					if stallBody {
						fmt.Fprint(w, "#E")
						w.(http.Flusher).Flush()
					}
					<-req.Context().Done()
					return
				}
				fmt.Fprint(w, "#EXTM3U\n#EXTINF:6,\nsegment.ts\n")
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			s.relay.probeTimeout = 100 * time.Millisecond
			raw := s.MediaURL("http://station.invalid/unknown")
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			req := httptest.NewRequest(http.MethodGet, raw, nil).WithContext(ctx)
			req.Header.Set("Range", "bytes=20-21")
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusGatewayTimeout || ctx.Err() != nil {
				t.Fatalf("probe was not independently bounded: %d, %v", w.Code, ctx.Err())
			}
			status, body := readResponse(t, raw, http.Header{"Range": {"bytes=0-1"}})
			if status != http.StatusPartialContent || body != "#E" {
				t.Fatalf("failed probe poisoned later classification: %d %q", status, body)
			}
		})
	}
}

func TestUnknownBinaryConcurrentRangesShareClassification(t *testing.T) {
	var fullGETs atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Range") == "" {
			fullGETs.Add(1)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, req, "binary", time.Time{}, strings.NewReader("0123456789abcdef"))
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.MediaURL("http://station.invalid/binary")
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			<-start
			req := httptest.NewRequest(http.MethodGet, raw, nil)
			req.Header.Set("Range", "bytes=2-3")
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusPartialContent || w.Body.String() != "23" {
				t.Errorf("concurrent range: %d %q", w.Code, w.Body.String())
			}
		})
	}
	close(start)
	wg.Wait()
	if fullGETs.Load() != 1 {
		t.Fatalf("classification GETs = %d; want 1", fullGETs.Load())
	}
}

func TestRelayResourceTypeCannotBeTampered(t *testing.T) {
	s := session(t, "direct", "")
	raw := s.MediaURL("http://station.invalid/live.m3u8")
	for _, name := range []string{"media", "resource", "invalid"} {
		w := httptest.NewRecorder()
		s.relay.ServeHTTP(w, httptest.NewRequest(http.MethodGet, strings.TrimSuffix(raw, "playlist.m3u8")+name, nil))
		if w.Code != http.StatusForbidden {
			t.Fatalf("type tampering = %d; want 403", w.Code)
		}
	}
}

func TestProbeDeadlineDoesNotLimitIdentifiedStream(t *testing.T) {
	release := make(chan struct{}, 1)
	defer close(release)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fmt.Fprint(w, "01234567")
		w.(http.Flusher).Flush()
		select {
		case <-release:
			fmt.Fprint(w, "89")
		case <-req.Context().Done():
		}
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	s.relay.probeTimeout = 50 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.MediaURL("http://station.invalid/stream"), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadFull(resp.Body, make([]byte, 8)); err != nil {
		t.Fatal(err)
	}
	// The probe deadline has passed, but an identified stream stays open.
	select {
	case <-time.After(3 * s.relay.probeTimeout):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	release <- struct{}{}
	if tail, err := io.ReadAll(resp.Body); err != nil || string(tail) != "89" {
		t.Fatalf("identified stream was cut off: %q, %v", tail, err)
	}
}

func TestBinaryPlaylistResourceNeedsNoExtraGET(t *testing.T) {
	for _, status := range []int{http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var fullGETs atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path == "/live.m3u8" {
					w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
					fmt.Fprint(w, "#EXTM3U\n#EXTINF:6,\nbinary\n#EXT-X-ENDLIST\n")
					return
				}
				if req.Header.Get("Range") == "" {
					fullGETs.Add(1)
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				w.Header().Set("ETag", `"binary"`)
				if status == 206 {
					w.Header().Set("Content-Type", "multipart/byteranges; boundary=sample")
				} else {
					w.Header().Set("Content-Range", "bytes */100")
				}
				w.WriteHeader(status)
				fmt.Fprint(w, "original response")
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			_, playlist := readResponse(t, s.MediaURL("http://station.invalid/live.m3u8"), nil)
			binary := strings.Split(playlist, "\n")[2]
			got, body := readResponse(t, binary, http.Header{"Range": {"bytes=0-1,4-5"}})
			if got != status || body != "original response" || fullGETs.Load() != 0 {
				t.Fatalf("binary response = %d %q, extra GETs=%d; want %d with no extra GET", got, body, fullGETs.Load(), status)
			}
		})
	}
}
