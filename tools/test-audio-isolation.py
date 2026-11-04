#!/usr/bin/env python3
"""Exercise the real player/WebView against a private, silent audio server.

Run with: uv run --no-project tools/test-audio-isolation.py
Requires Linux, a display (or xvfb-run), Bun, Go, PipeWire, WirePlumber 0.5+,
pactl/parec, dbus-daemon, mpv, FFmpeg and the app's runtime libraries.
All media is generated locally; no public stations or physical sinks are used.
"""

import argparse
import array
from collections import deque
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import queue
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import wave


REPO = Path(__file__).resolve().parents[1]
MUSIC = "Output/Audio:media.role:Music"


def wait_for(check, label, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise RuntimeError("Timed out: " + label)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", choices=("pipewire", "pulseaudio"), default="pipewire")
    audio_server = parser.parse_args().server
    dependencies = ("pipewire", "wireplumber", "pipewire-pulse") if audio_server == "pipewire" else ("pulseaudio",)
    for command in ("go", "bun", "pactl", "parec", "dbus-daemon", "mpv", "ffmpeg", *dependencies):
        if not shutil.which(command):
            raise RuntimeError("Missing test dependency: " + command)
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise RuntimeError("A display is required; run under xvfb-run in CI")
    real_state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "wireplumber/stream-properties"
    before = digest(real_state)
    with tempfile.TemporaryDirectory(prefix="radio-audio-", dir="/tmp") as temporary:
        root = Path(temporary)
        try:
            exercise(root, audio_server)
        finally:
            if digest(real_state) != before:
                raise RuntimeError("The user's WirePlumber state changed during the test")
    print("PASS: real WirePlumber state unchanged")


def exercise(root, audio_server):
    for name in ("runtime", "config", "state", "cache", "data", "frontend", "media"):
        (root / name).mkdir(mode=0o700)
    state = root / "state/wireplumber/stream-properties"
    state.parent.mkdir()
    saved_music = {"channelMap": ["FL", "FR"], "mute": False,
                   "volume": 1.0, "channelVolumes": [0.37, 0.37]}
    state.write_text("[stream-properties]\n" + MUSIC + "=" + json.dumps(saved_music) + "\n")
    env = os.environ.copy()
    for name in ("PULSE_SINK", "PULSE_SOURCE", "PULSE_CLIENTCONFIG", "PIPEWIRE_CONFIG_DIR",
                 "PIPEWIRE_CONFIG_NAME", "WIREPLUMBER_CONFIG_DIR", "MYGO_DEV_URL",
                 "MYGO_GENERATE", "GST_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH",
                 "GST_PLUGIN_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_REGISTRY_1_0"):
        env.pop(name, None)
    env.update({
        "XDG_RUNTIME_DIR": str(root / "runtime"),
        "PIPEWIRE_RUNTIME_DIR": str(root / "runtime"), "PIPEWIRE_REMOTE": "pipewire-0",
        "PULSE_SERVER": "unix:" + str(root / "runtime/pulse/native"),
        "XDG_CONFIG_HOME": str(root / "config"), "XDG_STATE_HOME": str(root / "state"),
        "XDG_CACHE_HOME": str(root / "cache"), "XDG_DATA_HOME": str(root / "data"),
        "WEBKIT_GST_ENABLE_AUDIO_MIXER": "0", "CGO_ENABLED": "0",
        "PULSE_PROP_OVERRIDE": 'application.name="Isolated Radio" state.restore-props=true',
        "RADIO_AUDIO_TEST_FRONTEND": str(root / "frontend"), "NO_AT_BRIDGE": "1",
        "DBUS_SESSION_BUS_ADDRESS": "unix:path=" + str(root / "runtime/bus"),
    })
    # Only the policy profile is loaded: no ALSA/Bluetooth device discovery.
    processes, logs = [], []

    def run(args, **kwargs):
        return subprocess.run(args, env=env, cwd=REPO, text=True, capture_output=True,
                              timeout=120, check=True, **kwargs)

    def spawn(args, name, protocol=False):
        log = (root / (name + ".log")).open("w+")
        logs.append((name, log))
        process = subprocess.Popen(args, env=env, cwd=REPO, start_new_session=True,
                                   stdin=subprocess.PIPE if protocol else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE if protocol else log, stderr=log,
                                   text=protocol, bufsize=1 if protocol else -1)
        processes.append(process)
        return process

    def stop(process, sig=signal.SIGTERM):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)

    def pactl(*args):
        return run(["pactl", *args]).stdout

    def streams():
        return json.loads(pactl("--format=json", "list", "sink-inputs"))

    def check_stream():
        rows = streams()
        if not rows:
            return False
        assert len(rows) == 1, rows
        row = rows[0]
        assert row["properties"].get("state.restore-props") == "false", row
        assert row["properties"].get("application.name") == "Isolated Radio", row
        if audio_server == "pulseaudio":
            assert row["properties"].get("module-stream-restore.id") == "sink-input-by-application-id:com.hmgle.radio-desktop", row
        assert not row["mute"], row
        return True

    def mpv_volume(label):
        ipc = root / (label + ".sock")
        # These overrides belong to the WebView test client, not mpv.
        overrides = env.pop("PULSE_PROP_OVERRIDE", None)
        ao = "pipewire" if audio_server == "pipewire" else "pulse"
        process = spawn(["mpv", "--no-config", "--ao=" + ao,
                         "--audio-device=" + ao + "/radio_isolation", "--no-video",
                         "--loop-file=inf", "--input-ipc-server=" + str(ipc),
                         str(root / "media/tone.wav")], label)
        if overrides is not None:
            env["PULSE_PROP_OVERRIDE"] = overrides
        try:
            wait_for(ipc.exists, "mpv IPC")
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(5)
                connection.connect(str(ipc))
                messages = connection.makefile("r")

                def property_value(name):
                    connection.sendall((json.dumps({"command": ["get_property", name], "request_id": 1}) + "\n").encode())
                    for line in messages:
                        reply = json.loads(line)
                        if reply.get("request_id") == 1:
                            return reply.get("data")

                wait_for(lambda: property_value("current-ao") == ao, "mpv audio output")
                def stream_volume():
                    value = property_value("ao-volume")
                    return (value,) if value is not None else None

                volume = wait_for(stream_volume, "mpv stream volume")[0]
                assert property_value("ao-mute") is False
                return volume
        finally:
            stop(process)

    server = None
    try:
        # Build before starting services; compilation doesn't need native audio.
        subprocess.run(["go", "test", "-c", "-o", str(root / "audio.test"), "./internal/audio"],
                       env=os.environ | {"CGO_ENABLED": "0"}, cwd=REPO, check=True, timeout=120)
        entry = root / "entry.ts"
        entry.write_text("import { player } from " + json.dumps(str(REPO / "src/player.ts")) + ";window.player=player;window.nativeCanPlayType=player.audio.canPlayType.bind(player.audio);\n")
        run(["bun", "build", str(entry), "--outdir", str(root / "frontend"), "--target", "browser", "--splitting"])
        (root / "frontend/index.html").write_text('<script type="module" src="/entry.js"></script>')
        with wave.open(str(root / "media/tone.wav"), "wb") as output:
            output.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
            samples = array.array("h", (int(6000 * math.sin(2 * math.pi * 440 * n / 48000))
                                       for n in range(48000) for _ in range(2)))
            output.writeframes(samples.tobytes() * 30)
        for name, options in (("tone.mp3", ["-c:a", "libmp3lame"]),
                              ("tone.aac", ["-c:a", "aac"]),
                              ("tone.m3u8", ["-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0"])):
            run(["ffmpeg", "-v", "error", "-i", str(root / "media/tone.wav"), *options,
                 str(root / "media" / name)])

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=root / "media", **kwargs)

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        spawn(["dbus-daemon", "--session", "--nofork", "--address=" + env["DBUS_SESSION_BUS_ADDRESS"]], "dbus")
        wait_for(lambda: (root / "runtime/bus").exists(), "private session bus")
        if audio_server == "pipewire":
            spawn(["pipewire"], "pipewire")
            wait_for(lambda: (root / "runtime/pipewire-0").exists(), "private PipeWire socket")
            spawn(["wireplumber", "--profile=policy"], "wireplumber")
            spawn(["pipewire-pulse"], "pulse")
        else:
            config = root / "pulse.conf"
            (root / "runtime/pulse").mkdir(mode=0o700)
            config.write_text("load-module module-native-protocol-unix socket=" +
                              str(root / "runtime/pulse/native") + " auth-anonymous=1\n" +
                              "load-module module-stream-restore\n")
            spawn(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1",
                   "--use-pid-file=no", "--file=" + str(config)], "pulse")
        wait_for(lambda: (root / "runtime/pulse/native").exists(), "private Pulse socket")
        pactl("load-module", "module-null-sink", "sink_name=radio_isolation")
        pactl("set-default-sink", "radio_isolation")
        sinks = json.loads(pactl("--format=json", "list", "sinks"))
        assert all(s["name"] in ("radio_isolation", "auto_null") for s in sinks), sinks
        initial_volume = mpv_volume("mpv_before")

        capture = spawn(["parec", "--device=radio_isolation.monitor", "--format=float32le",
                         "--rate=48000", "--channels=2", "--latency-msec=20"], "capture", True)
        # parec's output is binary rather than the driver's line protocol.
        levels = deque(maxlen=8)

        def sample():
            while block := capture.stdout.buffer.read(3840):
                values = array.array("f")
                values.frombytes(block)
                levels.append(math.sqrt(sum(x * x for x in values) / len(values)))

        threading.Thread(target=sample, daemon=True).start()
        browser = spawn([str(root / "audio.test"),
                         "-test.run=^$"], "webview", True)
        replies = queue.Queue()

        def read_replies():
            for line in browser.stdout:
                if line.startswith('{"audioCheck"'):
                    replies.put(json.loads(line))
                else:
                    print("WEBVIEW:", line.rstrip(), flush=True)
            replies.put({"error": "WebView driver exited", "code": browser.wait()})

        threading.Thread(target=read_replies, daemon=True).start()
        ready = replies.get(timeout=25)
        assert ready.get("audioCheck") == "ready", ready

        def evaluate(script):
            browser.stdin.write(json.dumps("(async()=>{" + script + "})()") + "\n")
            browser.stdin.flush()
            reply = replies.get(timeout=10)
            assert "error" not in reply, reply
            return reply["value"]

        def play(name, force_mse=False):
            url = f"http://127.0.0.1:{server.server_port}/{name}"
            evaluate("player.stop(); player.setVolume(80);" +
                     ("player.audio.canPlayType=()=>'';" if force_mse else "player.audio.canPlayType=window.nativeCanPlayType;") +
                     "player.play({sessionId:1,station:{stationuuid:'',name:'Test',hls:0},candidates:[" + json.dumps(url) + "]}); return true")
            wait_for(lambda: evaluate("return player.state==='playing' && player.audio.currentTime>0.5"), name)
            wait_for(check_stream, "isolated stream volume state")
            wait_for(lambda: levels and min(levels) > 0.01, "audible software output")
            print("PASS: playback and volume isolation:", name, "MSE" if force_mse else "native")

        for name in ("tone.mp3", "tone.aac", "tone.mp3"):
            play(name)
        play("tone.m3u8", force_mse=True)
        play("tone.m3u8")
        evaluate("player.toggle(); return true")
        # WebKit can report a stale HTML volume after a PulseAudio volume
        # callback. Verify pause and captured silence, not that JS feedback.
        wait_for(lambda: evaluate("return player.state==='paused' && player.audio.paused"), "pause fade")
        wait_for(lambda: levels and max(levels) < 0.0001, "silent pause")
        check_stream()
        evaluate("player.toggle(); return true")
        wait_for(lambda: evaluate("return player.state==='playing' && player.level===1"), "resume fade")
        wait_for(lambda: levels and min(levels) > 0.01, "audible resume")
        evaluate("player.setVolume(0); return true")
        wait_for(lambda: levels and max(levels) < 0.0001, "silent zero volume")
        check_stream()
        evaluate("player.setVolume(80); return true")
        wait_for(lambda: levels and min(levels) > 0.01, "restore application volume")
        evaluate("player.stop(); return true")
        wait_for(lambda: levels and max(levels) < 0.0001, "silent stop")
        print("PASS: pause, resume, zero volume, restore, stop")
        # Freeze at the very start of a fade, then kill the entire WebView
        # group. No cleanup/volume restoration can mask the original bug.
        evaluate("window.requestAnimationFrame=()=>0; return true")
        url = f"http://127.0.0.1:{server.server_port}/tone.wav"
        evaluate("player.play({sessionId:2,station:{stationuuid:'',name:'Interrupted fade',hls:0},candidates:[" + json.dumps(url) + "]}); return true")
        wait_for(lambda: evaluate("return player.state==='playing' && player.level===0"), "interrupted fade")
        wait_for(check_stream, "system volume during interrupted fade")
        rows = streams()
        assert rows and all(v["value"] == 0 for row in rows for v in row["volume"].values()), rows
        stop(browser, signal.SIGKILL)
        wait_for(lambda: not streams(), "crashed WebView stream teardown")
        final_volume = mpv_volume("mpv_after")
        assert abs(final_volume - initial_volume) < 0.01, (initial_volume, final_volume)
        time.sleep(1.5)  # WirePlumber debounces state saves.
        if audio_server == "pipewire":
            music = [json.loads(line.split("=", 1)[1]) for line in state.read_text().splitlines()
                     if line.startswith(MUSIC + "=")]
            assert music == [saved_music], music
        print(f"PASS: {audio_server}: crash during zero fade; mpv volume {initial_volume:.2f} -> {final_volume:.2f}")
    except BaseException:
        for name, log in logs:
            log.flush()
            log.seek(0)
            print("LOG", name, log.read()[-4000:])
        raise
    finally:
        for process in reversed(processes):
            stop(process)
        if server:
            server.shutdown()
            server.server_close()
        for _, log in logs:
            log.close()


if __name__ == "__main__":
    main()
