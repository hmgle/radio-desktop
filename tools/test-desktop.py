#!/usr/bin/env python3
"""Test native menus, WebView settings and persistence on Linux.

Run: uv run --no-project tools/test-desktop.py
Requires Go, Bun, WebKitGTK 4.1, GTK 3, libpulse and a display (or xvfb-run).
The debug build uses radio_e2e; all app data and sockets are temporary.
"""

import base64
import http.server
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import wave


REPO = Path(__file__).resolve().parents[1]


class OfflineProxy(http.server.BaseHTTPRequestHandler):
    native_requests = 0

    def do_GET(self):
        if self.path == "http://media.invalid/native.wav":
            if self.headers.get("Icy-MetaData") != "1":
                type(self).native_requests += 1
            output = io.BytesIO()
            with wave.open(output, "wb") as audio:
                audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                audio.writeframes(bytes(8000 * 2 * 20))
            payload = output.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("icy-cover", "http://media.invalid/cover.png")
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "http://media.invalid/cover.png":
            payload = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==")
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(503, "External requests disabled during desktop test")

    do_CONNECT = do_GET

    def log_message(self, *_args):
        pass


class Desktop:
    def __init__(self, binary, root, env, launch):
        self.path = root / "automation.sock"
        self.log_path = root / f"app-{launch}.log"
        self.log = self.log_path.open("wb")
        self.process = subprocess.Popen([binary], cwd=REPO, env=env,
                                        stdout=self.log, stderr=subprocess.STDOUT)
        self.connection = None
        self.stream = None

    def wait(self, check, label):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"App exited with {self.process.returncode}: {label}")
            if check():
                return
            time.sleep(0.05)
        raise RuntimeError("Timed out: " + label)

    def connect(self):
        def attempt():
            connection = socket.socket(socket.AF_UNIX)
            connection.settimeout(10)
            try:
                connection.connect(str(self.path))
            except (FileNotFoundError, ConnectionRefusedError):
                connection.close()
                return False
            self.connection = connection
            self.stream = connection.makefile("rwb")
            return True

        self.wait(attempt, "automation socket")
        self.wait(lambda: bool(self.call("windows")["windows"]), "native window")
        self.call("idle", {"timeout": 15000})
        self.wait(lambda: self.eval("!!document.querySelector('.sidebar-settings')"), "React startup")
        # Restored volume proves init has installed its event listeners and
        # completed the native status call; DOM mounting alone is too early.
        self.wait(lambda: self.eval("document.querySelector('input[type=range]')?.value === '37'"), "startup preferences")

    def call(self, method, params=None):
        request = {"id": 1, "method": method}
        if params is not None:
            request["params"] = params
        self.stream.write(json.dumps(request).encode() + b"\n")
        self.stream.flush()
        line = self.stream.readline()
        if not line:
            raise ConnectionError("Automation connection closed")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response["result"]

    def eval(self, script):
        return self.call("eval", {"script": script})["value"]

    def menu(self, label):
        self.call("menu", {"path": ["radio-desktop", label]})

    def control(self, label):
        return f'document.querySelector(\'select[aria-label="{label}"]\')'

    def settings(self, label, theme_label, theme):
        self.menu(label)
        control = self.control(theme_label)
        self.wait(lambda: self.eval(f"!!{control} && !{control}.closest('fieldset').disabled"), "settings ready")
        actual = self.eval(f"{control}.value")
        if actual != theme:
            raise AssertionError(f"Expected {theme} theme, got {actual}")

    def choose(self, label, value):
        control = self.control(label)
        self.eval(f"const select = {control}; select.value = {json.dumps(value)}; "
                  "select.dispatchEvent(new Event('change', {bubbles: true})); true")

    def fill(self, label, value):
        self.eval(f"const input = document.querySelector('input[aria-label={json.dumps(label)}]'); "
                  "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, "
                  f"{json.dumps(value)}); input.dispatchEvent(new Event('input', {{bubbles: true}})); true")

    def quit(self):
        # Linux's native Quit role uses the active MyGo locale.
        try:
            self.menu("退出")
        except ConnectionError:
            pass  # quitting may close the socket before the reply is sent
        code = self.process.wait(timeout=10)
        if code != 0:
            raise RuntimeError(f"App quit with {code}")

    def close(self):
        if self.stream:
            self.stream.close()
        if self.connection:
            self.connection.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.log.close()


