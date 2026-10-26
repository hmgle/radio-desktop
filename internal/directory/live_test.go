package directory

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveBootstrap hits the real Radio Browser API. Opt in with
// RADIO_LIVE=1 go test -run Live ./internal/directory
func TestLiveBootstrap(t *testing.T) {
	if os.Getenv("RADIO_LIVE") == "" {
		t.Skip("set RADIO_LIVE=1 to run live network tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c := New(Options{UserAgent: "radio-desktop-test"})
	start := time.Now()
	st, err := c.Bootstrap(ctx)
	if err != nil {
		t.Fatalf("bootstrap failed after %s: %v", time.Since(start).Round(time.Millisecond), err)
	}
	if len(st) == 0 {
		t.Fatal("bootstrap returned 0 stations")
	}
	t.Logf("bootstrap: %d stations in %s", len(st), time.Since(start).Round(time.Millisecond))
}
