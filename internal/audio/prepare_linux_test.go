package audio

import (
	"os"
	"strings"
	"testing"

	"github.com/ebitengine/purego"
)

func TestPrepare(t *testing.T) {
	if os.Getenv("RADIO_AUDIO_TEST") != "1" {
		t.Skip("set RADIO_AUDIO_TEST=1 to test with the installed libpulse")
	}
	lib, err := purego.Dlopen("libpulse.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(lib)
	var parse func(string) uintptr
	var get func(uintptr, string) string
	var free func(uintptr)
	purego.RegisterLibFunc(&parse, lib, "pa_proplist_from_string")
	purego.RegisterLibFunc(&get, lib, "pa_proplist_gets")
	purego.RegisterLibFunc(&free, lib, "pa_proplist_free")
	for _, existing := range []string{"", `application.name="Custom Radio"`,
		`application.name="Custom Radio" state.restore-props=true module-stream-restore.id=shared`} {
		t.Run(existing, func(t *testing.T) {
			t.Setenv("PULSE_PROP_OVERRIDE", existing)
			for range 2 {
				if err := Prepare(); err != nil {
					t.Fatal(err)
				}
				props := parse(os.Getenv("PULSE_PROP_OVERRIDE"))
				if props == 0 {
					t.Fatal("libpulse rejected the prepared properties")
				}
				defer free(props)
				for key, want := range map[string]string{
					"state.restore-props":      "false",
					"module-stream-restore.id": restoreID,
				} {
					if got := get(props, key); got != want {
						t.Errorf("%s = %q, want %q", key, got, want)
					}
				}
				if existing != "" && get(props, "application.name") != "Custom Radio" {
					t.Fatal("lost inherited application name")
				}
			}
		})
	}
}

func TestPrepareRejectsMalformedProperties(t *testing.T) {
	if os.Getenv("RADIO_AUDIO_TEST") != "1" {
		t.Skip("set RADIO_AUDIO_TEST=1 to test with the installed libpulse")
	}
	existing := `application.name="unterminated`
	t.Setenv("PULSE_PROP_OVERRIDE", existing)
	if err := Prepare(); err == nil || !strings.Contains(err.Error(), "invalid PULSE_PROP_OVERRIDE") {
		t.Fatalf("expected malformed property error, got %v", err)
	}
	if os.Getenv("PULSE_PROP_OVERRIDE") != existing {
		t.Fatal("changed environment after invalid input")
	}
}
