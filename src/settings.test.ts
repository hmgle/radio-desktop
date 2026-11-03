import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./mygo", () => ({
  Service: { getSettings: vi.fn(), updateSettings: vi.fn() },
  events: { settingsChanged: { on: vi.fn() } },
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it("serializes partial updates and retains settings after a failed save", async () => {
  const { Service } = await import("./mygo");
  const { useSettings, defaultSettings } = await import("./settings");
  vi.mocked(Service.getSettings).mockResolvedValue(defaultSettings);
  await useSettings.getState().load();
  let release!: () => void;
  vi.mocked(Service.updateSettings).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { ...defaultSettings, appearance: "dark" };
  }).mockRejectedValueOnce(new Error("disk full"));
  const first = useSettings.getState().update({ appearance: "dark" });
  const second = useSettings.getState().update({ language: "en" });
  await Promise.resolve();
  expect(Service.updateSettings).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(useSettings.getState().value.appearance).toBe("dark");
  expect(useSettings.getState().value.language).toBe("system");
  expect(useSettings.getState().error).toContain("disk full");
  expect(useSettings.getState().saving).toBe(false);
});

it("does not replace a settings event with a stale loading response", async () => {
  const { Service, events } = await import("./mygo");
  const { useSettings, defaultSettings } = await import("./settings");
  let resolve!: (v: typeof defaultSettings) => void;
  vi.mocked(Service.getSettings).mockReturnValue(new Promise((r) => { resolve = r; }));
  const loading = useSettings.getState().load();
  vi.mocked(events.settingsChanged.on).mock.calls[0]![0]({ ...defaultSettings, appearance: "dark" });
  resolve(defaultSettings);
  await loading;
  expect(useSettings.getState().value.appearance).toBe("dark");
});
