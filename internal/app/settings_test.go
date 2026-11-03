package app

import (
	"path/filepath"
	"radio-desktop/internal/store"
	"testing"
)

func TestSettingsDefaultsValidationAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "radio.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s := New(st, nil)
	if s.GetSettings() != defaultSettings() {
		t.Fatal("unexpected defaults")
	}
	dark, invalid := "dark", "invalid"
	next, err := s.UpdateSettings(SettingsPatch{Appearance: &dark})
	if err != nil || next.Appearance != dark || next.Language != "system" {
		t.Fatalf("patch = %+v, %v", next, err)
	}
	if _, err = s.UpdateSettings(SettingsPatch{Language: &invalid}); err == nil {
		t.Fatal("accepted invalid language")
	}
	st.Close()
	st, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s = New(st, nil)
	if s.GetSettings().Appearance != dark {
		t.Fatal("lost settings after restart")
	}
	st.Close()
	en := "en"
	if _, err = s.UpdateSettings(SettingsPatch{Language: &en}); err == nil {
		t.Fatal("accepted failed write")
	}
	if s.GetSettings().Language != "system" {
		t.Fatal("failed write changed settings")
	}
}

func TestSettingsMissingFieldsAndCorruption(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "radio.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, raw := range []string{`broken`, `null`, `{"version":2}`, `{"autoSyncDays":-1}`, `{"resume":"bad"}`} {
		if err := st.SetMeta("pref_settings", raw); err != nil {
			t.Fatal(err)
		}
		if got := loadSettings(st); got != defaultSettings() {
			t.Fatalf("%s => %+v", raw, got)
		}
	}
	st.SetMeta("pref_settings", `{"version":1,"appearance":"dark"}`)
	expected := defaultSettings()
	expected.Appearance = "dark"
	if loadSettings(st) != expected {
		t.Fatal("missing fields did not retain defaults")
	}
}
