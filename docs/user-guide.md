# User guide

[简体中文](user-guide.zh-CN.md) · [Back to README](../README.md)

## Browse and listen

On first launch, Radio Desktop downloads a small popular-station catalog, then syncs the full Radio Browser directory in the background. The station count changes as the directory changes. Use **Update catalog** to retry if the first download fails. Once cached, you can browse the catalog without a network connection; audio playback still requires one.

Search matches names, countries, languages, and tags. Combine it with country, language, tag, and minimum bitrate filters. Dropdowns have their own search fields. Use **Reset** or **Clear search and filters** to remove restrictions. Scroll to load more stations.

The country dropdown accepts code, catalog-name, or Simplified Chinese-name
prefixes, including a single character. For example, `中` finds locally available
entries such as China and the Central African Republic; `中国` narrows the list
further. Common short names `香港` and `澳门` also match Hong Kong and Macao,
including single-character prefixes `香` and `澳`. Select a result to apply its
country code. Chinese-name matching works
in either interface language. In the Chinese interface, candidates and the
selected filter show Chinese names with codes, such as `中国 (CN)`; switching
languages updates both. The English interface uses catalog names, as does the
Chinese interface for unrecognized codes. Station counts and saved station
metadata retain their original values. Language and tag dropdowns match their
catalog-value prefixes.

Click a station to play it. The bottom bar has play/pause, stop, favorite, and volume controls. Click the artwork or station information to expand station details. Track titles and artwork appear only when the broadcaster supplies compatible metadata; missing artwork does not mean playback has failed.

**Play URL** previews an HTTP(S) stream without saving it. Use a direct audio or HLS URL, rather than a station's website. **Add station** saves a name, stream URL, and optional homepage to **My stations**. Temporary URL previews cannot be favorited; save them as a custom station first. Deleting a custom station removes its saved entry.

## Favorites, history, and settings

Use the heart beside a station or in the player bar to toggle favorites. **Recently played** keeps up to 1,000 listening records. In Settings, **Clear listening history** removes these records after confirmation; favorites, custom stations, and current playback remain.

Settings persist locally. Network proxy changes require fully quitting and reopening the app; other settings apply immediately:

| Setting | Behavior |
| --- | --- |
| Interface language | English, Simplified Chinese, or system language; also updates menus and tray |
| Color theme | Light, dark, or system |
| Playback animation | Enabled by default; disable to reduce CPU use |
| On startup | Start fresh, restore selection (default), or restore and play; volume is always remembered |
| Update interval | Check catalog age at startup; default 7 days; 0 disables automatic updates, except the initial catalog download |
| Closing the window | Hide and keep playing (default), or quit |
| Network proxy | Automatic (default), manual proxy, or direct; restart after applying changes |

The sleep timer stops playback at the deadline, including after switching stations. It resets when you quit the app.

Closing a window usually leaves playback running. Use the tray to reopen it, control playback, or quit. If the desktop has no usable tray, the app quits on close. Media key and Now Playing availability varies by platform and desktop environment.

After the system wakes or the network returns, an active or connecting station retries with the usual delay and candidate URL limits. Recovery signals do not restart paused, stopped, or failed playback. If retries are exhausted, click Play to try again; a network connection does not guarantee that a station is reachable.

## Keyboard shortcuts

Use **Cmd** on macOS and **Ctrl** on Linux and Windows.

| Shortcut | Action |
| --- | --- |
| Space | Play/pause in the station view, outside interactive controls |
| ↑ / ↓, Enter | Select a station, then play the selection |
| Cmd/Ctrl+F | Return to the station view and focus search |
| Cmd/Ctrl+N | Add a custom station |
| Cmd/Ctrl+L | Play a URL |
| Cmd/Ctrl+, | Open Settings |
| Esc | Close a dialog, station details, or Settings |

Filter dropdowns support arrow keys, Home/End, Enter, and Esc. Shortcuts can be intercepted by the OS or desktop environment.

## Network and local data

