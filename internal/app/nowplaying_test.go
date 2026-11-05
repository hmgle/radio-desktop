package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

var pngHeader = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// A valid PNG downloads into the artwork bytes; anything that is not a
// PNG or JPEG, or over the cap, is rejected so Now Playing never gets
// junk.
func TestFetchArtwork(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok.png":
			w.Write(pngHeader)
		case "/html":
			w.Write([]byte("<html>not an image</html>"))
		case "/big.png":
			w.Write(append(pngHeader, make([]byte, 256<<10)...))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	if art, err := fetchArtwork(srv.URL + "/ok.png"); err != nil || len(art) != len(pngHeader) {
		t.Fatalf("png: art=%d err=%v", len(art), err)
	}
	if _, err := fetchArtwork(srv.URL + "/html"); err == nil {
		t.Fatal("html accepted as artwork")
	}
	if _, err := fetchArtwork(srv.URL + "/big.png"); err == nil {
		t.Fatal("oversized artwork accepted")
	}
	if _, err := fetchArtwork(srv.URL + "/404"); err == nil {
		t.Fatal("404 accepted as artwork")
	}
}

func TestClearCancelsPendingArtworkAndCannotRevivePlayback(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer srv.Close()
	n := newNowPlaying()
	n.setStation("Station", "")
	n.setArtURL(srv.URL)
	n.announce()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("artwork request not started")
	}
	n.clear()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("clear did not cancel artwork")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		n.mu.Lock()
		publishing := n.publishing
		n.mu.Unlock()
		if !publishing {
			if _, showing := mygo.NowPlaying.Info(); showing {
				t.Fatal("stopped playback was revived")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("publisher did not stop")
}

func TestIdenticalNowPlayingStateDoesNotInvalidatePublication(t *testing.T) {
	n := newNowPlaying()
	n.setStation("Station", "")
	n.setArtURL("https://example.com/logo.png")
	n.setMeta("Song", "https://example.com/cover.png")
	n.setState(mygo.PlaybackPlaying)
	revision := n.revision
	n.setMeta("Song", "https://example.com/cover.png")
	n.setState(mygo.PlaybackPlaying)
	if n.revision != revision {
		t.Fatal("identical state invalidated publication")
	}
	n.setMeta("", "")
	if n.artURL != n.fallbackArtURL || n.title != "" {
		t.Fatal("empty metadata did not restore station artwork")
	}
}

// Without an ICY title the station headlines; with one the title leads
// and the station becomes the artist, as mygo-cloudmusic shows tracks.
func TestBuildInfoTitleFallback(t *testing.T) {
	np := newNowPlaying()
	np.setStation("華語 HITS", "China")

	info := np.buildInfo(nil)
	if info.Title != "華語 HITS" || info.Artist != "China" {
		t.Fatalf("station headline: %+v", info)
	}

	np.setMeta("Jay Chou - 晴天", "")
	info = np.buildInfo(pngHeader)
	if info.Title != "Jay Chou - 晴天" || info.Artist != "華語 HITS" || info.Album != "China" {
		t.Fatalf("track headline: %+v", info)
	}
	if len(info.Artwork) == 0 {
		t.Fatal("artwork bytes not passed through")
	}
	if info.Commands != mygo.MediaPlay|mygo.MediaPause {
		t.Fatalf("commands = %v", info.Commands)
	}

	np.setState(mygo.PlaybackPlaying)
	if got := np.buildInfo(nil).State; got != mygo.PlaybackPlaying {
		t.Fatalf("state = %v", got)
	}
}
