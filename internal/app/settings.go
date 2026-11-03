package app

import (
	"encoding/json"
	"errors"
	"log"

	"github.com/egoist/mygo"
	"radio-desktop/internal/store"
)

// Settings contains the listener's persistent preferences. Volume stays in
// its existing preference so upgrades retain the last listening level.
type Settings struct {
	Language      string `json:"language"`
	Appearance    string `json:"appearance"`
	Resume        string `json:"resume"`
	AutoSyncDays  int    `json:"autoSyncDays"`
	CloseBehavior string `json:"closeBehavior"`
}

// SettingsPatch changes only supplied fields, avoiding lost updates when
// different controls save in quick succession.
type SettingsPatch struct {
	Language      *string `json:"language,omitempty"`
	Appearance    *string `json:"appearance,omitempty"`
	Resume        *string `json:"resume,omitempty"`
	AutoSyncDays  *int    `json:"autoSyncDays,omitempty"`
	CloseBehavior *string `json:"closeBehavior,omitempty"`
}

type savedSettings struct {
	Version int `json:"version"`
	Settings
}

var EventSettingsChanged = mygo.NewEvent[Settings]("settingsChanged")

func defaultSettings() Settings {
	return Settings{Language: "system", Appearance: "system", Resume: "selection", AutoSyncDays: 7, CloseBehavior: "hide"}
}

func loadSettings(st *store.Store) Settings {
	defaults := defaultSettings()
	if st == nil {
		return defaults
	}
	raw, ok, err := st.GetMeta("pref_settings")
	if err != nil {
		log.Printf("load settings: %v", err)
		return defaults
	}
	if !ok {
		return defaults
	}
	saved := savedSettings{Version: 1, Settings: defaults}
	if err := json.Unmarshal([]byte(raw), &saved); err != nil || saved.Version != 1 || saved.validate() != nil {
		log.Printf("invalid settings; using defaults")
		return defaults
	}
	return saved.Settings
}

func (v Settings) validate() error {
	if v.Language != "system" && v.Language != "en" && v.Language != "zh-CN" {
		return errors.New("radio:invalidSettings")
	}
	if v.Appearance != "system" && v.Appearance != "light" && v.Appearance != "dark" {
		return errors.New("radio:invalidSettings")
	}
	if v.Resume != "off" && v.Resume != "selection" && v.Resume != "play" {
		return errors.New("radio:invalidSettings")
	}
	if v.CloseBehavior != "hide" && v.CloseBehavior != "quit" {
		return errors.New("radio:invalidSettings")
	}
	if v.AutoSyncDays < 0 || v.AutoSyncDays > 365 {
		return errors.New("radio:invalidSettings")
	}
	return nil
}

// GetSettings returns the current persisted settings.
func (s *Service) GetSettings() Settings {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	return s.settings
}

// UpdateSettings persists a validated patch before publishing it. Failed
// writes leave the previous settings active.
func (s *Service) UpdateSettings(p SettingsPatch) (Settings, error) {
	s.settingsMu.Lock()
	locked := true
	defer func() {
		if locked {
			s.settingsMu.Unlock()
		}
	}()
	next := s.settings
	if p.Language != nil {
		next.Language = *p.Language
	}
	if p.Appearance != nil {
		next.Appearance = *p.Appearance
	}
	if p.Resume != nil {
		next.Resume = *p.Resume
	}
	if p.AutoSyncDays != nil {
		next.AutoSyncDays = *p.AutoSyncDays
	}
	if p.CloseBehavior != nil {
		next.CloseBehavior = *p.CloseBehavior
	}
	if err := next.validate(); err != nil {
		return s.settings, err
	}
	raw, err := json.Marshal(savedSettings{Version: 1, Settings: next})
	if err != nil {
		return s.settings, err
	}
	if err = s.store.SetMeta("pref_settings", string(raw)); err != nil {
		return s.settings, err
	}
	s.settings = next
	_ = EventSettingsChanged.Broadcast(next)
	s.settingsMu.Unlock()
	locked = false
	if s.OnSettingsChange != nil {
		s.OnSettingsChange(next)
	}
	return next, nil
}
