package app

import (
	"path/filepath"
	"testing"

	"radio-desktop/internal/store"
)

func TestServiceValidationAndStatus(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "radio.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := New(st, nil)
	for _, url := range []string{"", "ftp://example.com", "javascript:alert(1)"} {
		if _, err := s.AddCustomStation("Test", url, ""); err == nil {
			t.Errorf("accepted invalid URL %q", url)
		}
	}
	status, err := s.GetStatus()
	if err != nil || status.LastSyncAt != 0 {
		t.Fatalf("new store status = %+v, %v", status, err)
	}
}

func TestStopPlaybackCallbackCanReadService(t *testing.T) {
	s := New(nil, nil)
	s.currentUUID = ""
	called := false
	s.OnUIStateChange = func() { s.CurrentFavorite(); called = true }
	s.StopPlayback()
	if !called {
		t.Fatal("UI callback not called")
	}
}

func TestOldPlaybackReportCannotStopNewSession(t *testing.T) {
	s := New(nil, nil)
	s.sessionID = 2
	s.currentUUID = "new"
	s.np.setStation("New station", "")
	s.ReportPlaybackState("failed", 1)
	if s.CurrentStationName() != "New station" || s.currentUUID != "new" {
		t.Fatal("stale report stopped the current session")
	}
	s.ReportPlaybackState("idle", 2)
	if s.CurrentStationName() != "" || s.currentUUID != "" {
		t.Fatal("current idle report did not stop playback")
	}
}
