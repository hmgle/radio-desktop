package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/netproxy"
)

// EventMediaCommand carries a media-key or menu action to the frontend:
// "toggle" (play/pause), the only command meaningful for a live stream.
var EventMediaCommand = mygo.NewEvent[string]("mediaCommand")

// EventUICommand carries app-menu and tray actions to the frontend:
// "toggle", "random" (play a random station), "favorite" (toggle the
// current station's favorite mark), "stop", "add" and "playURL" (open
// their dialogs).
var EventUICommand = mygo.NewEvent[string]("uiCommand")

// nowPlaying mirrors what the app plays into the system's media controls
// (Control Center, media keys, lock screen), as mygo-cloudmusic does: the
// ICY track title as the title, the station as the artist, and the track
// cover or station logo as the artwork.
type nowPlaying struct {
	mu             sync.Mutex
	title          string // ICY StreamTitle, if the stream sends one
	station        string
	country        string
	state          mygo.PlaybackState
	artURL         string // preferred artwork URL (ICY StreamArtwork)
	fallbackArtURL string
	revision       uint64
	announced      uint64
	publishing     bool
	artCancel      context.CancelFunc

	artC       map[string][]byte // artwork bytes by URL
	httpClient *http.Client
}

func newNowPlaying() *nowPlaying {
	return &nowPlaying{state: mygo.PlaybackStopped, artC: map[string][]byte{}, httpClient: npHTTPClient}
}

// setStation is called when playback selects a station.
func (n *nowPlaying) setStation(name, country string) {
	n.mu.Lock()
	n.changedLocked()
	n.title, n.station, n.country = "", name, country
	n.mu.Unlock()
}

// setArtURL sets the fallback artwork (the station's favicon) until an
// ICY StreamArtwork arrives on top of it.
func (n *nowPlaying) setArtURL(url string) {
	n.mu.Lock()
	if n.artURL != url || n.fallbackArtURL != url {
		n.changedLocked()
		n.artURL, n.fallbackArtURL = url, url
	}
	n.mu.Unlock()
}

// setMeta is called from the ICY sidecar on every metadata push.
func (n *nowPlaying) setMeta(title, artURL string) {
	n.mu.Lock()
	if artURL == "" {
		artURL = n.fallbackArtURL
	}
	if n.title != title || n.artURL != artURL {
		n.changedLocked()
		n.title, n.artURL = title, artURL
	}
	n.mu.Unlock()
}

// setState is called as the frontend's audio element starts, pauses or stops.
func (n *nowPlaying) setState(state mygo.PlaybackState) {
	n.mu.Lock()
	if n.state != state {
		n.changedLocked()
		n.state = state
	}
	n.mu.Unlock()
}

func (n *nowPlaying) clear() {
	n.mu.Lock()
	n.changedLocked()
	n.title, n.station, n.country, n.artURL = "", "", "", ""
	n.fallbackArtURL = ""
	n.state = mygo.PlaybackStopped
	mygo.NowPlaying.Clear()
	n.mu.Unlock()
}

func (n *nowPlaying) changedLocked() {
	n.revision++
	if n.artCancel != nil {
		n.artCancel()
	}
}

// buildInfo assembles the system-facing info from the current state,
// with the artwork bytes supplied by the caller (cache or download).
func (n *nowPlaying) buildInfo(art []byte) mygo.NowPlayingInfo {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.buildInfoLocked(art)
}

func (n *nowPlaying) buildInfoLocked(art []byte) mygo.NowPlayingInfo {
	info := mygo.NowPlayingInfo{
		Title:    n.title,
		Artist:   n.station,
		Album:    n.country,
		State:    n.state,
		Commands: mygo.MediaPlay | mygo.MediaPause,
		Artwork:  art,
	}
	if info.Title == "" {
		// No ICY title yet (or the stream sends none): the station is
		// the headline.
		info.Title = n.station
		info.Artist = n.country
	}
	return info
}

// announce pushes the current info to the system's media controls,
// fetching the artwork bytes if they are not cached.
func (n *nowPlaying) announce() {
	n.mu.Lock()
	if n.publishing || n.announced == n.revision || n.station == "" {
		n.mu.Unlock()
		return
	}
	n.publishing = true
	n.mu.Unlock()
	go n.publish()
}

func (n *nowPlaying) publish() {
	for {
		n.mu.Lock()
		if n.announced == n.revision || n.station == "" {
			n.publishing = false
			n.mu.Unlock()
			return
		}
		revision, artURL := n.revision, n.artURL
		info := n.buildInfoLocked(nil)
		art, cached := n.artC[artURL]
		ctx, cancel := context.WithCancel(context.Background())
		n.artCancel = cancel
		n.mu.Unlock()
		if !cached && artURL != "" {
			if fetched, err := fetchArtworkWithClient(ctx, artURL, n.httpClient); err == nil {
				n.rememberArt(artURL, fetched)
				art = fetched
			} else if ctx.Err() == nil {
				log.Printf("now playing artwork %s: %v", artURL, err)
			}
		}
		cancel()
		n.mu.Lock()
		n.artCancel = nil
		if revision != n.revision {
			n.mu.Unlock()
			continue
		}
		info.Artwork = art
		mygo.NowPlaying.Set(info)
		n.announced = revision
		n.publishing = false
		n.mu.Unlock()
		return
	}
}

func (n *nowPlaying) rememberArt(url string, art []byte) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.artC) >= 64 { // crude bound; entries are small covers
		n.artC = map[string][]byte{}
	}
	n.artC[url] = art
}

var npHTTPClient = &http.Client{Transport: netproxy.Transport(), Timeout: 10 * time.Second}

var (
	errNotImage = errors.New("not a PNG or JPEG image")
	errTooLarge = errors.New("image over the 256KB cap")
)

// fetchArtwork downloads a cover, accepting PNG/JPEG up to 256KB, like
// radio-cli's artwork cap.
func fetchArtwork(rawURL string) ([]byte, error) {
	return fetchArtworkContext(context.Background(), rawURL)
}

func fetchArtworkContext(parent context.Context, rawURL string) ([]byte, error) {
	return fetchArtworkWithClient(parent, rawURL, npHTTPClient)
}

func fetchArtworkWithClient(parent context.Context, rawURL string, client *http.Client) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %s", resp.Status)
	}
	const cap = 256 << 10
	body, err := io.ReadAll(io.LimitReader(resp.Body, cap+1))
	if err != nil {
		return nil, err
	}
	if len(body) > cap {
		return nil, errTooLarge
	}
	if !bytes.HasPrefix(body, []byte("\x89PNG")) && !bytes.HasPrefix(body, []byte("\xFF\xD8\xFF")) {
		return nil, errNotImage
	}
	return body, nil
}
