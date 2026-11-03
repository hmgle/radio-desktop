package icy

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func metaBlock(title string) []byte {
	raw := []byte("StreamTitle='" + title + "';\x00")
	padded := (len(raw) + 15) / 16 * 16
	block := make([]byte, padded)
	copy(block, raw)
	return append([]byte{byte(padded / 16)}, block...)
}

func metaBlockWithArt(title, artwork string) []byte {
	raw := []byte("StreamTitle='" + title + "';StreamArtwork='" + artwork + "';\x00")
	padded := (len(raw) + 15) / 16 * 16
	block := make([]byte, padded)
	copy(block, raw)
	return append([]byte{byte(padded / 16)}, block...)
}

func TestParseBlock(t *testing.T) {
	cases := []struct {
		name  string
		block []byte
		want  map[string]string
	}{
		{"plain", []byte("StreamTitle='Song One';"), map[string]string{"StreamTitle": "Song One"}},
		{"escaped quote", []byte("StreamTitle='Don''t Stop';"), map[string]string{"StreamTitle": "Don't Stop"}},
		{"double quoted", []byte(`StreamTitle="Song Two";`), map[string]string{"StreamTitle": "Song Two"}},
		{"multiple keys", []byte("StreamUrl='x';StreamTitle='Later';StreamArtwork='https://a/c.jpg';"),
			map[string]string{"StreamUrl": "x", "StreamTitle": "Later", "StreamArtwork": "https://a/c.jpg"}},
		{"live365 sample", []byte("StreamTitle='Hardpack - KB Song';StreamUrl='https://broadcaster.live365.com/static/assets/img/blankart.jpg';StreamArtwork='';"),
			map[string]string{"StreamTitle": "Hardpack - KB Song", "StreamUrl": "https://broadcaster.live365.com/static/assets/img/blankart.jpg", "StreamArtwork": ""}},
		{"control chars", []byte("StreamTitle='Bad\x01Title\x00';"), map[string]string{"StreamTitle": "BadTitle"}},
		{"missing", []byte("StreamUrl='x';"), map[string]string{"StreamUrl": "x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseBlock(tc.block)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Fatalf("key %s: got %q, want %q", k, got[k], v)
				}
			}
		})
	}
}

func TestPickArtwork(t *testing.T) {
	cases := []struct {
		name    string
		attrs   map[string]string
		want    string
		present bool
	}{
		{"stream artwork", map[string]string{"StreamArtwork": "https://cdn/live365/cover.jpg"}, "https://cdn/live365/cover.jpg", true},
		{"artwork placeholder", map[string]string{"StreamArtwork": "https://broadcaster.live365.com/static/assets/img/blankart.jpg"}, "", true},
		{"artwork not url", map[string]string{"StreamArtwork": "not-a-url"}, "", true},
		{"stream url image", map[string]string{"StreamUrl": "https://x/cover.png"}, "https://x/cover.png", true},
		{"stream url homepage", map[string]string{"StreamUrl": "https://example.com/"}, "", false},
		{"nil attrs", nil, "", false},
		{"empty attrs", map[string]string{"StreamTitle": "t"}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, present := pickArtwork(tc.attrs)
			if got != tc.want || present != tc.present {
				t.Fatalf("got (%q,%v), want (%q,%v)", got, present, tc.want, tc.present)
			}
		})
	}
}

func TestHeaderArtwork(t *testing.T) {
	if got := headerArtwork("https://cdn/cover.jpg"); got != "https://cdn/cover.jpg" {
		t.Fatalf("got %q", got)
	}
	if got := headerArtwork("ftp://x/y.jpg"); got != "" {
		t.Fatalf("non-http accepted: %q", got)
	}
}

// icyStream serves audio chunks interleaved with ICY metadata blocks.
func icyStream(t *testing.T, titles []string, sendMetaInt bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Icy-MetaData") != "1" {
			t.Errorf("Icy-MetaData header missing")
		}
		h := w.Header()
		if sendMetaInt {
			h.Set("icy-metaint", "8")
		}
		h.Set("icy-name", "Test FM")
		h.Set("icy-genre", "jazz")
		w.WriteHeader(http.StatusOK)

		audio := []byte("12345678")
		for _, title := range titles {
			if _, err := w.Write(audio); err != nil {
				return
			}
			if _, err := w.Write(metaBlock(title)); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
		// Keep the connection open a little, then close: the sidecar
		// should reconnect and see the first title again.
		time.Sleep(200 * time.Millisecond)
	}))
}

