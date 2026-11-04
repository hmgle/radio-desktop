// radio-desktop is an internet radio player for the desktop, the mygo
// sibling of radio-cli: Go manages the catalog (Radio Browser sync into
// SQLite), favorites, history, the ICY metadata sidecar and the system's
// Now Playing, while the webview frontend plays the stream with an
// <audio> element.
package main

import (
	_ "embed"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/fetch"

	"radio-desktop/internal/app"
	"radio-desktop/internal/audio"
	"radio-desktop/internal/directory"
	"radio-desktop/internal/store"
	"radio-desktop/locales"
)

//go:embed resources/tray.png
var trayIconPNG []byte

//go:embed resources/tray-template.png
var trayTemplatePNG []byte

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // a second launch forwarded to the running instance
	}
	// Binding generation runs main without opening a WebView and must work
	// on build machines that have no native audio libraries installed.
	if os.Getenv("MYGO_GENERATE") == "" {
		if err := audio.Prepare(); err != nil {
			log.Fatal(err)
		}
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
	// HLS manifests, segments and keys use Go's HTTP client, including
	// streams whose servers do not provide browser CORS headers.
	mygo.Use(fetch.Plugin)

	mygo.App.WhenReady(func() {
		applySettings := func(v app.Settings) {
			language := v.Language
			if language == "system" {
				language = ""
			}
			mygo.App.SetLocale(language)
			mygo.Theme.SetSource(mygo.ThemeSource(v.Appearance))
		}
		applySettings(svc.GetSettings())
		svc.OnSettingsChange = func(v app.Settings) { mygo.RunOnMain(func() { applySettings(svc.GetSettings()) }) }
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "Radio Desktop",
			Width:           1000,
			Height:          680,
			MinWidth:        840,
			MinHeight:       560,
			BackgroundColor: "light-dark(#f6f7f9, #0f1115)",
			StateKey:        "main",
			URL:             "/",
			Page: mygo.PageOptions{
				Autoplay:             mygo.AutoplayAllow,
				BackgroundThrottling: mygo.ThrottlingOff,
			},
		})

		// Closing the window keeps the radio playing from the tray — but
		// a quit (tray 退出, Cmd+Q) must not be vetoed by that handler,
		// or the app can never exit. OnBeforeQuit fires before windows
		// are asked to close, so it can arm the escape hatch.
		var tray *mygo.Tray
		quitting := false
		mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
		win.OnClose(func(e *mygo.CloseEvent) {
			if quitting {
				return
			}
			if svc.GetSettings().CloseBehavior == "quit" || tray == nil {
				e.PreventDefault()
				mygo.App.Quit()
				return
			}
			e.PreventDefault()
			win.Hide()
		})

		mygo.App.OnSecondInstance(func([]string, string) { showMainWindow() })
		setMenuBar(svc)
		tray = newTray(svc)
		svc.OnUIStateChange = func() { mygo.RunOnMain(func() { syncTray(tray, svc) }) }
		mygo.App.OnLocaleChanged(func(string) { setMenuBar(svc); syncTray(tray, svc) })
		syncTray(tray, svc)

		go svc.StartupSync()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// showMainWindow also reveals a hidden window: App.Focus alone only
// activates a visible window on some platforms.
func showMainWindow() {
	if windows := mygo.Windows(); len(windows) > 0 {
		windows[0].Show()
		windows[0].Focus()
	}
	mygo.App.Focus()
}

// ui sends an app action to the frontend, which owns the audio element
// and the dialogs.
func ui(action string) func(*mygo.MenuItem, *mygo.Window) {
	return func(*mygo.MenuItem, *mygo.Window) {
		if action == "settings" || action == "add" || action == "playURL" {
			showMainWindow()
		}
		if err := app.EventUICommand.Broadcast(action); err != nil {
			log.Printf("ui command: %v", err)
		}
	}
}

// setMenuBar gives the app its menu bar with the edit roles
// WebKit's text fields need for their keyboard shortcuts.
func setMenuBar(svc *app.Service) {
	name := mygo.App.Name()
	var windowMenu []*mygo.MenuItem
	if runtime.GOOS == "darwin" {
		windowMenu = []*mygo.MenuItem{
			{Role: mygo.RoleMinimize},
			{Role: mygo.RoleZoom},
			mygo.Separator(),
			{Role: mygo.RoleFront},
		}
	} else {
		windowMenu = []*mygo.MenuItem{{Role: mygo.RoleMinimize}}
	}
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: name, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			mygo.Separator(),
			{Label: locales.Settings(), Accelerator: "CmdOrCtrl+,", Click: ui("settings")},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Label: locales.MenuFile(), Submenu: []*mygo.MenuItem{
			{Label: locales.MenuAdd(), Accelerator: "CmdOrCtrl+N", Click: ui("add")},
			{Label: locales.MenuURL(), Accelerator: "CmdOrCtrl+L", Click: ui("playURL")},
		}},
		{Label: locales.MenuEdit(), Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleUndo},
			{Role: mygo.RoleRedo},
			mygo.Separator(),
			{Role: mygo.RoleCut},
			{Role: mygo.RoleCopy},
			{Role: mygo.RolePaste},
			{Role: mygo.RoleSelectAll},
		}},
		{Label: locales.MenuControl(), Submenu: []*mygo.MenuItem{
			{Label: locales.Toggle(), Click: ui("toggle")},
			{Label: locales.Random(), Click: ui("random")},
			{Label: locales.ToggleFavorite(), Click: ui("favorite")},
			mygo.Separator(),
			{Label: locales.Stop(), Click: ui("stop")},
		}},
		{Label: locales.MenuWindow(), Submenu: windowMenu},
	}))
}

// newTray adds the menu-bar icon whose menu mirrors what plays.
func newTray(svc *app.Service) *mygo.Tray {
	icon, template := trayIconPNG, false
	if runtime.GOOS == "darwin" {
		icon, template = trayTemplatePNG, true
	}
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "main",
		Icon:           icon,
		IconIsTemplate: template,
		ToolTip:        "Radio Desktop",
	})
	if err != nil {
		log.Printf("tray: %v", err)
		return nil
	}
	return tray
}

// syncTray rebuilds the tray's menu and title as playback changes.
func syncTray(tray *mygo.Tray, svc *app.Service) {
	if tray == nil {
		return
	}
	items := []*mygo.MenuItem{
		{Label: locales.Settings(), Click: ui("settings")},
		{Label: locales.ShowWindow(), Click: func(*mygo.MenuItem, *mygo.Window) { showMainWindow() }},
		mygo.Separator(),
	}
	if station := svc.CurrentStationName(); station != "" {
		playPause := locales.Play()
		if svc.PlayingNow() {
			playPause = locales.Pause()
		}
		fav := locales.FavoriteCurrent()
		if svc.CurrentFavorite() {
			fav = locales.UnfavoriteCurrent()
		}
		items = append(items,
			&mygo.MenuItem{Label: playPause + " · " + station, Click: ui("toggle")},
			&mygo.MenuItem{Label: locales.Random(), Click: ui("random")},
			&mygo.MenuItem{Label: fav, Click: ui("favorite")},
		)
	} else {
		items = append(items, &mygo.MenuItem{Label: locales.RandomStart(), Click: ui("random")})
	}
	items = append(items,
		mygo.Separator(),
		&mygo.MenuItem{Label: locales.Quit(), Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	)
	tray.SetMenu(mygo.NewMenu(items))

	// The station's name rides next to the icon on macOS.
	title := ""
	if svc.PlayingNow() {
		title = svc.CurrentStationName()
	}
	tray.SetTitle(title)
}
