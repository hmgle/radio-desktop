import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult, Station } from "./mygo";

vi.mock("./player", () => ({ player: { setVolume: vi.fn(), arm: vi.fn(), stop: vi.fn(), toggle: vi.fn(), play: vi.fn() } }));
vi.mock("./mygo", () => ({
  Service: { search: vi.fn(), getStatus: vi.fn(), reportPlaybackState: vi.fn(), playStation: vi.fn(), playURL: vi.fn() },
  events: Object.fromEntries(["mediaCommand", "uiCommand", "icyMeta", "syncProgress", "syncDone"].map((name) => [name, { on: vi.fn() }])),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("radio store", () => {
  beforeEach(() => { vi.resetModules(); });

  it("ignores stale search and pagination responses", async () => {
    const { Service } = await import("./mygo");
    const { useRadio } = await import("./store");
    const old = deferred<SearchResult>();
    const fresh = deferred<SearchResult>();
    vi.mocked(Service.search).mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = useRadio.getState().refresh();
    const second = useRadio.getState().refresh();
    fresh.resolve({ items: [{ name: "new" } as Station], total: 1 });
    await second;
    old.resolve({ items: [{ name: "old" } as Station], total: 1 });
    await first;
    expect(useRadio.getState().items[0]?.name).toBe("new");

    const page = deferred<SearchResult>();
    vi.mocked(Service.search).mockReturnValueOnce(page.promise).mockResolvedValueOnce({ items: [{ name: "latest" } as Station], total: 1 });
    useRadio.setState({ total: 2 });
    const more = useRadio.getState().loadMore();
    await useRadio.getState().refresh();
    page.resolve({ items: [{ name: "stale page" } as Station], total: 2 });
    await more;
    expect(useRadio.getState().items.map((s) => s.name)).toEqual(["latest"]);
  });

  it("registers event handlers once across repeated initialization", async () => {
    const { Service, events } = await import("./mygo");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    vi.mocked(Service.search).mockResolvedValue({ items: [], total: 0 });
    await Promise.all([useRadio.getState().init(), useRadio.getState().init()]);
    expect(events.mediaCommand.on).toHaveBeenCalledTimes(1);
    expect(events.uiCommand.on).toHaveBeenCalledTimes(1);
  });

  it("rejects stale metadata and clears an empty track title", async () => {
    const { Service, events } = await import("./mygo");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    vi.mocked(Service.search).mockResolvedValue({ items: [], total: 0 });
    await useRadio.getState().init();
    const listener = vi.mocked(events.icyMeta.on).mock.calls.at(-1)![0];
    useRadio.setState({ station: { stationuuid: "" } as Station, playState: "playing", sessionId: 2, title: "current" });
    listener({ sessionId: 1, meta: { title: "old", name: "wrong station", genre: "", artworkUrl: "old.jpg" } });
    expect(useRadio.getState().title).toBe("current");
    listener({ sessionId: 2, meta: { title: "", name: "", genre: "", artworkUrl: "" } });
    expect(useRadio.getState().title).toBe("");
    expect(useRadio.getState().artworkUrl).toBe("");
  });

  it("applies metadata received before the play response", async () => {
    const { Service, events } = await import("./mygo");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    vi.mocked(Service.search).mockResolvedValue({ items: [], total: 0 });
    await useRadio.getState().init();
    const pending = deferred<Awaited<ReturnType<typeof Service.playURL>>>();
    vi.mocked(Service.playURL).mockReturnValue(pending.promise);
    const play = useRadio.getState().playURL("https://example.com/live");
    useRadio.setState({ playState: "connecting" });
    vi.mocked(events.icyMeta.on).mock.calls.at(-1)![0]({ sessionId: 3, meta: { title: "early title", name: "", genre: "", artworkUrl: "" } });
    pending.resolve({ sessionId: 3, station: { stationuuid: "" } as Station, candidates: ["https://example.com/live"] });
    await play;
    expect(useRadio.getState().title).toBe("early title");
  });

  it("random playback excludes the current station", async () => {
    const { Service } = await import("./mygo");
    const { useRadio } = await import("./store");
    const playStation = vi.fn().mockResolvedValue(undefined);
    useRadio.setState({ station: { stationuuid: "a" } as Station, playStation });
    vi.mocked(Service.search).mockResolvedValue({ items: [{ stationuuid: "a" }, { stationuuid: "b" }] as Station[], total: 2 });
    useRadio.getState().handleUICommand("random");
    await Promise.resolve();
    expect(playStation).toHaveBeenCalledWith(expect.objectContaining({ stationuuid: "b" }));
  });
});
