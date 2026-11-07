# Development and packaging

[README](../README.md) · [Contributing](../CONTRIBUTING.md)

## Prerequisites

- Go 1.27.3 or newer (the minimum is recorded in `go.mod`).
- Bun 1.4.2, matching CI, and Node.js 24 for the Node-based test environment.
- Windows x64: Microsoft Edge [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Install the Evergreen Runtime if missing; it is not bundled with the app. MyGo downloads NSIS when needed for native Windows builds.
- macOS: Xcode Command Line Tools. Linux: WebKitGTK 4.1, GTK 3, and libpulse runtime libraries; see the README for install commands.

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev:web` starts Vite alone. It is useful for frontend work, but the ordinary browser does not supply the native MyGo service bridge; use `bun run dev` for full functionality. Frontend assets are bundled into desktop builds.

## Checks

```sh
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
go tool mygo vet .
bun run test
bun run build:web
```

Format Go with `gofmt`. `bun run build:web` type-checks TypeScript and builds the frontend; `bun run typecheck` can be run separately. When changing exposed Go APIs, run `bun run generate` and commit `src/mygo.ts` with the API change. Generated locale accessors must also stay consistent with `locales/*.json`.

Optional network tests (excluded from ordinary offline checks):

```sh
RADIO_LIVE=1 go test -run Live ./internal/directory
RADIO_LIVE=1 RADIO_LIVE_URL=https://example.com/stream go test -run Live ./internal/icy
```

Replace the example stream with a real test URL. These tests contact external services.

The offline backend tests also verify environment proxy routing through a local server, including catalog requests, click reports, ICY metadata, artwork, loopback bypass, and proxy errors. On Linux with the GIO GNOME proxy resolver and GSettings schemas installed, also verify system proxy routing:

```sh
RADIO_SYSTEM_PROXY_TEST=1 CGO_ENABLED=0 go test -run '^TestProxyRouting$' -v ./internal/app
```

This uses a private GSettings keyfile and fresh subprocesses; it does not change desktop settings or contact external servers. The test uses an unresolvable destination served by the local proxy, so successful internet access cannot hide requests bypassing that proxy. Native WebView playback and macOS/Windows system proxy resolution still require platform testing.

Linux audio isolation checks:

```sh
RADIO_AUDIO_TEST=1 CGO_ENABLED=0 go test ./internal/audio
uv run --no-project tools/test-audio-isolation.py
uv run --no-project tools/test-audio-isolation.py --server pulseaudio
```

The real WebView regression requires a graphical session (or `xvfb-run`), Go, Bun, FFmpeg, mpv, PipeWire, WirePlumber 0.5+, `pactl`/`parec`, and `dbus-daemon`. PulseAudio is needed for the second variant. It starts private audio services and uses generated local media and a virtual sink; it does not need public radio streams or a physical sound card. Linux playback assigns an application-specific volume restoration identity to avoid overwriting other players' saved Music-role volumes.

Linux desktop smoke test:

```sh
uv run --no-project tools/test-desktop.py
# On a headless Linux machine with Xvfb and D-Bus installed:
dbus-run-session -- xvfb-run -a uv run --no-project tools/test-desktop.py
```

This builds the app with the `radio_e2e` tag and the inspector enabled, then uses MyGo Automation to open settings through the native menu, change the theme and language, quit normally, and verify the preferences after restart. It needs the ordinary Linux runtime libraries, Go, Bun, uv, and a display. The test uses private temporary XDG directories and a private automation socket, and routes directory requests to a local proxy that rejects external requests. No live streams or audio services are required. Failures print app logs and page text. The test currently supports Linux; normal builds exclude the automation import.

## Packages

```sh
bun run build
# Optional: target Linux explicitly
go tool mygo build -platform linux/amd64
```

Output is placed under `build/<platform>-<architecture>/`. Cross builds require MyGo's target-specific prerequisites; native builds are the simplest starting point.

| Target | Output |
| --- | --- |
| Windows x64 | Executable and unsigned `radio-desktop-setup-<version>-amd64.exe` NSIS installer |
| macOS | `.app`, `.dmg` |
| Linux | Executable, `.desktop`, `.deb`, tarball, separate user-level `install.sh`, and `PKGBUILD` |

To install a locally built Debian/Ubuntu package, use `sudo apt install ./build/linux-amd64/radio-desktop_0.2.1_amd64.deb`. For the tarball, review the separate script and run `sh ./build/linux-amd64/install.sh ./build/linux-amd64/radio-desktop-0.2.1-linux-amd64.tar.gz`. Release downloads provide `install.sh` as its own asset; it is not inside the tarball. Use the matching architecture. macOS users can copy the app from the disk image to Applications. Locally built macOS packages are not automatically signed or notarized.

Windows installers install for the current user under `%LOCALAPPDATA%\Programs`, create a Start menu shortcut, and provide an uninstaller in Settings > Apps. Run `bun run build` on Windows to build the installer; when cross-compiling from Linux, install NSIS (`makensis`) first. Windows installation, tray behavior, media controls, and MP3/AAC/HLS playback still need a real-machine smoke test.

`mygo.json` controls the app version, identifier, packaging, extra resources, and Linux dependencies. `package.json` declares the SPDX license. Packages include `LICENSE` and `THIRD_PARTY_NOTICES.md`; the frontend also embeds the Twemoji attribution in `third-party-notices.txt`.

After updating dependencies, run `bun install --frozen-lockfile`, `go mod download`, and `uv run --no-project tools/update-notices.py` to refresh bundled license texts. Review the result for newly added components.

When distributing binaries, provide the corresponding source for that exact version under GPL-3.0, including the lockfile and build instructions, and preserve third-party license notices. Keep version metadata and release notes aligned. Packages are currently unsigned; the release workflow prepares a draft for manual review and publication.

## CI

- **Checks** runs formatting, Go vet, MyGo vet, backend tests, generated binding checks, frontend tests, and the web build on pushes and pull requests. Live network/audio playback tests are opt-in locally.
- **Desktop packages** runs on manual dispatch, with Linux, macOS, and Windows x64 builds and downloadable workflow artifacts. The Windows job also runs the backend tests and requires an NSIS installer before uploading. It uses read-only repository permissions and does not publish releases.
- **Release draft** runs on `v*` tags. The tag must equal `v` plus the version in `mygo.json`, and `CHANGELOG.md` must have a nonempty section for that version (plain or bracketed headings, with optional dates). It runs Checks and all three package builds before creating a draft containing the version's changelog notes, installers, the matching source archive, and `SHA256SUMS`. Tags containing a prerelease suffix create prerelease drafts. Reruns can replace draft assets, but refuse to change a published release. Review all packages before publishing the draft; this workflow does not sign packages or configure in-app updates.
- **Desktop smoke test** is a separate manual Linux workflow using Xvfb and a private D-Bus session. It exercises real native menus and WebView persistence without adding a graphical runtime to ordinary Checks.

## Release a version

Update `mygo.json`, the application and directory User-Agent strings, and the version section in `CHANGELOG.md`. Keep both READMEs and user guides aligned with download formats and behavior. Run the checks above and validate release metadata before committing and tagging:

```sh
go run ./tools/release -tag v0.2.1 -notes /tmp/radio-release-notes.md
git tag -a v0.2.1 -m "Radio Desktop v0.2.1"
```

Push the reviewed commit and tag to the GitHub remote. The release workflow builds Linux x86_64, macOS Apple Silicon (arm64), and Windows x64 from the same commit. Wait for it to finish, run the manual Desktop smoke test for that tag, and download the draft's assets. Check the SHA256 entries, package versions and architectures, bundled licenses, source contents, and platform runtime requirements before publishing. The source archive is generated with `git archive` from the tagged commit and includes tracked build inputs and lockfiles. It is covered by the same checksum file as the installers.

Publish the reviewed draft from GitHub or with `gh release edit v0.2.1 --draft=false --latest`. Record validation limits in the release notes, particularly unsigned macOS/Windows packages and any platform installation or playback checks that were not run. A newer package preserves the normal user-data directory; there is no in-app update mechanism yet.

## Source map

| Path | Responsibility |
| --- | --- |
| `main.go` | App lifecycle, native menus, tray, system media integration |
| `internal/app` | Bound application service, preferences, playback session metadata |
| `internal/directory` | Radio Browser discovery, failover, bootstrap, catalog synchronization |
| `internal/store` | SQLite catalog, queries, favorites, history, preferences |
| `internal/icy` | ICY track title/artwork parsing and reconnects |
| `internal/audio` | Linux application volume isolation |
| `src/` | React UI, state, WebView audio playback, hls.js loading |
| `locales/` | English and Simplified Chinese message catalogs |
| `resources/` | Application and tray artwork |

The catalog is published transactionally; an unexpected shrink greater than 25% keeps the previous catalog. Audio playback uses candidate URL fallback and bounded reconnects. ICY metadata uses a separate connection; HLS networking is routed through the Go fetch plugin to support providers without browser CORS headers.