def exercise(root, proxy_port):
    build_env = os.environ.copy()
    build_env["CGO_ENABLED"] = "0"
    build_env.pop("MYGO_AUTOMATION", None)
    build_env["GOFLAGS"] = build_env.get("GOFLAGS", "") + " -tags=radio_e2e"
    subprocess.run(["go", "tool", "mygo", "build", "-debug", "-o", str(root / "build")],
                   cwd=REPO, env=build_env, check=True)
    arch = subprocess.check_output(["go", "env", "GOARCH"], text=True).strip()
    binary = root / "build" / f"linux-{arch}" / "radio-desktop"
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("MYGO_"):
            del env[key]
    for kind in ("config", "cache", "data", "state", "runtime"):
        path = root / kind
        path.mkdir(mode=0o700)
        env[f"XDG_{kind.upper()}_HOME" if kind != "runtime" else "XDG_RUNTIME_DIR"] = str(path)
    env["MYGO_AUTOMATION"] = str(root / "automation.sock")
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env[key] = f"http://127.0.0.1:{proxy_port}"
    env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1"
    database = root / "config/radio-desktop/radio.db"
    database.parent.mkdir()
    initial = dict(version=1, language="en", appearance="system", resume="off",
                   autoSyncDays=0, closeBehavior="hide", playbackAnimations=True)
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT INTO meta VALUES (?, ?)", ("pref_settings", json.dumps(initial)))
        db.execute("INSERT INTO meta VALUES (?, ?)", ("pref_volume", "37"))

    def persisted():
        with sqlite3.connect(database) as db:
            return json.loads(db.execute("SELECT value FROM meta WHERE key='pref_settings'").fetchone()[0])

    for launch in (1, 2):
        launch_env = env.copy()
        if launch == 2:
            # A conflicting inherited proxy must not override the saved
            # manual address, including for native media and artwork.
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
                launch_env[key] = "http://127.0.0.1:1"
        app = Desktop(binary, root, launch_env, launch)
        try:
            app.connect()
            if launch == 1:
                app.settings("Settings", "Color theme", "system")
                app.choose("Proxy mode", "manual")
                app.fill("Proxy address", f"http://127.0.0.1:{proxy_port}")
                app.eval("document.querySelector('form[aria-label=\"Network proxy\"]').requestSubmit(); true")
                app.wait(lambda: persisted().get("proxyMode") == "manual", "proxy settings saved")
                app.choose("Color theme", "dark")
                app.wait(lambda: persisted()["appearance"] == "dark", "theme saved through native bridge")
                app.choose("Interface language", "zh-CN")
                app.wait(lambda: app.eval("document.documentElement.lang === 'zh-CN'"), "Chinese UI")
                app.wait(lambda: persisted()["language"] == "zh-CN", "language saved")
                # Use the translated native menu as well as translated DOM controls.
                app.settings("设置", "外观模式", "dark")
            else:
                app.settings("设置", "外观模式", "dark")
                if app.eval(f"{app.control('界面语言')}.value") != "zh-CN":
                    raise AssertionError("Language did not survive restart")
                if app.eval(f"{app.control('代理模式')}.value") != "manual":
                    raise AssertionError("Proxy mode did not survive restart")
                if app.eval("document.querySelector('input[aria-label=\"代理地址\"]').value") != f"http://127.0.0.1:{proxy_port}":
                    raise AssertionError("Proxy address did not survive restart")
                if capture := os.environ.get("RADIO_DESKTOP_CAPTURE"):
                    app.eval("document.querySelector('form[aria-label=\"网络代理\"]').scrollIntoView(); true")
                    app.call("idle")
                    Path(capture).write_bytes(base64.b64decode(app.call("capture")["png"]))
                # Verify a real native media request, with a muted element
                # and synthetic content. The destination cannot resolve
                # without this local proxy serving it.
                app.eval("const original = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function() { "
                         "this.muted = true; window.__testNativeMediaURL = this.src; return original.call(this); }; "
                         "document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'l', ctrlKey: true, bubbles: true})); true")
                app.wait(lambda: app.eval("!!document.querySelector('input[aria-label=\"流地址\"]')"), "URL dialog")
                app.fill("流地址", "http://media.invalid/native.wav")
                app.eval("document.querySelector('input[aria-label=\"流地址\"]').form.requestSubmit(); true")
                app.wait(lambda: app.eval("window.__testNativeMediaURL?.startsWith('http://127.0.0.1:')"), "native audio uses relay")
                app.wait(lambda: OfflineProxy.native_requests > 0, "native request reached the selected proxy")
                app.wait(lambda: app.eval("!!document.querySelector('footer img')?.naturalWidth"), "cover loaded through proxy")
            if not app.eval("matchMedia('(prefers-color-scheme: dark)').matches"):
                raise AssertionError("Native theme did not reach the WebView")
            app.quit()
        except Exception:
            print(app.log_path.read_text(errors="replace"), file=sys.stderr)
            try:
                print(app.eval("document.body.innerText"), file=sys.stderr)
            except Exception:
                pass
            raise
        finally:
            app.close()
    print("PASS: native menus, settings persistence, manual proxy, native audio routing and cover image")


def main():
    if sys.platform != "linux":
        raise RuntimeError("This pilot isolates Linux XDG paths; other platforms are not supported yet")
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise RuntimeError("A display is required; run under xvfb-run in CI")
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), OfflineProxy) as proxy:
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(prefix="radio-e2e-", dir="/tmp") as temporary:
                exercise(Path(temporary), proxy.server_port)
        finally:
            proxy.shutdown()


if __name__ == "__main__":
    main()
