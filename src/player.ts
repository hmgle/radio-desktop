import type { PlayInfo, Station } from "./mygo";
import { Service } from "./mygo";
import { isHlsURL, probeHls } from "./stream-format";

export type PlayState =
  | "idle" // nothing selected
  | "ready" // station selected (e.g. restored last session), not playing
  | "connecting"
  | "playing"
  | "paused"
  | "failed";

export interface PlayerSnapshot {
  state: PlayState;
  station: Station | null;
  error: string;
}

// Reconnect policy mirrors radio-cli's PlaybackController: backoff
// [1,3,7]s, at most 6 reconnects per 60s sliding window, then move to the
// next candidate URL, and finally give up.
const BACKOFF_MS = [1000, 3000, 7000];
const WINDOW_MS = 60_000;
const MAX_RECONNECTS = 6;
const ATTEMPTS_PER_CANDIDATE = 3;
// Pause fades the music out, resume and station switches fade it in, as
// mygo-cloudmusic's fader does, with the same cosine ease.
const FADE_OUT_MS = 180;
const FADE_IN_MS = 260;
const STALL_MS = 20_000;
const HLS_PROBE_MS = 5000;
const MEDIA_ERROR_LABELS: Record<number, string> = {
  1: "radio:errorAborted",
  2: "radio:errorNetwork",
  3: "radio:errorDecode",
  4: "radio:errorUnsupported",
};

class RadioPlayer {
  readonly audio: HTMLAudioElement;
  private gen = 0;
  private info: PlayInfo | null = null;
  // Fade level between 0 and 1: the audio element's volume is the
  // listener's volume times this level. fadeGen counts fades so one
  // overtaken by a newer play/pause stops applying.
  private level = 1;
  private fadeGen = 0;
  private userVolume = 80;
  private candIdx = 0;
  private candidateFails = 0;
  private reconnects: number[] = [];
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
  private buffering = false;
  private hls: { destroy(): void } | null = null;
  private hlsFallback = new Map<string, boolean>();
  private hlsProbe: AbortController | null = null;
  private loadID = 0;
  private error = "";

  onSnapshot: ((s: PlayerSnapshot) => void) | null = null;

  constructor() {
    const a = new Audio();
    a.preload = "none";
    // Long timeouts for flaky streams are handled by our own reconnect
    // logic; the element's own events drive it.
    this.audio = a;

    a.addEventListener("playing", () => {
      if (!this.info || (this.lastState !== "connecting" && this.lastState !== "playing")) return;
      this.buffering = false;
      if (this.lastState === "playing") return;
      // A successful connection ends consecutive failures, including
      // ordinary wake recoveries hours apart. Keep the sliding-window
      // budget so briefly playing streams cannot retry without a limit.
      this.candidateFails = 0;
      this.emit("playing");
      if (this.level < 1) this.fade(1, FADE_IN_MS);
      if (this.reported) return;
      this.reported = true;
      const uuid = this.info?.station.stationuuid ?? "";
      if (uuid) Service.reportStarted(uuid).catch(() => {});
    });
    // Stream died: network error or the server closed the connection.
    // Both surface as 'error'/'ended' on the element.
    a.addEventListener("error", () => {
      const err = a.error;
      console.warn(`audio error code=${err?.code ?? "?"} on ${a.currentSrc}`, err?.message);
      if (!err || this.timer !== null || (this.lastState !== "playing" && this.lastState !== "connecting")) return;
      this.error = MEDIA_ERROR_LABELS[err.code] || "radio:errorLoad";
      // Try hls.js only for identified HLS. Unknown URLs get one bounded
      // header probe per candidate, including extensionless redirects.
      const url = this.info?.candidates[this.candIdx];
      const relayed = url && this.info?.nativeCandidates?.[this.candIdx] && this.info.nativeCandidates[this.candIdx] !== url;
      if ((err.code === 4 || (err.code === 2 && relayed)) && url && !this.hls && !this.hlsFallback.has(url)) {
        this.hlsFallback.set(url, false);
        if (this.hasHlsHint(url) || isHlsURL(a.currentSrc)) {
          this.hlsFallback.set(url, true);
          this.loadCurrent("connecting");
        } else void this.probeHlsFallback(url);
        return;
      }
      this.onStreamEnded(this.gen);
    });
    a.addEventListener("ended", () => this.onStreamEnded(this.gen));
    a.addEventListener("waiting", () => { this.buffering = true; });
  }

  /** Starts playing a station from its candidate list, fading out
   *  whatever played first. */
  play(info: PlayInfo) {
    this.gen++;
    this.clearTimer();
    this.info = info;
    this.hlsFallback.clear();
    this.error = "";
    this.candIdx = 0;
    this.candidateFails = 0;
    this.reconnects = [];
    this.reported = false;
    if (this.lastState === "playing" || this.lastState === "connecting") {
      this.fade(0, FADE_OUT_MS, () => {
        if (this.info === info) this.loadCurrent("connecting");
      });
    } else {
      this.loadCurrent("connecting");
    }
  }

