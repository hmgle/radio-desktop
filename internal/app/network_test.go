package app

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"radio-desktop/internal/model"
	"radio-desktop/internal/network"
	"radio-desktop/internal/store"
)

func TestPlayInfoCarriesHLSHintToExtensionlessNativeURL(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet || req.Header.Get("Range") != "" {
			t.Error("hinted playlist was not fetched in full")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write([]byte("#EXTM3U\n#EXTINF:6,\nsegment.ts\n"))
	}))
	defer proxy.Close()
	n, err := network.New(network.Config{Mode: "manual", URL: proxy.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	s := &Service{network: n}
	info := s.preparePlayInfo(PlayInfo{
		Station: model.Station{HLS: 1}, Candidates: []string{"http://station.invalid/live"},
	})
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodHead, info.NativeCandidates[0], nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || resp.ContentLength <= 30 {
		t.Fatalf("HEAD did not describe rewritten HLS: %d %v", resp.StatusCode, resp.Header)
	}
}

func TestNetworkPreferencesPersistenceAndMediaCoverage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "radio.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st, nil)
	if s.GetSettings().ProxyMode != "auto" {
		t.Fatal("upgrades must default to automatic networking")
	}
	icyRequests := make(chan struct{}, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/audio" {
			icyRequests <- struct{}{}
		}
		w.Header().Set("icy-name", "Proxy FM")
		w.Write(pngHeader)
	}))
	defer proxy.Close()
	mode, address := "manual", proxy.URL
	if _, err := s.UpdateSettings(SettingsPatch{ProxyMode: &mode, ProxyURL: &address}); err != nil {
		t.Fatal(err)
	}
	s = New(st, nil)
	n, err := StartNetwork(s)
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	station := model.Station{StationUUID: "aaaaaaaa-1111-2222-3333-444444444444", Name: "Example", URL: "http://station.invalid/audio", Favicon: "http://station.invalid/image.png"}
	if err := st.PublishCatalog([]model.Station{station}); err != nil {
		t.Fatal(err)
	}
	info, err := s.GetPlayInfo(station.StationUUID)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.NativeCandidates) != 1 || info.Candidates[0] != station.URL || !strings.HasPrefix(info.NativeCandidates[0], "http://127.0.0.1:") {
		t.Fatalf("native and upstream candidates were not separated: %+v", info)
	}
	if info.Station.URL != station.URL || !strings.HasPrefix(info.Station.Favicon, "http://127.0.0.1:") {
		t.Fatal("public station did not route artwork while preserving its address")
	}
	list, err := s.Search(store.SearchRequest{})
	if err != nil || len(list.Items) != 1 || list.Items[0].Favicon != info.Station.Favicon {
		t.Fatalf("list images bypassed policy: %+v, %v", list, err)
	}
	got, err := s.GetStation(station.StationUUID)
	if err != nil || got.Favicon != info.Station.Favicon {
		t.Fatal("station image bypassed policy")
	}
	if art, err := fetchArtworkWithClient(t.Context(), station.Favicon, s.np.httpClient); err != nil || len(art) == 0 {
		t.Fatalf("system artwork bypassed proxy: %v", err)
	}
	s.startSidecar(&PlayInfo{Station: station, Candidates: []string{station.URL}})
	select {
	case <-icyRequests:
	case <-time.After(3 * time.Second):
		s.StopPlayback()
		t.Fatal("ICY request bypassed the selected proxy")
	}
	s.StopPlayback()
	stored, _, _ := st.GetStation(station.StationUUID)
	if stored.Favicon != station.Favicon {
		t.Fatal("temporary relay URL was persisted")
	}
	// Saving a policy never switches an existing session halfway through.
	direct := "direct"
	if _, err := s.UpdateSettings(SettingsPatch{ProxyMode: &direct}); err != nil {
		t.Fatal(err)
	}
	if s.network != n {
		t.Fatal("policy changed without restart")
	}
	if loadSettings(st).ProxyMode != "direct" {
		t.Fatal("next-launch policy was not persisted")
	}
	st.Close()
	address = "http://proxy.example:8080"
	if _, err := s.UpdateSettings(SettingsPatch{ProxyMode: &mode, ProxyURL: &address}); err == nil {
		t.Fatal("failed save was accepted")
	}
	if s.GetSettings().ProxyMode != "direct" {
		t.Fatal("failed write changed preferences")
	}
}

func TestInvalidProxyPatchPreservesOtherPreferences(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "radio.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st, nil)
	mode, bad := "manual", "http://user:secret@proxy.example:8080"
	before := s.GetSettings()
	if _, err := s.UpdateSettings(SettingsPatch{ProxyMode: &mode, ProxyURL: &bad}); err == nil {
		t.Fatal("accepted unsupported proxy authentication")
	}
	if s.GetSettings() != before || loadSettings(st) != before {
		t.Fatal("invalid patch changed saved preferences")
	}
}
