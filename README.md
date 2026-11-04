# Radio Desktop

桌面版网络电台播放器，[radio-cli](https://github.com/hmgle/radio-cli) 的 GUI 姊妹项目，基于 [mygo](https://github.com/egoist/mygo)（Go + 系统 WebView）构建。不需要安装 mpv / ffmpeg：AAC / MP3 使用 WebView 的 `<audio>` 播放，HLS 优先使用系统支持，不支持时使用应用内置的 hls.js；音频解码能力取决于系统 WebView。ICY 曲名由 Go 后端的边车连接解析。

## 功能

- **电台目录**：全量同步 [Radio Browser](https://www.radio-browser.info/) 目录（6 万+ 电台）到本地 SQLite，事务性发布 + 目录缩减保护（数量骤降超 25% 时拒绝发布）
- **秒级可用**：首次启动先拉取点击量 Top 1000，再后台全量同步
- **搜索与筛选**：关键词（名称/国家/语言/标签）、国家/语言/标签下拉（带计数）、最低码率、热度/票数/名称/码率/随机排序、无限滚动分页
- **播放**：候选地址回退（url_resolved → url）+ 重连退避（1s/3s/7s，60 秒窗口最多 6 次）
- **HLS 兼容**：内置 hls.js（需要系统 MediaSource 与相应音频解码支持），清单、分片与密钥经 Go HTTP 客户端加载，不要求电台提供 CORS 响应头；支持托盘与媒体键启动播放
- **ICY 曲名与封面**：边车连接解析 `StreamTitle`，实时显示正在播放的曲目；支持 `StreamArtwork` / 图片类 `StreamUrl`（Live365 DAS 等）/ `icy-cover` 响应头下发的曲目封面，播放器栏优先显示封面、无封面回退台标（favicon）
- **收藏 / 播放历史**（保留最近 1000 条）/ 自定义电台 / 直接播放流链接
- **会话恢复**：记忆音量与上次电台，启动后一键续播
- **系统集成**：Now Playing（控制中心/锁屏，含曲目封面）+ 媒体键播放/暂停；托盘常驻且菜单随播放动态更新（macOS 播放时图标旁显示电台名）；中文应用菜单栏
- **播放淡入淡出**：暂停 180ms 淡出、起播/切台 260ms 淡入
- **Now Playing 大图浮层**：点击播放器栏展开大封面视图
- **键盘**：空格播放/暂停、↑↓/Enter 选择播放、Cmd+F 聚焦搜索；窗口标题随播放更新
- 深浅色跟随系统

## 开发

```sh
bun install          # 前端依赖（需要 Go 1.27+ 与 Bun）
bun run dev          # 启动开发窗口（热更新）
```

```sh
CGO_ENABLED=0 go test ./internal/...    # 后端单测
RADIO_LIVE=1 go test -run Live ./internal/directory  # 真实 API 冒烟
RADIO_LIVE=1 RADIO_LIVE_URL=https://example.com/stream go test -run Live ./internal/icy  # ICY 流冒烟
bun run test         # 前端播放状态、HLS 网络加载与界面行为测试（vitest）
bun run typecheck    # 前端类型检查
RADIO_AUDIO_TEST=1 CGO_ENABLED=0 go test ./internal/audio  # Linux 音量隔离配置检查
uv run --no-project tools/test-audio-isolation.py  # Linux 真实 WebView 音频隔离回归
uv run --no-project tools/test-audio-isolation.py --server pulseaudio  # 普通 PulseAudio 对照
```

## 构建

```sh
bun run build                              # 当前平台（macOS 产出 .app 与 .dmg）
go tool mygo build -platform linux/amd64   # 交叉编译 Linux
```

Linux 产物在 `build/linux-amd64/`：可执行文件、`.desktop`、tar.gz（含用户级 `install.sh`）和 `.deb`。Linux 需要 WebKitGTK 4.1、GTK 3 和 libpulse；`.deb` 和 `install.sh` 已声明这些依赖。手动安装依赖：

```sh
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libpulse0
# Fedora
sudo dnf install webkit2gtk4.1 gtk3 pulseaudio-libs
```

Linux 为 WebKit 的 PulseAudio 客户端设置独立的音量恢复标识，并让 WirePlumber 跳过该客户端的音量保存和恢复。应用音量仍由自己的设置管理，淡入淡出、暂停、零音量或异常退出不会再覆盖共享的 Music 角色音量，避免影响 mpv 等播放器。该设置仅作用于本应用及其 WebView 子进程。

真实音频回归需要 Go、Bun、FFmpeg、mpv、PipeWire、WirePlumber 0.5+、`pactl` / `parec`、`dbus-daemon` 和图形会话（无显示器时使用 `xvfb-run`）。测试会创建独立的音频服务、状态目录和虚拟声卡，使用本地生成的音频验证 MP3、AAC、HLS、暂停、零音量及异常退出，不连接物理声卡或公网电台。

数据目录：macOS `~/Library/Application Support/radio-desktop/`，Linux `~/.config/radio-desktop/`（内含 `radio.db`）。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  前端 React + TS + Tailwind        Go 后端（mygo 类型化 IPC）│
│  ┌──────────────────────────┐    ┌───────────────────────┐ │
│  │ 列表/搜索/筛选/收藏/历史   │◄──►│ Service (internal/app)│ │
│  │ 播放器栏（音量/暂停/曲名） │    │ ├ directory 目录同步   │ │
│  │ <audio>/hls.js + 候选回退 │    │ ├ store     SQLite    │ │
│  └──────────────────────────┘    │ └ icy       曲名边车   │ │
│                                  └───────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

- **internal/store**：SQLite（modernc.org/sqlite 纯 Go 驱动）。stations 表存完整 JSON + 归一化查询列，语言/标签拆关联表做精确匹配；收藏/历史/meta；发布采用 radio-cli 的事务模式（旧目录置 inactive 而非删除，收藏引用不丢）
- **internal/directory**：Radio Browser 客户端——服务器发现与故障转移、bootstrap（clickcount Top 1000）、全量分页同步（order=name，页大小 1000，上限 20 万行）、起播点击上报
- **internal/icy**：与 `<audio>` 并行的辅助 HTTP 连接（`Icy-MetaData: 1`），按 `icy-metaint` 解析整个元数据块（`StreamTitle` / `StreamArtwork` / `StreamUrl`），30 秒空闲看门狗 + 指数退避重连，曲名或封面变化时推送给前端
- **src/player.ts**：`<audio>` 生命周期与回退重试（对齐 radio-cli PlaybackController 的预算策略）
- **src/hls.ts / src/hls-loader.ts**：按需加载 hls.js，使用 MyGo fetch 插件通过 Go 请求 HLS 资源，处理重定向、Range、超时与取消；切台、重试和停止时销毁旧播放实例

与 radio-cli 的差异：播放使用 WebView `<audio>` / 内置 hls.js + Go ICY 边车，无需安装外部播放器。MyGo 的页面配置允许有声自动播放并关闭后台节流，支持异步 IPC 后及隐藏窗口中的起播；恢复上次电台时仍需用户主动点击播放。借鉴 mygo-cloudmusic 的 Now Playing/媒体键、托盘动态菜单、播放淡入淡出与行为测试等。录音（ffmpeg 流复制）计划在后续版本加入。
