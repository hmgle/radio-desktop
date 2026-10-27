import { create } from "zustand";
import { Service, events } from "./mygo";
import type { Meta, Progress, Station, Status, SyncResult } from "./mygo";
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

  // playback
  playState: PlayState;
  station: Station | null;
  title: string;
  icyName: string;
  artworkUrl: string;
  volume: number;

  // actions
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

  playState: "idle",
  station: null,
  title: "",
  icyName: "",
  artworkUrl: "",
  volume: 80,

  setSource: (source) => {
    set({ source });
    void get().refresh();
  },

  setQuery: (query) => {
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
    const s = get();
    set({ loading: true, items: [], total: 0 });
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
      set({ items: res.items, total: res.total, loading: false });
    } catch (e) {
      set({ loading: false });
      console.error("search failed", e);
    }
  },

  loadMore: async () => {
    const s = get();
    if (s.loading || s.loadingMore || s.items.length >= s.total) return;
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
      set((st) => ({ items: [...st.items, ...res.items], loadingMore: false }));
    } catch (e) {
      set({ loadingMore: false });
      console.error("loadMore failed", e);
    }
  },

  playStation: async (station) => {
    try {
      const info = await Service.playStation(station.stationuuid);
      player.play(info);
      set({ station: info.station, title: "", icyName: "", artworkUrl: "" });
    } catch (e) {
      console.error("playStation failed", e);
      set({ station, playState: "failed" });
    }
  },

  playLastStation: async () => {
    const uuid = get().status?.lastStationUUID;
    if (!uuid) return;
    try {
      const info = await Service.playStation(uuid);
      player.play(info);
      set({ station: info.station, title: "", icyName: "", artworkUrl: "" });
    } catch (e) {
      console.error("resume failed", e);
    }
  },

  playURL: async (url) => {
    try {
      const info = await Service.playURL(url);
      player.play(info);
      set({ station: info.station, title: "", icyName: "", artworkUrl: "" });
    } catch (e) {
      console.error("playURL failed", e);
    }
  },

  togglePlay: () => {
    const s = get();
    if (s.playState === "idle") {
      void s.playLastStation();
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
      }));
    }
  },

  syncNow: () => {
    set({ syncProgress: null });
    Service.syncNow().catch((e) => console.error("sync failed", e));
  },

  init: async () => {
    // Player snapshots flow into the store, and their state into the
    // system's media controls (Now Playing, media keys).
    player.onSnapshot = (snap) => {
      set({ playState: snap.state, station: snap.station ?? get().station });
      Service.reportPlaybackState(snap.state).catch(() => {});
    };

    // The media keys and Control Center toggle playback through the same
    // path as the play button.
    events.mediaCommand.on((action: string) => {
      if (action === "toggle") get().togglePlay();
    });

    events.icyMeta.on((m: Meta) => {
      set((st) => ({
        title: m.title || st.title,
        icyName: m.name || st.icyName,
        // Empty means the stream explicitly has no cover: fall back to
        // the station logo rather than keeping a stale one.
        artworkUrl: m.artworkUrl,
        // icy-name can upgrade an ephemeral URL's display name.
        station:
          st.station && !st.station.stationuuid && m.name
            ? { ...st.station, name: m.name }
            : st.station,
      }));
    });
    events.syncProgress.on((p: Progress) => set({ syncProgress: p }));
    events.syncDone.on((r: SyncResult) => {
      set({ syncProgress: null, lastSyncResult: r });
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
