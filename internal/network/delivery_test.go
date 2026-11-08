package network

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRelayForwardsHLSDeliveryDirectives(t *testing.T) {
	const auth = "token=a%2fb+c&token=second&signature=example%2B%3D"
	for _, query := range []string{"_HLS_msn=273&_HLS_part=3&_HLS_skip=YES", "_HLS_msn=0&_HLS_part=0&_HLS_skip=v2", "_HLS_skip=YES"} {
		t.Run(query, func(t *testing.T) {
			seen := make(chan string, 4)
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				seen <- req.URL.RawQuery
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
				http.ServeContent(w, req, "playlist", time.Time{}, strings.NewReader("#EXTM3U\n#EXTINF:1,\nsegment.ts\n"))
			}))
			defer proxy.Close()
			s := session(t, "manual", proxy.URL)
			raw := s.MediaURL("http://station.invalid/playlist?" + auth + "&_HLS_msn=1&_HLS_skip=v2")
			req := httptest.NewRequest(http.MethodGet, raw+"?"+query, nil)
			req.Header.Set("Range", "bytes=0-1")
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, req)
			if w.Code != http.StatusPartialContent || w.Body.String() != "#E" {
				t.Fatalf("delivery request failed: %d %s", w.Code, w.Body.String())
			}
			// The complete playlist probe preserves the directives without
			// re-encoding authentication parameters.
			select {
			case got := <-seen:
				if !strings.HasPrefix(got, auth+"&") {
					t.Fatalf("authentication query was changed: %s", got)
				}
				upstream := httptest.NewRequest(http.MethodGet, "http://station.invalid/?"+got, nil).URL.Query()
				incoming := req.URL.Query()
				for key, values := range incoming {
					if len(upstream[key]) != 1 || upstream.Get(key) != values[0] {
						t.Fatalf("directive %s = %v; want %v", key, upstream[key], values)
					}
				}
				if incoming.Get("_HLS_msn") == "" && upstream.Get("_HLS_msn") != "1" {
					t.Fatal("an untouched original directive was lost")
				}
			default:
				t.Fatal("upstream did not receive the playlist request")
			}
		})
	}
}

func TestRelayRejectsInvalidDeliveryDirectives(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		t.Error("invalid delivery directives reached upstream")
		fmt.Fprint(w, "#EXTM3U\n")
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	raw := s.MediaURL("http://station.invalid/live.m3u8?token=example")
	for _, query := range []string{
		"_HLS_msn=-1", "_HLS_msn=", "_HLS_msn=abc", "_HLS_msn=18446744073709551616",
		"_HLS_msn=1&_HLS_msn=2", "_HLS_part=0", "_HLS_msn=1&_HLS_part=-1",
		"_HLS_skip=NO", "_HLS_skip=yes", "_HLS_skip=YES&_HLS_skip=v2", "_HLS_skip=%ff",
		"token=replacement", "url=http://untrusted.invalid/", "_HLS_extra=1", "_HLS_msn=%ZZ",
	} {
		t.Run(query, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.relay.ServeHTTP(w, httptest.NewRequest(http.MethodGet, raw+"?"+query, nil))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("invalid query accepted: %d", w.Code)
			}
		})
	}
}

func TestRelayPartCanUseOriginalMediaSequence(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Query().Get("_HLS_msn") != "12" || req.URL.Query().Get("_HLS_part") != "0" {
			t.Errorf("combined directives: %s", req.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		fmt.Fprint(w, "#EXTM3U\n")
	}))
	defer proxy.Close()
	s := session(t, "manual", proxy.URL)
	code, _ := readResponse(t, s.MediaURL("http://station.invalid/live.m3u8?_HLS_msn=12")+"?_HLS_part=0", nil)
	if code != http.StatusOK {
		t.Fatalf("valid combined directives rejected: %d", code)
	}
}