  /** Marks a station as selected without starting audio (session resume). */
  arm(station: Station, candidates: string[]) {
    this.gen++;
    this.clearTimer();
    this.info = { station, candidates, sessionId: 0 };
    this.candIdx = 0;
    this.candidateFails = 0;
    this.reconnects = [];
    this.reported = false;
    this.error = "";
    this.releaseSource();
    this.fadeGen++;
    this.level = 1;
    this.applyVolume();
    this.emit("ready");
  }

  toggle() {
    switch (this.state) {
      case "playing":
        // Record the user's intent before the fade, so a wake/network
        // event during these 180ms cannot reconnect a paused station.
        this.emit("paused");
        this.fade(0, FADE_OUT_MS, () => {
          this.audio.pause();
          this.clearWatchdog();
        });
        break;
      case "connecting":
        this.stop();
        break;
      default:
        if (this.info) {
          this.reconnects = [];
          this.candidateFails = 0;
          if (this.lastState === "failed") {
            this.candIdx = 0;
            this.reported = false;
          }
          this.loadCurrent("connecting");
        }
    }
  }

  stop() {
    this.gen++;
    this.clearTimer();
    this.info = null;
    this.error = "";
    this.releaseSource();
    this.fadeGen++; // cancel any running fade
    this.level = 1;
    this.applyVolume();
    this.emit("idle");
  }

  /** Native wake/connectivity signals share the stream failure budget,
   *  candidate order and backoff. A pending retry coalesces nearby signals. */
  recover() {
    this.onStreamEnded(this.gen);
  }

  get state(): PlayState {
    // The snapshot state is tracked via emit(); the player bar reflects
    // the store. For internal decisions we only need playing/paused.
    return this.lastState;
  }
  private lastState: PlayState = "idle";

  get station(): Station | null {
    return this.info?.station ?? null;
  }

  setVolume(v100: number) {
    this.userVolume = Math.min(100, Math.max(0, v100));
    this.applyVolume();
  }

  private applyVolume() {
    this.audio.volume = Math.min(1, Math.max(0, (this.userVolume / 100) * this.level));
  }

  /** Ramps the fade level to `to` over `ms` with a cosine ease, calling
   *  `done` at the end unless a newer fade overtook this one. */
  private fade(to: number, ms: number, done?: () => void) {
    const gen = ++this.fadeGen;
    const from = this.level;
    const start = performance.now();
    let finished = false;
    const step = (now: number) => {
      if (gen !== this.fadeGen || finished) return;
      const t = Math.min(1, ms > 0 ? (now - start) / ms : 1);
      this.level = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      this.applyVolume();
      if (t < 1) requestAnimationFrame(step);
      else {
        finished = true;
        done?.();
      }
    };
    requestAnimationFrame(step);
    setTimeout(() => step(performance.now()), ms + 20);
  }

  /** Loads candidates[candIdx]; failures advance through the fallback
   * chain with backoff. Guarded by generation so a stale timer or error
   * from a previous station can never hijack the new one. */
  private loadCurrent(next: PlayState) {
    const myGen = this.gen;
    const candidates = this.info?.candidates ?? [];
    const url = candidates[this.candIdx];
    if (!url) {
      this.error = "radio:errorNoURL";
      this.emit("failed");
      return;
    }
    this.releaseSource();
    const loadID = this.loadID;
    this.emit(next);
    this.fadeGen++;
    this.buffering = true;
    this.level = 0; // fades in as playback actually starts
    this.applyVolume();
    if (this.hlsFallback.get(url) || (this.hasHlsHint(url) && !this.audio.canPlayType("application/vnd.apple.mpegurl"))) {
      // Module setup has its own deadline; playback progress only starts
      // counting once a source is attached to the element.
      this.sourceTimer = setTimeout(() => {
        this.sourceTimer = null;
        if (loadID !== this.loadID || myGen !== this.gen) return;
        this.error = "radio:errorHlsTimeout";
        this.onStreamEnded(myGen);
      }, STALL_MS);
      void import("./hls").then(({ attachHls }) => {
        if (loadID !== this.loadID || myGen !== this.gen) return;
        const hls = attachHls(this.audio, url, (reason) => {
          if (loadID !== this.loadID || myGen !== this.gen) return;
          this.error = reason;
          this.onStreamEnded(myGen);
        });
        if (loadID !== this.loadID || myGen !== this.gen) { hls.destroy(); return; }
        this.hls = hls;
        this.clearSourceTimer();
        this.startAudio(myGen, loadID);
      }).catch((e: unknown) => {
        if (loadID !== this.loadID || myGen !== this.gen) return;
        this.error = String(e);
        this.onStreamEnded(myGen);
      });
    } else {
      this.audio.src = this.info?.nativeCandidates?.[this.candIdx] ?? url;
      this.startAudio(myGen, loadID);
    }
  }

