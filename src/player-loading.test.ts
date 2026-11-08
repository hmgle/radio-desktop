import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayInfo } from "./mygo";

const moduleLoad = { promise: null as Promise<unknown> | null };
vi.mock("./mygo", () => ({ Service: { reportStarted: vi.fn() } }));

class FakeAudio {
  volume = 1;
  currentTime = 0;
  play = vi.fn().mockResolvedValue(undefined);
  canPlayType() { return ""; }
  addEventListener() {}
  removeAttribute() {}
  load() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const info = { station: { stationuuid: "", name: "Test HLS", hls: 1 }, candidates: ["https://a/live.m3u8"] } as PlayInfo;

describe("HLS source initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("./hls", async () => ({ supportsHls: () => true, ...await moduleLoad.promise as object }));
    vi.useFakeTimers();
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("allows a full playback stall interval after a slow module attachment", async () => {
    const pending = deferred<{ attachHls: ReturnType<typeof vi.fn> }>();
    moduleLoad.promise = pending.promise;
    const { player } = await import("./player");
    const attachHls = vi.fn(() => ({ destroy: vi.fn() }));
    player.play(info);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(player.audio.play).not.toHaveBeenCalled();
    pending.resolve({ attachHls });
    await vi.dynamicImportSettled();
    expect(attachHls).toHaveBeenCalledOnce();
    expect(player.audio.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(attachHls).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(attachHls).toHaveBeenCalledTimes(2);
    player.stop();
  });

  it("bounds module initialization and rejects its completion after the deadline", async () => {
    const pending = deferred<{ attachHls: ReturnType<typeof vi.fn> }>();
    moduleLoad.promise = pending.promise;
    const { player } = await import("./player");
    const attachHls = vi.fn(() => ({ destroy: vi.fn() }));
    player.play(info);
    await vi.advanceTimersByTimeAsync(20_000);
    pending.resolve({ attachHls });
    await vi.dynamicImportSettled();
    expect(attachHls).not.toHaveBeenCalled();
    expect(player.audio.play).not.toHaveBeenCalled();
    // The normal retry at 21s gets a fresh setup and watchdog budget.
    await vi.advanceTimersByTimeAsync(1000);
    expect(attachHls).toHaveBeenCalledOnce();
    expect(player.audio.play).toHaveBeenCalledOnce();
    player.stop();
  });

  it("clears initialization timers on stop and discards the late module", async () => {
    const pending = deferred<{ attachHls: ReturnType<typeof vi.fn> }>();
    moduleLoad.promise = pending.promise;
    const { player } = await import("./player");
    const attachHls = vi.fn(() => ({ destroy: vi.fn() }));
    player.play(info);
    player.stop();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ attachHls });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachHls).not.toHaveBeenCalled();
    expect(player.state).toBe("idle");
  });
});
