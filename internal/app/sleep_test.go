package app

import (
	"testing"
	"time"
)

func TestSleepTimerReplacementCancellationAndExpiration(t *testing.T) {
	s := New(nil, nil)
	first, err := s.SetSleepTimer(15)
	if err != nil || first.Deadline <= time.Now().UnixMilli() {
		t.Fatalf("timer = %+v, %v", first, err)
	}
	second, _ := s.SetSleepTimer(30)
	s.checkSleepTimer(first.Generation, time.Now().Add(time.Hour))
	if s.GetSleepTimer() != second {
		t.Fatal("old callback replaced current countdown")
	}
	cancelled, _ := s.SetSleepTimer(0)
	s.checkSleepTimer(second.Generation, time.Now().Add(time.Hour))
	if s.GetSleepTimer() != cancelled || cancelled.Expired {
		t.Fatal("cancelled timer expired")
	}
	active, _ := s.SetSleepTimer(15)
	s.sleepMu.Lock()
	s.sleepTimer.Stop()
	s.sleepMu.Unlock()
	s.checkSleepTimer(active.Generation, time.UnixMilli(active.Deadline+1))
	result := s.GetSleepTimer()
	if !result.Expired || result.Deadline != 0 || result.Generation != active.Generation {
		t.Fatalf("expiration = %+v", result)
	}
	if _, err := s.SetSleepTimer(-1); err == nil {
		t.Fatal("accepted negative timer")
	}
	if _, err := s.SetSleepTimer(1); err == nil {
		t.Fatal("accepted unsupported preset")
	}
	if s.GetSleepTimer() != result {
		t.Fatal("invalid request changed timer")
	}
	fresh := New(nil, nil)
	if fresh.GetSleepTimer().Deadline != 0 {
		t.Fatal("timer survived restart")
	}
}

func TestSleepCheckDelayBounds(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	for _, tc := range []struct {
		remaining time.Duration
		want      time.Duration
	}{
		{2 * time.Hour, 30 * time.Second},
		{30 * time.Second, 30 * time.Second},
		{1250 * time.Millisecond, 1250 * time.Millisecond},
		{0, 0},
		{-time.Minute, 0},
	} {
		if got := sleepCheckDelay(now.Add(tc.remaining).UnixMilli(), now); got != tc.want {
			t.Errorf("remaining %s: delay = %s, want %s", tc.remaining, got, tc.want)
		}
	}
}

func TestSleepTimerRechecksWallClockBeforeExpiring(t *testing.T) {
	s := New(nil, nil)
	now := time.Now()
	// A wall-clock change can put the deadline farther away than the
	// previously scheduled check. It must reschedule rather than expire.
	active := SleepTimer{Generation: 1, Deadline: now.Add(time.Minute).UnixMilli()}
	s.sleepState = active
	s.checkSleepTimer(active.Generation, now)
	if s.GetSleepTimer() != active {
		t.Fatal("timer expired before its wall-clock deadline")
	}
	s.sleepMu.Lock()
	s.sleepTimer.Stop()
	s.sleepMu.Unlock()
	// Conversely, after a clock jump or resume past the deadline, the
	// next check must expire immediately instead of waiting the duration.
	s.checkSleepTimer(active.Generation, now.Add(2*time.Minute))
	if result := s.GetSleepTimer(); !result.Expired || result.Deadline != 0 {
		t.Fatalf("elapsed deadline was not expired: %+v", result)
	}
}
