import { fetch as nativeFetch } from "@mygo-plugins/fetch";

export function isHlsURL(url: string) {
  return /\.m3u8?(?:$|[?#])/i.test(url);
}

/** Inspect response headers only after native playback rejects an unknown
 * format. GET works with radio servers that do not implement HEAD. Cancel
 * the body immediately so an endless audio stream is never downloaded. */
export async function probeHls(url: string, signal: AbortSignal) {
  const response = await nativeFetch(url, { signal, headers: { "User-Agent": "radio-desktop/0.3.0" } });
  try {
    if (!response.ok) return false;
    const type = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    return isHlsURL(response.url) || type === "application/vnd.apple.mpegurl"
      || type === "application/x-mpegurl" || type === "audio/mpegurl" || type === "audio/x-mpegurl";
  } finally {
    await response.body?.cancel();
  }
}
