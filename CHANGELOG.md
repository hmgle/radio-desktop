# Changelog

## 0.1.0

首个可用版本，参考 [radio-cli](https://github.com/hmgle/radio-cli) 的核心设计、
[mygo-cloudmusic](https://github.com/egoist/mygo-cloudmusic) 的架构与交互。

### 播放与目录

- Radio Browser 目录：bootstrap 秒级可用 + 全量同步（6.3 万台），事务发布、
  缩减保护（数量骤降超 25% 拒绝发布），7 天自动后台刷新
- SQLite（modernc 纯 Go 驱动）：搜索/筛选（国家/语言/标签/码率/排序）、
  收藏、历史（保留 1000 条）、自定义电台、直接播放流链接
- `<audio>` 播流（AAC/MP3/HLS），候选地址回退 + 重连退避（1/3/7s，60s 窗口
  6 次，每条地址 3 次）
- ICY 边车连接解析曲名与曲目封面（StreamArtwork / 图片类 StreamUrl /
  icy-cover 响应头）
- 播放淡入淡出（暂停 180ms 淡出、起播/切台 260ms 淡入）
- 音量与上次电台记忆，启动一键续播

### 系统集成

- Now Playing（控制中心/锁屏）：ICY 曲名、电台、曲目封面或台标；媒体键
  播放/暂停
- 托盘常驻：菜单随播放动态更新（暂停·电台名/随机换个电台/收藏当前），
  macOS 播放时图标旁显示电台名；关闭窗口驻留托盘
- 应用菜单栏（中文）：文件/编辑（WebKit 快捷键必需的 Role）/控制/窗口
- 单实例；深浅色跟随系统

### 界面

- 侧栏来源（全部/收藏/历史/自定义）+ 搜索（200ms 防抖）+ 筛选下拉（带
  计数）+ 无限滚动列表
- 底部播放器栏：封面（曲目封面→台标→图标回退）、ICY 曲名、音量、收藏
- Now Playing 大图浮层（点击播放器栏展开）
- 键盘：空格播放/暂停、↑↓ 选择、Enter 播放、Cmd+F 聚焦搜索、Esc 关闭
- 窗口标题随播放更新

### 修复记录

- macOS ATS 拦截 http:// 流（MEDIA_ERR_SRC_NOT_SUPPORTED）：
  `NSAllowsArbitraryLoads`
- OnClose PreventDefault 拦截 App.Quit 导致无法退出：OnBeforeQuit 放行
- 'playing' 事件漏发状态转移导致界面卡在「连接中」
- 候选地址第 3 次失败即切换（原为第 4 次）
