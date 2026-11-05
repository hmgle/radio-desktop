import { useSettings } from "./settings";
import { create } from "zustand";
import { Service, events } from "./mygo";
import type { PlaybackMeta, PlayInfo, Progress, Station, Status, SyncResult, SleepTimer } from "./mygo";
import { player, type PlayState } from "./player";

export type Source = "all" | "favorites" | "history" | "custom";
export type SortKey = "popularity" | "votes" | "name" | "bitrate" | "random";

const PAGE_SIZE = 50;
const VOLUME_KEY = "radio.volume";

interface RadioState {
  // station list
  source: Source;
  query: string;
  country: string;
  language: string;
  tag: string;
  minBitrate: number;
  sort: SortKey;
  items: Station[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  searchError: string;

  // app status
  status: Status | null;
  syncProgress: Progress | null;
  lastSyncResult: SyncResult | null;
  dialog: "add" | "url" | null;
  nowPlayingOpen: boolean;
  settingsOpen: boolean;
  openSettings: (open: boolean) => void;

  sleepTimer: SleepTimer;
  sleepError: string;
  setSleepTimer: (minutes: number) => Promise<void>;

  // playback
  playState: PlayState;
  playbackError: string;
  sessionId: number;
  station: Station | null;
  title: string;
  icyName: string;
  artworkUrl: string;
  volume: number;

  // actions
  openDialog: (d: "add" | "url" | null) => void;
  openNowPlaying: (v: boolean) => void;
  handleUICommand: (action: string) => void;
  setSource: (s: Source) => void;
  setQuery: (q: string) => void;
  clearSearch: () => void;
  setFilter: (patch: Partial<Pick<RadioState, "country" | "language" | "tag" | "minBitrate" | "sort">>) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  playStation: (station: Station) => Promise<void>;
  playLastStation: () => Promise<void>;
  playURL: (url: string) => Promise<void>;
  togglePlay: () => void;
  setVolume: (v: number) => void;
  flushVolume: () => Promise<void>;
  toggleFavorite: (station: Station) => Promise<void>;
  syncNow: () => void;
  init: () => Promise<void>;
}

let volumeTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let initialized = false;
let playSeq = 0;
let restoreSeq = 0;
let sourceSave = Promise.resolve();
let pendingPlayback = false;
const pendingMetadata = new Map<number, PlaybackMeta>();

function applySleepTimer(timer: SleepTimer) {
  const s = useRadio.getState();
  if (timer.generation < s.sleepTimer.generation) return;
  const newlyExpired = timer.expired && !(s.sleepTimer.generation === timer.generation && s.sleepTimer.expired);
  useRadio.setState({ sleepTimer: timer });
  if (newlyExpired) s.handleUICommand("stop");
}

function applyMetadata(event: PlaybackMeta) {
  const s = useRadio.getState();
  if (pendingPlayback || event.sessionId !== s.sessionId || !s.sessionId || s.playState === "idle" || s.playState === "failed") return;
  const m = event.meta;
  useRadio.setState({ title: m.title, icyName: m.name, artworkUrl: m.artworkUrl,
    station: s.station && !s.station.stationuuid && m.name ? { ...s.station, name: m.name } : s.station });
}

async function startPlayback(load: () => Promise<PlayInfo>, failedStation?: Station) {
  restoreSeq++;
  const seq = ++playSeq;
  pendingPlayback = true;
  try {
    const info = await load();
    if (seq !== playSeq) {
      void Service.reportPlaybackState("idle", info.sessionId).catch(() => {});
      return;
    }
    pendingPlayback = false;
    useRadio.setState({ station: info.station, sessionId: info.sessionId, title: "", icyName: "", artworkUrl: "", playbackError: "" });
    player.play(info);
    const meta = pendingMetadata.get(info.sessionId);
    if (meta) applyMetadata(meta);
    pendingMetadata.clear();
  } catch (e) {
    if (seq !== playSeq) return;
    pendingPlayback = false;
    pendingMetadata.clear();
    if (failedStation) {
      player.stop();
      useRadio.setState({ station: failedStation, playState: "failed", playbackError: String(e), sessionId: 0, title: "", icyName: "", artworkUrl: "" });
    }
    throw e;
  }
}

export const useRadio = create<RadioState>((set, get) => ({
  source: "all",
  query: "",
  country: "",
  language: "",
  tag: "",
  minBitrate: 0,
  sort: "popularity",
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  searchError: "",

  status: null,
  syncProgress: null,
  lastSyncResult: null,
  dialog: null,
  nowPlayingOpen: false,
  settingsOpen: false,
  openSettings: (settingsOpen) => set({ settingsOpen, nowPlayingOpen: false, dialog: null }),

  sleepTimer: { deadline: 0, generation: 0, expired: false },
  sleepError: "",
  setSleepTimer: async (minutes) => {
    set({ sleepError: "" });
    try { applySleepTimer(await Service.setSleepTimer(minutes)); }
    catch (e) { set({ sleepError: String(e) }); }
  },

  playState: "idle",
  playbackError: "",
  sessionId: 0,
  station: null,
  title: "",
  icyName: "",
  artworkUrl: "",
  volume: 80,

  openDialog: (dialog) => set((s) => ({ dialog, nowPlayingOpen: dialog ? false : s.nowPlayingOpen })),

  openNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),

  handleUICommand: (action) => {
    const s = get();
    // Native menu accelerators can arrive without a DOM keydown event.
    if (["settings", "add", "playURL"].includes(action) &&
        (s.dialog || (typeof document !== "undefined" && document.querySelector('[role="dialog"][aria-modal="true"]')))) return;
    switch (action) {
      case "settings":
        get().openSettings(true);
        break;
      case "toggle":
        s.togglePlay();
        break;
      case "random": {
        const request = ++restoreSeq;
        // A random station over the whole catalog, ignoring filters.
        void Service.search({
          query: "",
          country: "",
          language: "",
          tag: "",
          minBitrate: 0,
          sort: "random",
          source: "all",
          limit: 2,
          offset: 0,
        })
          .then((res) => {
            if (request !== restoreSeq) return;
            const station = res.items.find((item) => item.stationuuid !== get().station?.stationuuid);
            if (station) return get().playStation(station);
          })
          .catch((e) => console.error("random play failed", e));
        break;
      }
      case "favorite":
        if (s.station) void s.toggleFavorite(s.station);
        break;
      case "stop":
        restoreSeq++;
        playSeq++;
        pendingPlayback = false;
        pendingMetadata.clear();
        player.stop();
        set({ sessionId: 0 });
        break;
      case "add":
        s.openDialog("add");
        break;
      case "playURL":
        s.openDialog("url");
        break;
    }
  },

  setSource: (source) => {
    restoreSeq++;
    sourceSave = sourceSave.then(() => Service.setLastSource(source)).catch((e) => console.error("save source failed", e));
    set({ source, settingsOpen: false });
    void get().refresh();
  },

  setQuery: (query) => {
    restoreSeq++;
    searchSeq++;
    set({ query });
    // 200ms debounce, like radio-cli's TUI search.
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void get().refresh(), 200);
  },

  setFilter: (patch) => {
    restoreSeq++;
    set(patch);
    void get().refresh();
  },

  clearSearch: () => {
    restoreSeq++;
    if (searchTimer) clearTimeout(searchTimer);
    set({ query: "", country: "", language: "", tag: "", minBitrate: 0 });
    void get().refresh();
  },

  refresh: async () => {
    const seq = ++searchSeq;
    const s = get();
    set({ loading: true, loadingMore: false, searchError: "", items: [], total: 0 });
    try {
      const res = await Service.search({
        query: s.query,
        country: s.country,
        language: s.language,
        tag: s.tag,
        minBitrate: s.minBitrate,
        sort: s.sort,
        source: s.source,
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (seq === searchSeq) set({ items: res.items, total: res.total, loading: false });
    } catch (e) {
      if (seq === searchSeq) set({ loading: false, searchError: String(e) });
      console.error("search failed", e);
    }
  },

  loadMore: async () => {
    const s = get();
    if (s.loading || s.loadingMore || s.items.length >= s.total) return;
    const seq = searchSeq;
    set({ loadingMore: true, searchError: "" });
    try {
      const res = await Service.search({
        query: s.query,
        country: s.country,
        language: s.language,
        tag: s.tag,
        minBitrate: s.minBitrate,
        sort: s.sort,
        source: s.source,
        limit: PAGE_SIZE,
        offset: s.items.length,
      });
      if (seq === searchSeq) set((st) => ({ items: [...st.items, ...res.items], loadingMore: false }));
    } catch (e) {
      if (seq === searchSeq) set({ loadingMore: false, searchError: String(e) });
      console.error("loadMore failed", e);
    }
  },

  playStation: async (station) => {
    try {
      await startPlayback(() => Service.playStation(station.stationuuid), station);
    } catch (e) {
      console.error("playStation failed", e);
    }
  },

  playLastStation: async () => {
    const uuid = get().status?.lastStationUUID;
    if (!uuid) return;
    try {
      await startPlayback(() => Service.playStation(uuid));
    } catch (e) {
      console.error("resume failed", e);
    }
  },

  playURL: async (url) => {
    try {
      await startPlayback(() => Service.playURL(url));
    } catch (e) {
      console.error("playURL failed", e);
      throw e;
    }
  },

  togglePlay: () => {
    restoreSeq++;
    const s = get();
    if (s.playState === "idle" || s.playState === "failed" || s.playState === "ready") {
      if (s.station?.stationuuid) void s.playStation(s.station);
      else if (s.station?.url) void s.playURL(s.station.url).catch(() => {});
      else void s.playLastStation();
      return;
    }
    player.toggle();
  },

  setVolume: (volume) => {
    volume = Math.min(100, Math.max(0, Math.round(volume)));
    set({ volume });
    player.setVolume(volume);
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* storage may be unavailable */ }
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => void get().flushVolume(), 500);
  },

  flushVolume: async () => {
    if (volumeTimer === null) return;
    clearTimeout(volumeTimer);
    volumeTimer = null;
    try { await Service.setVolume(get().volume); } catch (e) { console.error("save volume failed", e); }
  },

  toggleFavorite: async (station) => {
    if (!station.stationuuid) return;
    const optimistic = !station.favorite;
    set((st) => ({
      items: st.items.map((it) =>
        it.stationuuid === station.stationuuid ? { ...it, favorite: optimistic } : it,
      ),
      station: st.station?.stationuuid === station.stationuuid ? { ...st.station, favorite: optimistic } : st.station,
    }));
    try {
      if (optimistic) await Service.addFavorite(station.stationuuid);
      else await Service.removeFavorite(station.stationuuid);
      if (get().source === "favorites") void get().refresh();
    } catch (e) {
      console.error("favorite failed", e);
      set((st) => ({
        items: st.items.map((it) =>
          it.stationuuid === station.stationuuid ? { ...it, favorite: station.favorite } : it,
        ),
        station: st.station?.stationuuid === station.stationuuid ? { ...st.station, favorite: station.favorite } : st.station,
      }));
    }
  },

  syncNow: () => {
    set((s) => ({ syncProgress: null, status: s.status ? { ...s.status, syncing: true } : s.status }));
    Service.syncNow().catch((e) => {
      set((s) => ({ status: s.status ? { ...s.status, syncing: false } : s.status }));
      console.error("sync failed", e);
    });
  },

  init: async () => {
    if (initialized) return;
    initialized = true;
    const restore = restoreSeq;
    // Player snapshots flow into the store, and their state into the
    // system's media controls (Now Playing, media keys).
    player.onSnapshot = (snap) => {
      set({ playState: snap.state, playbackError: snap.error, station: snap.station ?? get().station });
      Service.reportPlaybackState(snap.state, get().sessionId).catch(() => {});
    };

    // The media keys and Control Center toggle playback through the same
    // path as the play button.
    events.mediaCommand.on((action: string) => {
      if (action === "toggle") get().togglePlay();
    });

    // Menu-bar and tray actions arrive here too.
    events.uiCommand.on((action: string) => get().handleUICommand(action));

    events.playbackRecovery.on(() => player.recover());

    events.sleepTimerChanged.on(applySleepTimer);
    void Service.getSleepTimer().then(applySleepTimer).catch(() => {});

    events.icyMeta.on((event: PlaybackMeta) => {
      if (pendingPlayback) {
        pendingMetadata.set(event.sessionId, event);
        if (pendingMetadata.size > 8) pendingMetadata.delete(pendingMetadata.keys().next().value!);
      } else applyMetadata(event);
    });
    events.syncProgress.on((p: Progress) => set({ syncProgress: p }));
    events.syncDone.on((r: SyncResult) => {
      set((s) => ({ syncProgress: null, lastSyncResult: r, status: s.status ? { ...s.status, syncing: r.phase === "bootstrap" } : s.status }));
      if (!r.error) {
        void get().refresh();
        void Service.getStatus().then((status) => set({ status })).catch(() => {});
      }
    });

    try {
      await useSettings.getState().load();
      const resume = useSettings.getState().value.resume;
      const status = await Service.getStatus();
      let volume = status.volume;
      try {
        const saved = localStorage.getItem(VOLUME_KEY);
        if (saved !== null && /^\d+$/.test(saved) && Number(saved) <= 100) volume = Number(saved);
      } catch { /* storage may be unavailable */ }
      set({ volume, status });
      player.setVolume(volume);
      if (volume !== status.volume) void Service.setVolume(volume).catch(() => {});
      if (resume !== "off" && restore === restoreSeq) {
        const source = status.lastSource;
        if (["all", "favorites", "history", "custom"].includes(source)) set({ source: source as Source });
      }
      if (resume !== "off" && restore === restoreSeq && status.lastStationUUID) {
        try {
          const info = await Service.getPlayInfo(status.lastStationUUID);
          if (info.candidates.length > 0 && restore === restoreSeq) {
            if (resume === "play") await get().playStation(info.station);
            else {
              player.arm(info.station, info.candidates);
              set({ station: info.station });
            }
          }
        } catch {
          // Last station vanished from the catalog; start idle.
        }
      }
    } catch (e) {
      console.error("getStatus failed", e);
    }
    void get().refresh();
  },
}));
