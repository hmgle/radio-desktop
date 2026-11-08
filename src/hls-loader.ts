import { fetch as nativeFetch } from "@mygo-plugins/fetch";
import { BaseLoader, type LoaderResponse } from "hls.js";

/** Use MyGo's streaming HTTP client for every HLS resource, including
 * playlists, byte ranges and encryption keys. Keep the upstream URL in
 * the response so relative paths resolve against the final redirect. */
export class RadioHlsLoader extends BaseLoader {
  private controller: AbortController | null = null;
  private response: Response | null = null;

  protected loadInternal() {
    const { context, config, stats } = this;
    if (!context || !config) return;
    const controller = this.controller = new AbortController();
    const active = () => !controller.signal.aborted && this.context === context;
    stats.aborted = false;
    stats.loading.first = stats.loaded = 0;
    const headers = new Headers(context.headers);
    headers.set("User-Agent", "radio-desktop/0.3.0");
    if (context.rangeEnd && context.rangeEnd > (context.rangeStart ?? 0)) {
      headers.set("Range", `bytes=${context.rangeStart ?? 0}-${context.rangeEnd - 1}`);
    }
    const { maxTimeToFirstByteMs, maxLoadTimeMs } = config.loadPolicy;
    this.requestTimeout = self.setTimeout(() => this.loadtimeout(),
      Number.isFinite(maxTimeToFirstByteMs) ? maxTimeToFirstByteMs : maxLoadTimeMs);

    void nativeFetch(context.url, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!active()) { await response.body?.cancel(); return; }
        this.response = response;
        self.clearTimeout(this.requestTimeout);
        stats.loading.first = performance.now();
        if (!response.ok) {
          await response.body?.cancel();
          this.callbacks?.onError({ code: response.status, text: response.statusText }, context, response, stats);
          return;
        }
        this.requestTimeout = self.setTimeout(() => this.loadtimeout(),
          Math.max(0, maxLoadTimeMs - (stats.loading.first - stats.loading.start)));
        const data = context.responseType === "arraybuffer" ? await response.arrayBuffer()
          : context.responseType === "json" ? await response.json() : await response.text();
        if (!active()) return;
        self.clearTimeout(this.requestTimeout);
        stats.loading.end = performance.now();
        stats.loaded = stats.total = data instanceof ArrayBuffer ? data.byteLength
          : new TextEncoder().encode(typeof data === "string" ? data : JSON.stringify(data)).byteLength;
        const result: LoaderResponse = { url: response.url || context.url, data, code: response.status };
        this.callbacks?.onProgress?.(stats, context, data, response);
        this.callbacks?.onSuccess(result, stats, context, response);
      })
      .catch((error: unknown) => {
        if (!active()) return;
        self.clearTimeout(this.requestTimeout);
        this.callbacks?.onError({ code: 0, text: String(error) }, context, this.response, stats);
      });
  }

  protected abortInternal() {
    self.clearTimeout(this.requestTimeout);
    self.clearTimeout(this.retryTimeout);
    if (this.controller && !this.stats.loading.end) {
      this.stats.aborted = true;
      this.controller.abort();
    }
  }

  protected resetInternalLoader() { this.response = null; }
  protected getNetworkDetails() { return this.response; }
  getResponseHeader(name: string) { return this.response?.headers.get(name) ?? null; }
  getCacheAge() {
    const age = this.getResponseHeader("Age");
    return age === null ? null : Number(age);
  }

  override destroy() {
    super.destroy();
    this.controller = this.response = null;
  }
}
