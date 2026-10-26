package icy

import (
	"os"
	"testing"
	"time"
)

// TestLiveSidecar parses titles from a real radio stream. Opt in with
// RADIO_LIVE=1 go test -run Live ./internal/icy
func TestLiveSidecar(t *testing.T) {
	url := os.Getenv("RADIO_LIVE_URL")
	if os.Getenv("RADIO_LIVE") == "" || url == "" {
		t.Skip("set RADIO_LIVE=1 RADIO_LIVE_URL=https://… to run")
	}

	type result struct {
		metas []Meta
	}
	r := &result{}
	done := make(chan struct{})
	s := Start(url, "radio-desktop-test", func(m Meta) {
		r.metas = append(r.metas, m)
		if len(r.metas) >= 2 {
			select {
			case <-done:
			default:
				close(done)
			}
		}
	})
	defer s.Stop()

	select {
	case <-done:
	case <-time.After(45 * time.Second):
	}
	if len(r.metas) == 0 {
		t.Fatal("no ICY metadata observed within 45s")
	}
	t.Logf("received %d meta pushes; first: %+v", len(r.metas), r.metas[0])
}