func TestSidecarParsesTitles(t *testing.T) {
	srv := icyStream(t, []string{"Song One", "Song Two"}, true)
	defer srv.Close()

	var mu sync.Mutex
	var metas []Meta
	s := Start(srv.URL, "radio-desktop-test", func(m Meta) {
		mu.Lock()
		metas = append(metas, m)
		mu.Unlock()
	})

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(metas) >= 2 && metas[1].Title == "Song Two"
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.Stop()

	mu.Lock()
	defer mu.Unlock()
	if len(metas) < 2 {
		t.Fatalf("metas = %+v", metas)
	}
	first := metas[0]
	if first.Name != "Test FM" || first.Genre != "jazz" || first.Title != "Song One" {
		t.Fatalf("first meta = %+v", first)
	}
	if metas[1].Title != "Song Two" {
		t.Fatalf("second meta = %+v", metas[1])
	}
}

func TestSidecarWithoutMetaIntPushesHeadersOnly(t *testing.T) {
	srv := icyStream(t, []string{"Ignored"}, false)
	defer srv.Close()

	var mu sync.Mutex
	var metas []Meta
	s := Start(srv.URL, "radio-desktop-test", func(m Meta) {
		mu.Lock()
		metas = append(metas, m)
		mu.Unlock()
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(metas) > 0
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // give a would-be title parse time to (not) happen
	s.Stop()

	mu.Lock()
	defer mu.Unlock()
	if len(metas) != 1 || metas[0].Name != "Test FM" || metas[0].Title != "" {
		t.Fatalf("metas = %+v, want single header-only push", metas)
	}
}

func TestSidecarStopIsFastAndIdempotent(t *testing.T) {
	srv := icyStream(t, []string{"Song One"}, true)
	defer srv.Close()
	s := Start(srv.URL, "radio-desktop-test", func(Meta) {})
	s.Stop()
	s.Stop() // must not deadlock
}

func TestSidecarStopInterruptsBackoff(t *testing.T) {
	requests := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	s := Start(srv.URL, "test", func(Meta) {})
	<-requests
	time.Sleep(50 * time.Millisecond)
	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Stop did not interrupt reconnect backoff")
	}
}

func TestCleanTitleTrims(t *testing.T) {
	if got := cleanTitle([]byte("  \tHi\n\x00there  ")); got != "Hithere" {
		t.Fatalf("cleanTitle = %q", got)
	}
	if got := cleanTitle(bytes.Repeat([]byte("x"), 2000)); len(got) != 1024 {
		t.Fatalf("length = %d", len(got))
	}
}

func TestSidecarPushesArtworkChanges(t *testing.T) {
	// Track 1 with cover, then a cover change without a title change,
	// then a new track with the cover explicitly cleared.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("icy-metaint", "8")
		w.Header().Set("icy-name", "Art FM")
		w.WriteHeader(http.StatusOK)
		blocks := [][]byte{
			metaBlockWithArt("Song A", "https://cdn/a.jpg"),
			metaBlockWithArt("Song A", "https://cdn/b.jpg"),
			metaBlockWithArt("Song B", "https://broadcaster.live365.com/static/assets/img/blankart.jpg"),
		}
		for _, b := range blocks {
			if _, err := w.Write([]byte("12345678")); err != nil {
				return
			}
			if _, err := w.Write(b); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
		time.Sleep(300 * time.Millisecond)
	}))
	defer srv.Close()

	var mu sync.Mutex
	var metas []Meta
	s := Start(srv.URL, "radio-desktop-test", func(m Meta) {
		mu.Lock()
		metas = append(metas, m)
		mu.Unlock()
	})
	defer s.Stop()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(metas) >= 3
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(metas) < 3 {
		t.Fatalf("metas = %+v", metas)
	}
	if metas[0].Title != "Song A" || metas[0].ArtworkURL != "https://cdn/a.jpg" {
		t.Fatalf("first = %+v", metas[0])
	}
	if metas[1].Title != "Song A" || metas[1].ArtworkURL != "https://cdn/b.jpg" {
		t.Fatalf("artwork-only change = %+v", metas[1])
	}
	if metas[2].Title != "Song B" || metas[2].ArtworkURL != "" {
		t.Fatalf("explicit clear = %+v", metas[2])
	}
}

func TestSidecarReconnectsAfterServerCloses(t *testing.T) {
	var mu sync.Mutex
	idx := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		i := idx
		idx++
		mu.Unlock()
		w.Header().Set("icy-metaint", "8")
		w.Header().Set("icy-name", "Re FM")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("12345678"))
		w.Write(metaBlock([]string{"First", "Second"}[min(i, 1)]))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		// Close right after one block.
	}))
	defer srv.Close()

	var gotMu sync.Mutex
	var got []string
	s := Start(srv.URL, "radio-desktop-test", func(m Meta) {
		gotMu.Lock()
		got = append(got, m.Title)
		gotMu.Unlock()
	})
	defer s.Stop()

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		gotMu.Lock()
		done := len(got) >= 2
		gotMu.Unlock()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	gotMu.Lock()
	defer gotMu.Unlock()
	if len(got) < 2 || !strings.Contains(strings.Join(got, "|"), "Second") {
		t.Fatalf("titles after reconnect = %v", got)
	}
}
