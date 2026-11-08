import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetch as nativeFetch } from "@mygo-plugins/fetch";
import { isHlsURL, probeHls } from "./stream-format";

vi.mock("@mygo-plugins/fetch", () => ({ fetch: vi.fn() }));

describe("stream format probe", () => {
  beforeEach(() => { vi.mocked(nativeFetch).mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["https://a/live.m3u", "https://a/live.M3U?token=1", "https://a/live.m3u8#live"])("recognizes the HLS playlist URL %s", (url) => {
    expect(isHlsURL(url)).toBe(true);
  });

  it.each(["https://a/live.m3u80", "https://a/live.m3u/segment", "https://a/live.mp3"])("does not classify the media URL %s as a playlist", (url) => {
    expect(isHlsURL(url)).toBe(false);
  });

  it.each([
    ["application/vnd.apple.mpegurl", true],
    ["application/x-mpegurl; charset=utf-8", true],
    ["Audio/MpegURL", true],
    ["audio/x-mpegurl", true],
    ["audio/ogg", false],
    ["audio/flac", false],
    ["text/html", false],
    ["application/octet-stream", false],
  ])("classifies %s without consuming an endless stream", async (type, expected) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": type } });
    vi.mocked(nativeFetch).mockResolvedValue(response);
    const controller = new AbortController();
    expect(await probeHls("https://a/unknown", controller.signal)).toBe(expected);
    expect(nativeFetch).toHaveBeenCalledWith("https://a/unknown", expect.objectContaining({ signal: controller.signal }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it("recognizes an HLS redirect even with an opaque content type", async () => {
    const response = new Response(null, { headers: { "Content-Type": "application/octet-stream" } });
    Object.defineProperty(response, "url", { value: "https://cdn.test/live.M3U8?token=1" });
    vi.mocked(nativeFetch).mockResolvedValue(response);
    expect(await probeHls("https://a/redirect", new AbortController().signal)).toBe(true);
  });

  it("does not classify an HTTP error as HLS and closes its body", async () => {
    const response = new Response("not found", { status: 404, headers: { "Content-Type": "application/x-mpegurl" } });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.mocked(nativeFetch).mockResolvedValue(response);
    expect(await probeHls("https://a/unknown", new AbortController().signal)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
