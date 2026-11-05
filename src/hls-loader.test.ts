import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoaderContextType, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from "hls.js";
import { fetch as nativeFetch } from "@mygo-plugins/fetch";
import { RadioHlsLoader } from "./hls-loader";

vi.mock("@mygo-plugins/fetch", () => ({ fetch: vi.fn() }));

const config: LoaderConfiguration = {
  loadPolicy: { maxTimeToFirstByteMs: 1000, maxLoadTimeMs: 2000, timeoutRetry: null, errorRetry: null },
  timeout: 2000, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0,
};
const context: LoaderContext = { url: "https://radio.test/live", responseType: "text", type: LoaderContextType.MANIFEST };

function callbacks(): LoaderCallbacks<LoaderContext> {
  return { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn(), onProgress: vi.fn() };
}

describe("HLS native HTTP loader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("self", globalThis);
    vi.mocked(nativeFetch).mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("preserves the redirect URL for relative playlists and reports UTF-8 bytes", async () => {
    const response = new Response("#EXTM3U\n#中文\naudio/live.m3u8", { headers: { Age: "5" } });
    Object.defineProperty(response, "url", { value: "https://cdn.test/dir/master.m3u8" });
    vi.mocked(nativeFetch).mockResolvedValue(response);
    const loader = new RadioHlsLoader();
    const cb = callbacks();
    loader.load({ ...context, rangeStart: 0, rangeEnd: 0 }, config, cb);
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ url: response.url, data: "#EXTM3U\n#中文\naudio/live.m3u8" }), loader.stats, expect.objectContaining(context), response);
    expect(new Headers(vi.mocked(nativeFetch).mock.calls[0]![1]!.headers).has("Range")).toBe(false);
    expect(loader.stats.loaded).toBe(new TextEncoder().encode("#EXTM3U\n#中文\naudio/live.m3u8").byteLength);
    expect(loader.getCacheAge()).toBe(5);
    await vi.advanceTimersByTimeAsync(3000);
    expect(cb.onTimeout).not.toHaveBeenCalled();
    loader.destroy();
  });

  it("loads binary fragments and AES keys with byte ranges and context headers", async () => {
    const bytes = new Uint8Array([0, 255, 3, 128]);
    vi.mocked(nativeFetch).mockResolvedValue(new Response(bytes, { status: 206 }));
    const loader = new RadioHlsLoader();
    const cb = callbacks();
    loader.load({ ...context, responseType: "arraybuffer", type: LoaderContextType.KEY, rangeStart: 100, rangeEnd: 104, headers: { "X-Token": "test" } }, config, cb);
    await vi.advanceTimersByTimeAsync(0);
    const options = vi.mocked(nativeFetch).mock.calls[0]![1]!;
    const headers = new Headers(options.headers);
    expect(headers.get("Range")).toBe("bytes=100-103");
    expect(headers.get("X-Token")).toBe("test");
    expect(new Uint8Array(vi.mocked(cb.onSuccess).mock.calls[0]![0].data as ArrayBuffer)).toEqual(bytes);
    loader.destroy();
  });

  it("reports HTTP and transport errors without leaving a timeout running", async () => {
    for (const status of [404, 503, 0]) {
      if (status) vi.mocked(nativeFetch).mockResolvedValue(new Response("bad", { status }));
      else vi.mocked(nativeFetch).mockRejectedValue(new Error("connection reset"));
      const loader = new RadioHlsLoader();
      const cb = callbacks();
      loader.load(context, config, cb);
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: status }), context, status ? expect.any(Response) : null, loader.stats);
      expect(cb.onTimeout).not.toHaveBeenCalled();
      loader.destroy();
    }
  });

  it("aborts timed-out requests and ignores completion after destroy", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(nativeFetch).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const loader = new RadioHlsLoader();
    const cb = callbacks();
    loader.load(context, config, cb);
    const signal = vi.mocked(nativeFetch).mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(cb.onTimeout).toHaveBeenCalledOnce();
    loader.destroy();
    resolve(new Response("late playlist"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onSuccess).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it("times out a stalled body and cancels it when explicitly aborted", async () => {
    for (const abort of [false, true]) {
      vi.mocked(nativeFetch).mockImplementation(async (_url, init) => new Response(new ReadableStream({
        start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
      })));
      const loader = new RadioHlsLoader();
      const cb = callbacks();
      loader.load(context, config, cb);
      await vi.advanceTimersByTimeAsync(0);
      if (abort) loader.abort();
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb.onTimeout).toHaveBeenCalledTimes(abort ? 0 : 1);
      expect(cb.onAbort).toHaveBeenCalledTimes(abort ? 1 : 0);
      expect(cb.onSuccess).not.toHaveBeenCalled();
      expect(cb.onError).not.toHaveBeenCalled();
      loader.destroy();
    }
  });
});
