// radio-desktop is an internet radio player for the desktop, the mygo
// sibling of radio-cli: Go manages the catalog (Radio Browser sync into
// SQLite), favorites, history, the ICY metadata sidecar and the system's
// Now Playing, while the webview frontend plays the stream with an
// <audio> element.
package main

import (
	_ "embed"
	"log"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/fetch"

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
	// HLS manifests, segments and keys use Go's HTTP client, including
	// streams whose servers do not provide browser CORS headers.
	mygo.Use(fetch.Plugin)

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
			Page: mygo.PageOptions{
				Autoplay:             mygo.AutoplayAllow,
				BackgroundThrottling: mygo.ThrottlingOff,
			},
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

		setMenuBar(svc)
		tray := newTray(svc)
		svc.OnUIStateChange = func() { syncTray(tray, svc) }

		go svc.StartupSync()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// ui sends an app action to the frontend, which owns the audio element
// and the dialogs.
func ui(action string) func(*mygo.MenuItem, *mygo.Window) {
	return func(*mygo.MenuItem, *mygo.Window) {
		if err := app.EventUICommand.Broadcast(action); err != nil {
			log.Printf("ui command: %v", err)
		}
	}
}

// setMenuBar gives the app its menu bar, in Chinese, with the edit roles
// WebKit's text fields need for their keyboard shortcuts.
func setMenuBar(svc *app.Service) {
	name := mygo.App.Name()
	var windowMenu []*mygo.MenuItem
	if runtime.GOOS == "darwin" {
		windowMenu = []*mygo.MenuItem{
			{Role: mygo.RoleMinimize, Label: "最小化"},
			{Role: mygo.RoleZoom, Label: "缩放"},
			mygo.Separator(),
			{Role: mygo.RoleFront, Label: "前置全部窗口"},
		}
	} else {
		windowMenu = []*mygo.MenuItem{{Role: mygo.RoleMinimize, Label: "最小化"}}
	}
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: name, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout, Label: "关于 " + name},
			mygo.Separator(),
			{Role: mygo.RoleQuit, Label: "退出 " + name},
		}},
		{Label: "文件", Submenu: []*mygo.MenuItem{
			{Label: "添加电台…", Accelerator: "CmdOrCtrl+N", Click: ui("add")},
			{Label: "播放链接…", Accelerator: "CmdOrCtrl+L", Click: ui("playURL")},
		}},
		{Label: "编辑", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleUndo, Label: "撤销"},
			{Role: mygo.RoleRedo, Label: "重做"},
			mygo.Separator(),
			{Role: mygo.RoleCut, Label: "剪切"},
			{Role: mygo.RoleCopy, Label: "拷贝"},
			{Role: mygo.RolePaste, Label: "粘贴"},
			{Role: mygo.RoleSelectAll, Label: "全选"},
		}},
		{Label: "控制", Submenu: []*mygo.MenuItem{
			{Label: "播放/暂停", Click: ui("toggle")},
			{Label: "随机换个电台", Click: ui("random")},
			{Label: "收藏/取消收藏当前电台", Click: ui("favorite")},
			mygo.Separator(),
			{Label: "停止播放", Click: ui("stop")},
		}},
		{Label: "窗口", Submenu: windowMenu},
	}))
}

// newTray adds the menu-bar icon whose menu mirrors what plays.
func newTray(svc *app.Service) *mygo.Tray {
	icon, template := trayIconPNG, true
	if runtime.GOOS != "darwin" {
		template = false
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
		{Label: "显示主窗口", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Focus() }},
		mygo.Separator(),
	}
	if station := svc.CurrentStationName(); station != "" {
		playPause := "播放"
		if svc.PlayingNow() {
			playPause = "暂停"
		}
		fav := "收藏当前电台"
		if svc.CurrentFavorite() {
			fav = "取消收藏当前电台"
		}
		items = append(items,
			&mygo.MenuItem{Label: playPause + " · " + station, Click: ui("toggle")},
			&mygo.MenuItem{Label: "随机换个电台", Click: ui("random")},
			&mygo.MenuItem{Label: fav, Click: ui("favorite")},
		)
	} else {
		items = append(items, &mygo.MenuItem{Label: "随机播放一个电台", Click: ui("random")})
	}
	items = append(items,
		mygo.Separator(),
		&mygo.MenuItem{Label: "退出 Radio Desktop", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	)
	tray.SetMenu(mygo.NewMenu(items))

	// The station's name rides next to the icon on macOS.
	title := ""
	if svc.PlayingNow() {
		title = svc.CurrentStationName()
	}
	tray.SetTitle(title)
}
