import { create } from "zustand";
import { Service, events } from "./mygo";
import type { PlaybackMeta, PlayInfo, Progress, Station, Status, SyncResult } from "./mygo";
import { player, type PlayState } from "./player";

export type Source = "all" | "favorites" | "history" | "custom";
export type SortKey = "popularity" | "votes" | "name" | "bitrate" | "random";

const PAGE_SIZE = 50;

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

  // app status
  status: Status | null;
  syncProgress: Progress | null;
  lastSyncResult: SyncResult | null;
  dialog: "add" | "url" | null;
  nowPlayingOpen: boolean;

  // playback
  playState: PlayState;
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
  setFilter: (patch: Partial<Pick<RadioState, "country" | "language" | "tag" | "minBitrate" | "sort">>) => void;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  playStation: (station: Station) => Promise<void>;
  playLastStation: () => Promise<void>;
  playURL: (url: string) => Promise<void>;
  togglePlay: () => void;
  setVolume: (v: number) => void;
  toggleFavorite: (station: Station) => Promise<void>;
  syncNow: () => void;
  init: () => Promise<void>;
}

let volumeTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let initialized = false;
let playSeq = 0;
let pendingPlayback = false;
const pendingMetadata = new Map<number, PlaybackMeta>();

function applyMetadata(event: PlaybackMeta) {
  const s = useRadio.getState();
  if (pendingPlayback || event.sessionId !== s.sessionId || !s.sessionId || s.playState === "idle" || s.playState === "failed") return;
  const m = event.meta;
  useRadio.setState({ title: m.title, icyName: m.name, artworkUrl: m.artworkUrl,
    station: s.station && !s.station.stationuuid && m.name ? { ...s.station, name: m.name } : s.station });
}

async function startPlayback(load: () => Promise<PlayInfo>, failedStation?: Station) {
  const seq = ++playSeq;
  pendingPlayback = true;
  try {
    const info = await load();
    if (seq !== playSeq) {
      void Service.reportPlaybackState("idle", info.sessionId).catch(() => {});
      return;
    }
    pendingPlayback = false;
    useRadio.setState({ station: info.station, sessionId: info.sessionId, title: "", icyName: "", artworkUrl: "" });
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
      useRadio.setState({ station: failedStation, playState: "failed", sessionId: 0, title: "", icyName: "", artworkUrl: "" });
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

  status: null,
  syncProgress: null,
  lastSyncResult: null,
  dialog: null,
  nowPlayingOpen: false,

  playState: "idle",
  sessionId: 0,
  station: null,
  title: "",
  icyName: "",
  artworkUrl: "",
  volume: 80,

  openDialog: (dialog) => set({ dialog }),

  openNowPlaying: (nowPlayingOpen) => set({ nowPlayingOpen }),

  handleUICommand: (action) => {
    const s = get();
    switch (action) {
      case "toggle":
        s.togglePlay();
        break;
      case "random": {
        // A random station over the whole catalog, ignoring filters.
        void Service.search({
          query: "",
          country: "",
          language: "",
          tag: "",
          minBitrate: 0,
          sort: "random",
          source: "all",
          limit: 1,
          offset: 0,
        })
          .then((res) => {
            const station = res.items[0];
            if (station) return s.playStation(station);
          })
          .catch((e) => console.error("random play failed", e));
        break;
      }
      case "favorite":
        if (s.station) void s.toggleFavorite(s.station);
        break;
      case "stop":
        playSeq++;
        pendingPlayback = false;
        pendingMetadata.clear();
        player.stop();
        set({ sessionId: 0 });
        break;
      case "add":
        set({ dialog: "add" });
        break;
      case "playURL":
        set({ dialog: "url" });
        break;
    }
  },

  setSource: (source) => {
    set({ source });
    void get().refresh();
  },

  setQuery: (query) => {
    searchSeq++;
    set({ query });
    // 200ms debounce, like radio-cli's TUI search.
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void get().refresh(), 200);
  },

  setFilter: (patch) => {
    set(patch);
    void get().refresh();
  },

  refresh: async () => {
    const seq = ++searchSeq;
    const s = get();
    set({ loading: true, loadingMore: false, items: [], total: 0 });
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
      if (seq === searchSeq) set({ loading: false });
      console.error("search failed", e);
    }
  },

  loadMore: async () => {
    const s = get();
    if (s.loading || s.loadingMore || s.items.length >= s.total) return;
    const seq = searchSeq;
    set({ loadingMore: true });
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
      if (seq === searchSeq) set({ loadingMore: false });
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
    set({ volume });
    player.setVolume(volume);
    if (volumeTimer) clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => void Service.setVolume(volume).catch(() => {}), 500);
  },

  toggleFavorite: async (station) => {
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
    // Player snapshots flow into the store, and their state into the
    // system's media controls (Now Playing, media keys).
    player.onSnapshot = (snap) => {
      set({ playState: snap.state, station: snap.station ?? get().station });
      Service.reportPlaybackState(snap.state, get().sessionId).catch(() => {});
    };

    // The media keys and Control Center toggle playback through the same
    // path as the play button.
    events.mediaCommand.on((action: string) => {
      if (action === "toggle") get().togglePlay();
    });

    // Menu-bar and tray actions arrive here too.
    events.uiCommand.on((action: string) => get().handleUICommand(action));

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
      const status = await Service.getStatus();
      set({ volume: status.volume, status });
      player.setVolume(status.volume);
      // Arm the last station without autoplaying: the play button resumes.
      if (status.lastStationUUID) {
        try {
          const info = await Service.getPlayInfo(status.lastStationUUID);
          if (info.candidates.length > 0) {
            player.arm(info.station, info.candidates);
            set({ station: info.station });
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
