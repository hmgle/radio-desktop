package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

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
