package app

import (
	"errors"
	"github.com/egoist/mygo"
	"time"
)

// SleepTimer describes a timer for this process only. Generation orders
// replies and events, including callbacks already queued before cancellation.
type SleepTimer struct {
	Deadline   int64  `json:"deadline"` // Unix milliseconds; zero means disabled
	Generation uint64 `json:"generation"`
	Expired    bool   `json:"expired"`
}

var EventSleepTimerChanged = mygo.NewEvent[SleepTimer]("sleepTimerChanged")

// GetSleepTimer returns the active timer or its most recent expiration.
func (s *Service) GetSleepTimer() SleepTimer {
	s.sleepMu.Lock()
	defer s.sleepMu.Unlock()
	return s.sleepState
}

// SetSleepTimer replaces the countdown. Zero cancels it.
func (s *Service) SetSleepTimer(minutes int) (SleepTimer, error) {
	if minutes != 0 && minutes != 15 && minutes != 30 && minutes != 60 && minutes != 120 {
		return SleepTimer{}, errors.New("radio:invalidSettings")
	}
	s.sleepMu.Lock()
	defer s.sleepMu.Unlock()
	if s.sleepTimer != nil {
		s.sleepTimer.Stop()
		s.sleepTimer = nil
	}
	s.sleepState = SleepTimer{Generation: s.sleepState.Generation + 1}
	if minutes > 0 {
		s.sleepState.Deadline = time.Now().Add(time.Duration(minutes) * time.Minute).UnixMilli()
		s.scheduleSleepCheck(s.sleepState.Generation)
	}
	_ = EventSleepTimerChanged.Broadcast(s.sleepState)
	return s.sleepState, nil
}

func (s *Service) scheduleSleepCheck(generation uint64) {
	s.sleepTimer = time.AfterFunc(time.Second, func() { s.checkSleepTimer(generation, time.Now()) })
}

// Poll wall time so a computer waking from sleep stops promptly even on
// systems whose monotonic clock did not advance while suspended.
func (s *Service) checkSleepTimer(generation uint64, now time.Time) {
	s.sleepMu.Lock()
	defer s.sleepMu.Unlock()
	if generation != s.sleepState.Generation || s.sleepState.Deadline == 0 {
		return
	}
	if now.UnixMilli() < s.sleepState.Deadline {
		s.scheduleSleepCheck(generation)
		return
	}
	s.sleepState.Deadline = 0
	s.sleepState.Expired = true
	s.sleepTimer = nil
	_ = EventSleepTimerChanged.Broadcast(s.sleepState)
}
