import type { PlayInfo, Station } from "./mygo";
import { Service } from "./mygo";

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
  candidateIndex: number;
  candidates: string[];
}

// Reconnect policy mirrors radio-cli's PlaybackController: backoff
// [1,3,7]s, at most 6 reconnects per 60s sliding window, then move to the
// next candidate URL, and finally give up.
const BACKOFF_MS = [1000, 3000, 7000];
const WINDOW_MS = 60_000;
const MAX_RECONNECTS = 6;
const ATTEMPTS_PER_CANDIDATE = 3;

class RadioPlayer {
  readonly audio: HTMLAudioElement;
  private gen = 0;
  private info: PlayInfo | null = null;
  private candIdx = 0;
  private candidateFails = 0;
  private reconnects: number[] = [];
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  onSnapshot: ((s: PlayerSnapshot) => void) | null = null;

  constructor() {
    const a = new Audio();
    a.preload = "none";
    // Long timeouts for flaky streams are handled by our own reconnect
    // logic; the element's own events drive it.
    this.audio = a;

    a.addEventListener("playing", () => {
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
      this.onStreamEnded(this.gen);
    });
    a.addEventListener("ended", () => this.onStreamEnded(this.gen));
    // 'stalled'/'waiting' only mean buffering; ignore them.
  }

  /** Starts playing a station from its candidate list. */
  play(info: PlayInfo) {
    this.gen++;
    this.clearTimer();
    this.info = info;
    this.candIdx = 0;
    this.candidateFails = 0;
    this.reconnects = [];
    this.reported = false;
    this.loadCurrent("connecting");
  }

  /** Marks a station as selected without starting audio (session resume). */
  arm(station: Station, candidates: string[]) {
    this.gen++;
    this.clearTimer();
    this.info = { station, candidates };
    this.candIdx = 0;
    this.candidateFails = 0;
    this.reconnects = [];
    this.reported = false;
    this.audio.removeAttribute("src");
    this.emit("ready");
  }

  toggle() {
    switch (this.state) {
      case "playing":
        this.audio.pause();
        this.emit("paused");
        break;
      case "connecting":
        this.stop();
        break;
      default:
        if (this.info) {
          this.reconnects = [];
          this.candidateFails = 0;
          this.reported = false;
          this.loadCurrent("connecting");
        }
    }
  }

  stop() {
    this.gen++;
    this.clearTimer();
    this.info = null;
    this.audio.removeAttribute("src");
    this.audio.load();
    this.emit("idle");
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
    this.audio.volume = Math.min(1, Math.max(0, v100 / 100));
  }

  /** Loads candidates[candIdx]; failures advance through the fallback
   * chain with backoff. Guarded by generation so a stale timer or error
   * from a previous station can never hijack the new one. */
  private loadCurrent(next: PlayState) {
    const myGen = this.gen;
    const candidates = this.info?.candidates ?? [];
    const url = candidates[this.candIdx];
    if (!url) {
      this.emit("failed");
      return;
    }
    this.emit(next);
    this.audio.src = url;
    const p = this.audio.play();
    if (p) {
      p.catch(() => {
        if (myGen !== this.gen) return;
        // With a media error attached, the 'error' event listener above
        // drives the reconnect; only a blocked autoplay lands here.
        if (!this.audio.error) {
          this.emit("ready");
        }
      });
    }
  }

  /** Called on audio error/ended. */
  private onStreamEnded(myGen: number) {
    if (myGen !== this.gen) return;
    if (this.lastState === "paused" || this.lastState === "idle" || this.lastState === "ready") {
      return;
    }
    this.handleFailure(myGen);
  }

  private handleFailure(myGen: number) {
    if (myGen !== this.gen) return;
    const now = Date.now();
    this.reconnects = this.reconnects.filter((t) => now - t < WINDOW_MS);
    if (this.reconnects.length >= MAX_RECONNECTS) {
      // Budget spent on this candidate: try the next one with a fresh
      // budget, like radio-cli rotating stream candidates.
      this.candidateFails = ATTEMPTS_PER_CANDIDATE;
      this.reconnects = [];
    }
    this.candidateFails++;
    if (this.candidateFails > ATTEMPTS_PER_CANDIDATE) {
      this.candIdx++;
      this.candidateFails = 1;
      const candidates = this.info?.candidates ?? [];
      if (this.candIdx >= candidates.length) {
        this.emit("failed");
        return;
      }
    }
    this.reconnects.push(now);
    const delay = BACKOFF_MS[Math.min(this.reconnects.length - 1, BACKOFF_MS.length - 1)] ?? 7000;
    this.emit("connecting");
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (myGen === this.gen) this.loadCurrent("connecting");
    }, delay);
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(state: PlayState) {
    this.lastState = state;
    this.onSnapshot?.({
      state,
      station: this.info?.station ?? null,
      candidateIndex: this.candIdx,
      candidates: this.info?.candidates ?? [],
    });
  }

  currentGen(): number {
    return this.gen;
  }
}

export const player = new RadioPlayer();
