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
