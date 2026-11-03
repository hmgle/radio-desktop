import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult, Station } from "./mygo";

vi.mock("./player", () => ({ player: { setVolume: vi.fn(), arm: vi.fn(), stop: vi.fn(), toggle: vi.fn() } }));
vi.mock("./mygo", () => ({
  Service: { search: vi.fn(), getStatus: vi.fn(), reportPlaybackState: vi.fn() },
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
});
