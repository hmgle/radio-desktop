package audio

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/fetch"
)

// The driver is controlled by tools/test-audio-isolation.py. It must
// only run against that tool's private audio server, never the user's.
// App.Run requires the main goroutine, so this cannot run as a TestXxx.
func TestMain(m *testing.M) {
	frontend := os.Getenv("RADIO_AUDIO_TEST_FRONTEND")
	if frontend == "" {
		os.Exit(m.Run())
	}
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if filepath.Dir(frontend) != filepath.Dir(runtimeDir) ||
		os.Getenv("PULSE_SERVER") != "unix:"+filepath.Join(runtimeDir, "pulse/native") {
		log.Fatal("the WebView driver requires a private runtime and PulseAudio socket")
	}
	if err := Prepare(); err != nil {
		log.Fatal(err)
	}
	mygo.SetFrontend(os.DirFS(frontend))
	mygo.Use(fetch.Plugin)
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: "Isolated audio test", Hidden: true, URL: "/",
			Page: mygo.PageOptions{Autoplay: mygo.AutoplayAllow, BackgroundThrottling: mygo.ThrottlingOff},
		})
		win.Page().OnRenderProcessGone(func(reason string) {
			log.Printf("WebView process exited: %s", reason)
			mygo.App.Quit()
		})
		go func() {
			defer mygo.App.Quit()
			ready := false
			for range 200 {
				ready, _ = mygo.EvalAs[bool](win.Page(), "!!window.player")
				if ready {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
			if !ready {
				log.Print("player did not initialize")
				return
			}
			fmt.Println(`{"audioCheck":"ready"}`)
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
				var script string
				if err := json.Unmarshal(scanner.Bytes(), &script); err != nil {
					panic(err)
				}
				value, err := win.Page().Eval(script)
				reply := map[string]any{"audioCheck": "reply", "value": value}
				if err != nil {
					log.Printf("Eval failed for %q: %v", script, err)
					reply["error"] = err.Error()
				}
				b, _ := json.Marshal(reply)
				fmt.Println(string(b))
			}
		}()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	os.Exit(0)
}
