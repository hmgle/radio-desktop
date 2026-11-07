/**
 * Behavior tests for the player state machine — the layer the UI renders
 * and the only thing allowed to touch the audio element. A missing
 * emit("playing") here once left the UI stuck on 连接中, so every
 * transition is pinned down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as nativeFetch } from "@mygo-plugins/fetch";

vi.mock("./mygo", () => ({
  Service: { reportStarted: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("./hls", () => ({ attachHls: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock("@mygo-plugins/fetch", () => ({ fetch: vi.fn() }));

// The fake element: events fire by hand, play() resolves like a
// well-behaved stream, and rAF runs its frame immediately so fades
// settle in one tick.
class FakeAudio {
  volume = 1;
  src = "";
  preload = "";
  currentSrc = "";
  currentTime = 0;
  readyState = 0;
  error: { code: number; message: string } | null = null;
  playCalls = 0;
  pauseCalls = 0;
  canPlayType = vi.fn(() => "");
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener() {}
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play() {
    this.playCalls++;
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls++;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
}

let audio: FakeAudio;
let snapshots: { state: string; station: string | null; error: string }[];

beforeEach(async () => {
  vi.useFakeTimers();
  (globalThis as Record<string, unknown>).Audio = FakeAudio;
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    cb(performance.now() + 1000); // past the end: fades finish at once
    return 0;
  };
  vi.resetModules();
  const { player: fresh } = await import("./player");
  audio = (fresh as unknown as { audio: FakeAudio }).audio;
  const { Service } = await import("./mygo");
  vi.mocked(Service.reportStarted).mockClear();
  const { attachHls } = await import("./hls");
  vi.mocked(attachHls).mockClear();
  vi.mocked(nativeFetch).mockReset().mockImplementation(async () => new Response(null, { headers: { "Content-Type": "audio/ogg" } }));
  const mod = fresh as unknown as {
    onSnapshot: ((s: { state: string; station: { name: string } | null; error: string }) => void) | null;
    play(info: { station: { stationuuid: string; name: string }; candidates: string[] }): void;
    toggle(): void;
    stop(): void;
  };
  snapshots = [];
  mod.onSnapshot = (s) => snapshots.push({ state: s.state, station: s.station?.name ?? null, error: s.error });
  // A shared handle the tests drive.
  (globalThis as Record<string, unknown>).__player = mod;
  (globalThis as Record<string, unknown>).__audio = audio;
  playerApi = mod;
});

let playerApi: any;

afterEach(() => {
  vi.useRealTimers();
});

const info = (candidates: string[]) => ({
  station: { stationuuid: "uuid-1", name: "Test FM" },
  candidates,
});

function states(): string[] {
  return snapshots.map((s) => s.state);
}

describe("player state machine", () => {
  it("uses the backend media route for native audio while preserving HLS source addresses", () => {
    const original = "https://station.example/stream";
    const native = "http://127.0.0.1:12345/synthetic/media";
    playerApi.play({ ...info([original]), nativeCandidates: [native] });
    expect(audio.src).toBe(native);
  });

  it("retries relayed native HLS failures through the original HLS loader", async () => {
    const original = "https://station.example/extensionless";
    vi.mocked(nativeFetch).mockResolvedValue(new Response(null, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
    playerApi.play({ ...info([original]), nativeCandidates: ["http://127.0.0.1:12345/synthetic/media"] });
    audio.error = { code: 2, message: "native playlist rejected" };
    audio.dispatch("error");
    await vi.advanceTimersByTimeAsync(0);
    const { attachHls } = await import("./hls");
    expect(nativeFetch).toHaveBeenCalledWith(original, expect.anything());
    expect(attachHls).toHaveBeenCalledWith(audio, original, expect.any(Function));
  });

  it("can recover successful listening sessions repeatedly without accumulating failures", async () => {
    playerApi.play(info(["https://a/1"]));
    audio.readyState = 3;
    audio.dispatch("playing");
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_001);
      playerApi.recover();
      await vi.advanceTimersByTimeAsync(1000);
      audio.dispatch("playing");
      expect(states().at(-1)).toBe("playing");
      expect(audio.src).toBe("https://a/1");
    }
    expect(audio.playCalls).toBe(5);
  });

  it("retains the sliding-window budget even when each recovery briefly plays", async () => {
    playerApi.play(info(["https://a/1", "https://a/2"]));
    audio.readyState = 3;
    audio.dispatch("playing");
    for (let i = 0; i < 7; i++) {
      playerApi.recover();
      await vi.advanceTimersByTimeAsync(7000);
      audio.dispatch("playing");
    }
    expect(audio.src).toBe("https://a/2");
    expect(states().at(-1)).toBe("playing");
  });

  it("coalesces wake/network signals into one normal retry without another play report", async () => {
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");
    playerApi.recover();
    playerApi.recover();
    expect(audio.playCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(audio.playCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.playCalls).toBe(2);
    audio.dispatch("playing");
    const { Service } = await import("./mygo");
    expect(Service.reportStarted).toHaveBeenCalledOnce();
  });

  it("keeps candidate order and stops recovery when the retry budget is exhausted", async () => {
    playerApi.play(info(["https://a/1", "https://a/2"]));
    for (let i = 0; i < 5; i++) {
      playerApi.recover();
      await vi.advanceTimersByTimeAsync(7000);
      if (i === 2) expect(audio.src).toBe("https://a/2");
    }
    expect(states().at(-1)).toBe("failed");
    const calls = audio.playCalls;
    playerApi.recover();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(audio.playCalls).toBe(calls);
  });

  it("does not recover idle, armed, or paused audio, including an unfinished pause fade", async () => {
    playerApi.recover();
    playerApi.arm(info([]).station, ["https://a/1"]);
    playerApi.recover();
    expect(audio.playCalls).toBe(0);
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    playerApi.toggle();
    playerApi.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(audio.playCalls).toBe(1);
    expect(audio.pauseCalls).toBe(1);
    expect(states().at(-1)).toBe("paused");
    vi.unstubAllGlobals();
  });

  it("cancels recovery on stop and cancels a station-switch fade on recovery", async () => {
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    playerApi.play(info(["https://b/1"]));
    playerApi.recover();
    await vi.advanceTimersByTimeAsync(220);
    expect(audio.playCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(780);
    expect(audio.playCalls).toBe(2);
    expect(audio.src).toBe("https://b/1");
    playerApi.recover();
    playerApi.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(audio.playCalls).toBe(2);
    expect(states().at(-1)).toBe("idle");
    vi.unstubAllGlobals();
  });

  it("reaches playing once the element starts, and reports the play once", async () => {
    playerApi.play(info(["https://a/1", "https://a/2"]));
    expect(states()).toEqual(["connecting"]);
    expect(audio.src).toBe("https://a/1");

    audio.dispatch("playing");
    expect(states()).toEqual(["connecting", "playing"]);
    const { Service } = await import("./mygo");
    expect(Service.reportStarted).toHaveBeenCalledWith("uuid-1");

    // Buffering resumptions re-fire 'playing' without a second report.
    audio.dispatch("playing");
    expect(Service.reportStarted).toHaveBeenCalledTimes(1);
  });

  it("starts silent and fades in when playback starts", () => {
    playerApi.setVolume(100);
    playerApi.play(info(["https://a/1"]));
    expect(audio.volume).toBe(0);
    audio.dispatch("playing");
    expect(audio.volume).toBeGreaterThan(0.9);
  });

  it("pause fades out before pausing; resume reloads the stream fresh", () => {
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");

    playerApi.toggle();
    expect(states()).toEqual(["connecting", "playing", "paused"]);
    expect(audio.pauseCalls).toBe(1);
    expect(audio.volume).toBe(0);

    audio.playCalls = 0;
    playerApi.toggle();
    expect(states().slice(-1)).toEqual(["connecting"]);
    expect(audio.playCalls).toBe(1); // src reloaded, not resumed in place
  });

  it("falling back retries with backoff, then the next candidate, then fails", () => {
    vi.useFakeTimers();
    playerApi.play(info(["https://a/1", "https://a/2"]));

    // Three failures move from candidate 1 to candidate 2.
    for (let i = 0; i < 3; i++) {
      audio.error = { code: 2, message: "network" };
      audio.dispatch("error");
      audio.error = null;
      vi.advanceTimersByTime(10_000);
    }
    expect(audio.src).toBe("https://a/2");

    // Three more exhaust the list and land on failed.
    for (let i = 0; i < 3; i++) {
      audio.error = { code: 2, message: "network" };
      audio.dispatch("error");
      audio.error = null;
      vi.advanceTimersByTime(10_000);
    }
    expect(states().slice(-1)).toEqual(["failed"]);
    playerApi.toggle();
    expect(states().slice(-1)).toEqual(["connecting"]);
    expect(audio.src).toBe("https://a/1");
  });

  it("finishes a fade when animation frames are suspended", () => {
    (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");
    playerApi.toggle();
    vi.advanceTimersByTime(250);
    expect(audio.pauseCalls).toBe(1);
    expect(states().slice(-1)).toEqual(["paused"]);
  });

  it("retries a stream that makes no playback progress", () => {
    playerApi.play(info(["https://a/1"]));
    vi.advanceTimersByTime(21_000);
    expect(audio.playCalls).toBe(2);
  });

  it("keeps a live stream with a fixed clock while it has future data", () => {
    playerApi.play(info(["https://a/1"]));
    audio.readyState = 4;
    audio.dispatch("playing");
    vi.advanceTimersByTime(60_000);
    expect(audio.playCalls).toBe(1);
    audio.readyState = 2;
    audio.dispatch("waiting");
    vi.advanceTimersByTime(21_000);
    expect(audio.playCalls).toBe(2);
  });

  it("restores volume and cancels fades when stopped or armed", () => {
    (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
    playerApi.setVolume(60);
    playerApi.play(info(["https://a/1"]));
    expect(audio.volume).toBe(0);
    playerApi.stop();
    expect(audio.volume).toBe(0.6);
    playerApi.play(info(["https://a/1"]));
    playerApi.arm(info([]).station, ["https://a/1"]);
    vi.advanceTimersByTime(1000);
    expect(audio.volume).toBe(0.6);
    expect(states().at(-1)).toBe("ready");
  });

  it("stop cancels a pending retry and returns to idle", () => {
    playerApi.play(info(["https://a/1"]));
    audio.error = { code: 2, message: "network" };
    audio.dispatch("error");
    audio.error = null;

    playerApi.stop();
    expect(states().slice(-1)).toEqual(["idle"]);

    vi.advanceTimersByTime(60_000);
    expect(audio.playCalls).toBe(1); // the retry never fired
  });

  it("reports blocked autoplay explicitly and cancels the watchdog", async () => {
    audio.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    playerApi.play(info(["https://a/1"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().slice(-1)).toEqual(["failed"]);
    expect(snapshots.at(-1)?.error).toContain("radio:errorBlocked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states().at(-1)).toBe("failed");
    expect(audio.pauseCalls).toBe(0);
  });

  it("retries a rejected play without a media error instead of calling it ready", async () => {
    audio.play = vi.fn().mockRejectedValue(new DOMException("unsupported", "NotSupportedError"));
    playerApi.play(info(["https://a/1"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(audio.play).toHaveBeenCalledTimes(3);
    expect(states().at(-1)).toBe("failed");
  });

  it.each([
    [1, "radio:errorAborted"],
    [2, "radio:errorNetwork"],
    [3, "radio:errorDecode"],
    [4, "radio:errorUnsupported"],
  ])("reports a stable identifier for media error %i", async (code, label) => {
    // A mounted HLS source also receives native media errors; code 4
    // must keep its format explanation rather than starting another HLS.
    playerApi.play(info(["https://a/live.m3u8"]));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      audio.error = { code, message: "An engine-specific diagnostic" };
      audio.dispatch("error");
      audio.error = null;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(states().at(-1)).toBe("failed");
    expect(snapshots.at(-1)?.error).toContain(label);
  });

  it("uses native HLS when supported and hls.js otherwise", async () => {
    const { attachHls } = await import("./hls");
    audio.canPlayType.mockReturnValue("probably");
    playerApi.play(info(["https://a/live.m3u8?token=1"]));
    expect(audio.src).toBe("https://a/live.m3u8?token=1");
    expect(attachHls).not.toHaveBeenCalled();
    playerApi.stop();
    audio.canPlayType.mockReturnValue("");
    playerApi.play({ ...info(["https://a/hls"]), station: { ...info([]).station, hls: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(attachHls).toHaveBeenCalledWith(audio, "https://a/hls", expect.any(Function));
    audio.dispatch("playing");
    expect(states().at(-1)).toBe("playing");
  });

  it("tries hls.js when native loading rejects an extensionless HLS URL", async () => {
    const { attachHls } = await import("./hls");
    vi.mocked(nativeFetch).mockResolvedValue(new Response(null, { headers: { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" } }));
    playerApi.play(info(["https://a/redirect"]));
    audio.error = { code: 4, message: "unsupported" };
    audio.dispatch("error");
    audio.error = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(attachHls).toHaveBeenCalledWith(audio, "https://a/redirect", expect.any(Function));
  });

  it("falls back for a known HLS source without probing headers", async () => {
    const { attachHls } = await import("./hls");
    audio.canPlayType.mockReturnValue("probably");
    playerApi.play(info(["https://a/live.m3u8"]));
    audio.error = { code: 4, message: "" };
    audio.dispatch("error");
    audio.error = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(attachHls).toHaveBeenCalledWith(audio, "https://a/live.m3u8", expect.any(Function));
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it.each(["ogg", "flac", "mp3"])("does not send unsupported %s audio to hls.js or repeat probes", async (extension) => {
    const { attachHls } = await import("./hls");
    playerApi.play(info([`https://a/live.${extension}`]));
    for (let i = 0; i < 3; i++) {
      audio.error = { code: 4, message: "" };
      audio.dispatch("error");
      audio.error = null;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(attachHls).not.toHaveBeenCalled();
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(states().at(-1)).toBe("failed");
    expect(snapshots.at(-1)?.error).toBe("radio:errorUnsupported");
  });

  it("limits a stalled format probe and preserves the normal retry path", async () => {
    const { attachHls } = await import("./hls");
    vi.mocked(nativeFetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
    }));
    playerApi.play(info(["https://a/unknown"]));
    audio.error = { code: 4, message: "" };
    audio.dispatch("error");
    audio.error = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(nativeFetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(audio.playCalls).toBe(2);
    expect(attachHls).not.toHaveBeenCalled();
    playerApi.stop();
  });

  it("cancels a format probe on stop and ignores its late HLS response", async () => {
    const { attachHls } = await import("./hls");
    let resolve!: (response: Response) => void;
    vi.mocked(nativeFetch).mockImplementation(() => new Promise((done) => { resolve = done; }));
    playerApi.play(info(["https://a/unknown"]));
    audio.error = { code: 4, message: "" };
    audio.dispatch("error");
    audio.error = null;
    playerApi.stop();
    expect(vi.mocked(nativeFetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    resolve(new Response(null, { headers: { "Content-Type": "application/x-mpegurl" } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachHls).not.toHaveBeenCalled();
    expect(states().at(-1)).toBe("idle");
  });

  it("destroys HLS on retry, pause/resume, switch, arm and stop, ignoring old failures", async () => {
    const { attachHls } = await import("./hls");
    playerApi.play(info(["https://a/live.m3u8", "https://b/live.m3u8"]));
    await vi.advanceTimersByTimeAsync(0);
    const first = vi.mocked(attachHls).mock.results.at(-1)!.value!;
    const failed = vi.mocked(attachHls).mock.calls.at(-1)![2];
    failed("network");
    expect(first.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    const second = vi.mocked(attachHls).mock.results.at(-1)!.value!;
    audio.dispatch("playing");
    playerApi.toggle();
    playerApi.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.destroy).toHaveBeenCalledOnce();
    const third = vi.mocked(attachHls).mock.results.at(-1)!.value!;
    playerApi.play(info(["https://c/mp3"]));
    expect(third.destroy).toHaveBeenCalledOnce();
    failed("old error");
    expect(audio.src).toBe("https://c/mp3");
    playerApi.play(info(["https://d/live.m3u8"]));
    await vi.advanceTimersByTimeAsync(0);
    const fourth = vi.mocked(attachHls).mock.results.at(-1)!.value!;
    playerApi.arm(info([]).station, []);
    expect(fourth.destroy).toHaveBeenCalledOnce();
    playerApi.play(info(["https://e/live.m3u8"]));
    await vi.advanceTimersByTimeAsync(0);
    const fifth = vi.mocked(attachHls).mock.results.at(-1)!.value!;
    playerApi.stop();
    expect(fifth.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states().at(-1)).toBe("idle");
  });

  it("does not attach HLS after stop or accept a rejection from an old load", async () => {
    const { attachHls } = await import("./hls");
    playerApi.play(info(["https://a/live.m3u8"]));
    playerApi.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(attachHls).not.toHaveBeenCalled();
    let reject!: (e: Error) => void;
    audio.play = () => new Promise<void>((_resolve, fail) => { reject = fail; });
    playerApi.play(info(["https://a/mp3"]));
    const rejectOld = reject;
    audio.dispatch("ended");
    await vi.advanceTimersByTimeAsync(1000);
    const rejectNew = reject;
    rejectOld(new DOMException("old load", "NotAllowedError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().at(-1)).toBe("connecting");
    playerApi.stop();
    rejectNew(new DOMException("late", "NotAllowedError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().at(-1)).toBe("idle");
  });

  it("switching stations while playing fades out, then loads the new source", () => {
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");

    playerApi.play(info(["https://b/1"]));
    expect(audio.src).toBe("https://b/1");
    expect(states().slice(-2)).toEqual(["playing", "connecting"]);
  });
});