  private hasHlsHint(url: string) {
    return this.info?.station.hls === 1 || isHlsURL(url);
  }

  private async probeHlsFallback(url: string) {
    const myGen = this.gen;
    const loadID = ++this.loadID; // ignore the rejected native play promise
    this.clearWatchdog();
    const controller = this.hlsProbe = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HLS_PROBE_MS);
    let hls = false;
    try {
      hls = await probeHls(url, controller.signal);
    } catch {
      // Failed probes keep the original media error and normal retry path.
    } finally {
      clearTimeout(timeout);
    }
    if (myGen !== this.gen || loadID !== this.loadID || this.hlsProbe !== controller) return;
    this.hlsProbe = null;
    if (hls) {
      this.hlsFallback.set(url, true);
      this.loadCurrent("connecting");
    } else this.onStreamEnded(myGen);
  }

  private startAudio(myGen: number, loadID: number) {
    this.watchProgress(myGen);
    const p = this.audio.play();
    if (p) {
      p.catch((e: unknown) => {
        if (myGen !== this.gen || loadID !== this.loadID) return;
        const name = e instanceof Error ? e.name : "";
        console.warn(`audio play rejected: ${name}`, e);
        if (name === "NotAllowedError") {
          this.clearTimer();
          this.releaseSource();
          this.error = "radio:errorBlocked";
          this.emit("failed");
        } else if (!this.audio.error) {
          this.error = String(e);
          this.onStreamEnded(myGen);
        }
      });
    }
  }

  private releaseSource() {
    this.loadID++;
    this.clearWatchdog();
    this.clearSourceTimer();
    this.hlsProbe?.abort();
    this.hlsProbe = null;
    this.hls?.destroy();
    this.hls = null;
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  /** Called on audio error/ended. */
  private onStreamEnded(myGen: number) {
    if (myGen !== this.gen) return;
    if (this.lastState === "paused" || this.lastState === "idle" || this.lastState === "ready" || this.lastState === "failed" || this.timer !== null) {
      return;
    }
    this.handleFailure(myGen);
  }

  private handleFailure(myGen: number) {
    if (myGen !== this.gen) return;
    this.fadeGen++; // cancel a station-switch fade before scheduling its retry
    this.clearWatchdog();
    this.releaseSource();
    const now = Date.now();
    this.reconnects = this.reconnects.filter((t) => now - t < WINDOW_MS);
    if (this.reconnects.length >= MAX_RECONNECTS) {
      // Budget spent on this candidate: try the next one with a fresh
      // budget, like radio-cli rotating stream candidates.
      this.candidateFails = ATTEMPTS_PER_CANDIDATE;
      this.reconnects = [];
    }
    this.candidateFails++;
    if (this.candidateFails >= ATTEMPTS_PER_CANDIDATE) {
      this.candIdx++;
      this.candidateFails = 1;
      const candidates = this.info?.candidates ?? [];
      if (this.candIdx >= candidates.length) {
        if (!this.error) this.error = "radio:errorDisconnected";
        this.emit("failed");
        return;
      }
    }
    this.reconnects.push(now);
    const delay = BACKOFF_MS[Math.min(this.reconnects.length - 1, BACKOFF_MS.length - 1)] ?? 7000;
    this.emit("connecting");
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (myGen === this.gen) this.loadCurrent("connecting");
    }, delay);
  }

  private clearTimer() {
    this.clearWatchdog();
    this.clearSourceTimer();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearSourceTimer() {
    if (this.sourceTimer !== null) clearTimeout(this.sourceTimer);
    this.sourceTimer = null;
  }

  private clearWatchdog() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private watchProgress(myGen: number) {
    this.clearWatchdog();
    let lastTime = this.audio.currentTime;
    const check = () => {
      if (myGen !== this.gen || (this.lastState !== "connecting" && this.lastState !== "playing")) return;
      const currentTime = this.audio.currentTime;
      // Some live/HLS media timelines stay fixed even while audio plays.
      // Only treat a fixed clock as a failure when playback is waiting
      // or the element has also run out of buffered future data.
      const hasFutureData = this.audio.readyState >= 3;
      if (currentTime <= lastTime && (this.lastState === "connecting" || this.buffering || !hasFutureData)) {
        this.handleFailure(myGen);
        return;
      }
      lastTime = currentTime;
      this.watchdog = setTimeout(check, STALL_MS);
    };
    this.watchdog = setTimeout(check, STALL_MS);
  }

  private emit(state: PlayState) {
    if (state === "playing") this.error = "";
    this.lastState = state;
    this.onSnapshot?.({
      state,
      station: this.info?.station ?? null,
      error: state === "failed" ? this.error : "",
    });
  }

}

export const player = new RadioPlayer();
