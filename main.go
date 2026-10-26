// radio-desktop is an internet radio player for the desktop, the mygo
// sibling of radio-cli: Go manages the catalog (Radio Browser sync into
// SQLite), favorites, history and the ICY metadata sidecar, while the
// webview frontend plays the stream with an <audio> element.
package main

import (
	_ "embed"
	"log"
	"path/filepath"

	"github.com/egoist/mygo"

	"radio-desktop/internal/app"
	"radio-desktop/internal/directory"
	"radio-desktop/internal/store"
)

//go:embed resources/tray.png
var trayIconPNG []byte

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // a second launch forwarded to the running instance
	}

	dataDir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dataDir, "radio.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	svc := app.New(st, directory.New(directory.Options{UserAgent: "radio-desktop/0.1.0"}))
	mygo.Bind(svc)

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "Radio Desktop",
			Width:           1000,
			Height:          680,
			MinWidth:        840,
			MinHeight:       560,
			BackgroundColor: "light-dark(#f6f7f9, #0f1115)",
			StateKey:        "main",
			URL:             "/",
		})

		// Closing the window keeps the radio playing from the tray — but
		// a quit (tray 退出, Cmd+Q) must not be vetoed by that handler,
		// or the app can never exit. OnBeforeQuit fires before windows
		// are asked to close, so it can arm the escape hatch.
		quitting := false
		mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
		win.OnClose(func(e *mygo.CloseEvent) {
			if quitting {
				return
			}
			e.PreventDefault()
			win.Hide()
		})

		if _, err := mygo.NewTray(mygo.TrayOptions{
			ID:             "main",
			Icon:           trayIconPNG,
			IconIsTemplate: true,
			ToolTip:        "Radio Desktop",
			Menu: mygo.NewMenu([]*mygo.MenuItem{
				{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { win.Show() }},
				{Type: mygo.MenuItemSeparator},
				{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
			}),
		}); err != nil {
			log.Printf("tray: %v", err)
		}

		go svc.StartupSync()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
