import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult, Station } from "./mygo";

vi.mock("./player", () => ({ player: { setVolume: vi.fn(), arm: vi.fn(), stop: vi.fn(), toggle: vi.fn(), play: vi.fn() } }));
vi.mock("./mygo", () => ({
  Service: { search: vi.fn(), getStatus: vi.fn(), getPlayInfo: vi.fn(), setLastSource: vi.fn().mockResolvedValue(undefined), getSettings: vi.fn().mockResolvedValue({ language: "system", appearance: "system", resume: "selection", autoSyncDays: 7, closeBehavior: "hide" }), reportPlaybackState: vi.fn(), playStation: vi.fn(), playURL: vi.fn(), setVolume: vi.fn().mockResolvedValue(undefined) },
  events: Object.fromEntries(["mediaCommand", "uiCommand", "icyMeta", "syncProgress", "syncDone", "settingsChanged"].map((name) => [name, { on: vi.fn() }])),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("radio store", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "all", lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    vi.mocked(Service.search).mockResolvedValue({ items: [], total: 0 });
    await Promise.all([useRadio.getState().init(), useRadio.getState().init()]);
    expect(events.mediaCommand.on).toHaveBeenCalledTimes(1);
    expect(events.uiCommand.on).toHaveBeenCalledTimes(1);
  });

  it("rejects stale metadata and clears an empty track title", async () => {
    const { Service, events } = await import("./mygo");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "all", lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
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

  it("shows player failure reasons and clears them when playback resumes", async () => {
    const { Service } = await import("./mygo");
    const { player } = await import("./player");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "all", lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    vi.mocked(Service.search).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(Service.reportPlaybackState).mockResolvedValue(undefined);
    await useRadio.getState().init();
    player.onSnapshot!({ state: "failed", station: { name: "Test" } as Station, error: "播放被系统阻止，请点击播放重试" });
    expect(useRadio.getState().playbackError).toContain("播放被系统阻止");
    player.onSnapshot!({ state: "playing", station: { name: "Test" } as Station, error: "" });
    expect(useRadio.getState().playbackError).toBe("");
  });

  it("applies metadata received before the play response", async () => {
    const { Service, events } = await import("./mygo");
    const { useRadio } = await import("./store");
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "all", lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
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

  it("cleans up a play response arriving after stop without restarting audio", async () => {
    const { Service } = await import("./mygo");
    const { player } = await import("./player");
    const { useRadio } = await import("./store");
    const pending = deferred<Awaited<ReturnType<typeof Service.playURL>>>();
    vi.mocked(Service.playURL).mockReturnValue(pending.promise);
    vi.mocked(Service.reportPlaybackState).mockResolvedValue(undefined);
    const play = useRadio.getState().playURL("https://example.com/live");
    useRadio.getState().handleUICommand("stop");
    pending.resolve({ sessionId: 7, station: { stationuuid: "" } as Station, candidates: ["https://example.com/live"] });
    await play;
    expect(player.play).not.toHaveBeenCalled();
    expect(Service.reportPlaybackState).toHaveBeenCalledWith("idle", 7);
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

  it("flushes pending volume and recovers a value newer than the backend", async () => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => values.set(key, value), getItem: (key: string) => values.get(key) ?? null });
    const { Service } = await import("./mygo");
    let { useRadio } = await import("./store");
    vi.mocked(Service.setVolume).mockClear();
    useRadio.getState().setVolume(37);
    expect(values.get("radio.volume")).toBe("37");
    expect(Service.setVolume).not.toHaveBeenCalled();
    await useRadio.getState().flushVolume();
    expect(Service.setVolume).toHaveBeenCalledWith(37);
    useRadio.getState().setVolume(42);
    vi.clearAllTimers(); // simulate closing before the debounce fires
    vi.resetModules();
    ({ useRadio } = await import("./store"));
    vi.mocked(Service.getStatus).mockResolvedValue({ volume: 37, lastSource: "all", lastStationUUID: "", lastSyncAt: 0, catalogSize: 0, syncing: false });
    await useRadio.getState().init();
    expect(useRadio.getState().volume).toBe(42);
    expect(Service.setVolume).toHaveBeenLastCalledWith(42);
  });
});

it.each(["off", "selection", "play"])("restores startup mode %s", async (resume) => {
  vi.resetModules();
  const { Service } = await import("./mygo");
  const { player } = await import("./player");
  const { useRadio } = await import("./store");
  vi.mocked(Service.getSettings).mockResolvedValue({ language: "system", appearance: "system", resume, autoSyncDays: 7, closeBehavior: "hide" });
  vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "favorites", lastStationUUID: "last", lastSyncAt: 0, catalogSize: 1, syncing: false });
  const station = { stationuuid: "last", name: "Last" } as Station;
  vi.mocked(Service.getPlayInfo).mockResolvedValue({ station, candidates: ["https://test/stream"], sessionId: 0 });
  const play = vi.fn().mockResolvedValue(undefined);
  useRadio.setState({ playStation: play });
  vi.mocked(player.arm).mockClear();
  await useRadio.getState().init();
  expect(useRadio.getState().source).toBe(resume === "off" ? "all" : "favorites");
  expect(player.arm).toHaveBeenCalledTimes(resume === "selection" ? 1 : 0);
  expect(play).toHaveBeenCalledTimes(resume === "play" ? 1 : 0);
});

it("does not arm an old startup selection after the listener stops", async () => {
  vi.resetModules();
  const { Service } = await import("./mygo");
  const { player } = await import("./player");
  const { useRadio } = await import("./store");
  vi.mocked(Service.getSettings).mockResolvedValue({ language: "system", appearance: "system", resume: "selection", autoSyncDays: 7, closeBehavior: "hide" });
  vi.mocked(Service.getStatus).mockResolvedValue({ volume: 80, lastSource: "all", lastStationUUID: "last", lastSyncAt: 0, catalogSize: 1, syncing: false });
  const info = deferred<Awaited<ReturnType<typeof Service.getPlayInfo>>>();
  vi.mocked(Service.getPlayInfo).mockReturnValue(info.promise);
  vi.mocked(player.arm).mockClear();
  const init = useRadio.getState().init();
  await vi.waitFor(() => expect(Service.getPlayInfo).toHaveBeenCalled());
  useRadio.getState().handleUICommand("stop");
  info.resolve({ station: { stationuuid: "last" } as Station, candidates: ["https://test/stream"], sessionId: 0 });
  await init;
  expect(player.arm).not.toHaveBeenCalled();
});