No Radio Desktop account is required. The app stores the catalog, favorites, custom stations, listening history, volume, and preferences in a local SQLite database, `radio.db`:

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/radio-desktop/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/radio-desktop/` |
| Windows | `%APPDATA%\radio-desktop\` |

To back up or restore, **quit the app completely** and copy the entire directory, including any `radio.db-wal` and `radio.db-shm` files that remain. Hiding the window is not quitting. There is currently no built-in import/export or cloud synchronization.

Network connections include Radio Browser server discovery and catalog downloads, a Radio Browser click report when a directory station starts playing, station audio streams, an extra ICY metadata connection where applicable, and station/track artwork requests. HLS resources loaded by hls.js are requested through the Go backend. Those services can see your IP address and their requested resources. Browsing the cached catalog is local. Some streams use unencrypted HTTP.

Station data is maintained by Radio Browser contributors; availability, metadata accuracy, and broadcast rights are controlled by the relevant providers.

To update the app, quit it and install the newer package for the same platform and architecture from [GitHub Releases](https://github.com/hmgle/radio-desktop/releases/latest). Use your package manager for Linux `.deb` installations. Normal upgrades keep the data directory above; back it up first if needed. There is no in-app updater yet.

### Network proxies

Choose a mode in **Settings → Network** and select **Apply**. **Fully quit and reopen the app after changing it**; closing the window may only hide it to the tray. Automatic is the default, and unrestricted connections need no configuration.

| Mode | Behavior |
| --- | --- |
| Automatic | Follow system proxy settings; Go requests give explicit proxy environment variables precedence |
| Manual proxy | Use the specified proxy for the catalog, playback, images, and track information, overriding system and environment proxies; a failed proxy does not fall back to direct |
| Direct connection | Use no application proxy for those requests; system routing, firewalls, and VPN policies still apply |

Manual addresses support `http://`, `https://`, `socks5://`, and `socks5h://` with a port, for example `http://proxy.example:8080`. An HTTP proxy also carries HTTPS stations using CONNECT; SOCKS5 resolves station hostnames at the proxy. Manual proxy usernames, passwords, and PAC addresses are not currently supported. Use Automatic with operating system settings for automatic proxy configuration. Addresses are stored in local preferences; remove private proxy addresses before sharing diagnostics.

In Automatic mode, Go requests read `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (lowercase forms also work), always bypassing proxies for loopback addresses. Do not set only `ALL_PROXY`. Desktop launches may not inherit terminal variables. Ordinary audio, native HLS, and interface images use system WebView or media components, whose automatic proxy behavior varies by platform; environment configuration alone does not guarantee they use the same proxy. Use Manual when the app needs one explicit proxy across those requests. Station homepages opened in your default browser follow that browser's settings.

Manual and Direct modes support ordinary audio, standard HLS playlists and their segments, keys, and artwork. Identified HLS streams prefer hls.js when supported, otherwise using native HLS; both follow the selected network mode. Some advanced playlists require hls.js and a compatible system decoder. Unsupported streams fail without bypassing the specified proxy. In Automatic mode, system proxy changes may be cached for about five seconds; reconnect existing streams. If only some stations fail, check proxy rules, exit region, and broadcaster region restrictions.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Empty catalog | Check connectivity, choose Update catalog, and clear search/filters. Expand error details if shown. |
| One station fails | Try another station or the broadcaster's current direct stream. URLs change, and some streams are region restricted. |
| Many streams fail | Check volume and output device, system WebView codecs, and network access. A web page URL is not an audio stream. |
| HLS fails | The WebView needs native HLS or MediaSource plus a compatible codec. Bundled hls.js cannot supply missing decoders. |
| Linux app does not start | Install WebKitGTK 4.1, GTK 3, and libpulse; run from a terminal for diagnostics. Use a graphical session. |
| Linux MP3/AAC unavailable | Check your distribution's GStreamer codec packages (often plugins-good, plugins-bad, and libav). Package names and availability vary. |
| Closing does not stop audio | Default close behavior hides to tray. Choose Quit, or change the close behavior in Settings. |
| No tray or media controls | Check desktop support and extensions for tray icons/MPRIS; support differs across environments. |
| High CPU while playing | Disable Playback animation in Settings; test another stream format. |
| Catalog update rejected | The app retains the old catalog if the new one unexpectedly shrinks by more than 25%; retry later. |

For a bug report, include OS/architecture, app version, steps, and relevant error details. Remove tokens, private stream URLs, and personal data from logs. See [contributing](../CONTRIBUTING.md).
