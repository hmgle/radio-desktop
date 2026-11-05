package audio

import (
	"fmt"
	"os"
	"unsafe"

	"github.com/ebitengine/purego"
)

const restoreID = "sink-input-by-application-id:com.hmgle.radio-desktop"

// Prepare prevents WebKit's PulseAudio stream volume from being remembered
// for the shared Music role. The app already persists its own volume.
// Call this before creating any WebView, including during development.
func Prepare() error {
	props, err := isolatedProperties(os.Getenv("PULSE_PROP_OVERRIDE"))
	if err != nil {
		return fmt.Errorf("prepare audio volume isolation: %w", err)
	}
	return os.Setenv("PULSE_PROP_OVERRIDE", props)
}

func isolatedProperties(existing string) (string, error) {
	lib, err := purego.Dlopen("libpulse.so.0", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		return "", err
	}
	defer purego.Dlclose(lib)
	var parse func(string) uintptr
	var set func(uintptr, string, string) int32
	var serialize func(uintptr) *byte
	var free func(uintptr)
	var freeString func(*byte)
	for _, symbol := range []struct {
		name string
		fn   any
	}{
		{"pa_proplist_from_string", &parse},
		{"pa_proplist_sets", &set},
		{"pa_proplist_to_string", &serialize},
		{"pa_xfree", &freeString},
		{"pa_proplist_free", &free},
	} {
		addr, err := purego.Dlsym(lib, symbol.name)
		if err != nil {
			return "", err
		}
		purego.RegisterFunc(symbol.fn, addr)
	}
	// Validate with libpulse's parser rather than splitting quoted values.
	// A malformed inherited value could swallow the appended keys. Parsing
	// properties opens no connection to the user's audio server.
	props := parse(existing)
	if props == 0 {
		return "", fmt.Errorf("invalid PULSE_PROP_OVERRIDE")
	}
	defer free(props)
	// WirePlumber doesn't honor module-stream-restore.id when forming its
	// role key, so opt this client's streams out of volume save/restore.
	// PulseAudio's module-stream-restore uses the explicit, private ID.
	for key, value := range map[string]string{
		"state.restore-props": "false", "module-stream-restore.id": restoreID,
	} {
		if set(props, key, value) < 0 {
			return "", fmt.Errorf("cannot set %s", key)
		}
	}
	serialized := serialize(props)
	if serialized == nil {
		return "", fmt.Errorf("cannot serialize audio stream properties")
	}
	defer freeString(serialized)
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(serialized), length)) != 0 {
		length++
	}
	return string(unsafe.Slice(serialized, length)), nil
}
