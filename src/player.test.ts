/**
 * Behavior tests for the player state machine — the layer the UI renders
 * and the only thing allowed to touch the audio element. A missing
 * emit("playing") here once left the UI stuck on 连接中, so every
 * transition is pinned down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mygo", () => ({
  Service: { reportStarted: vi.fn().mockResolvedValue(undefined) },
}));

// The fake element: events fire by hand, play() resolves like a
// well-behaved stream, and rAF runs its frame immediately so fades
// settle in one tick.
class FakeAudio {
  volume = 1;
  src = "";
  preload = "";
  currentSrc = "";
  currentTime = 0;
  error: { code: number; message: string } | null = null;
  playCalls = 0;
  pauseCalls = 0;
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
let snapshots: { state: string; station: string | null }[];

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
  const mod = fresh as unknown as {
    onSnapshot: ((s: { state: string; station: { name: string } | null }) => void) | null;
    play(info: { station: { stationuuid: string; name: string }; candidates: string[] }): void;
    toggle(): void;
    stop(): void;
  };
  snapshots = [];
  mod.onSnapshot = (s) => snapshots.push({ state: s.state, station: s.station?.name ?? null });
  // A shared handle the tests drive.
  (globalThis as Record<string, unknown>).__player = mod;
  (globalThis as Record<string, unknown>).__audio = audio;
  playerApi = mod;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it("a blocked autoplay arms the station instead of failing", async () => {
    audio.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    playerApi.play(info(["https://a/1"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().slice(-1)).toEqual(["ready"]);
    expect(audio.pauseCalls).toBe(0);
  });

  it("switching stations while playing fades out, then loads the new source", () => {
    playerApi.play(info(["https://a/1"]));
    audio.dispatch("playing");

    playerApi.play(info(["https://b/1"]));
    expect(audio.src).toBe("https://b/1");
    expect(states().slice(-2)).toEqual(["playing", "connecting"]);
  });
});
