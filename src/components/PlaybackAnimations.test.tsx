// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { PlayerBar } from "./PlayerBar";
import { StationList } from "./StationList";
import { NowPlayingLayer } from "./NowPlayingLayer";
import { defaultSettings, useSettings } from "../settings";
import { useRadio } from "../store";
import { Service, type Station } from "../mygo";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: { updateSettings: vi.fn() }, events: {} }));

const station: Station = {
  stationuuid: "sample", name: "Sample", tags: "", tagsList: [], url: "https://example.com/live.mp3",
  url_resolved: "", homepage: "", favicon: "", country: "", countrycode: "", state: "", language: "",
  languagecodes: "", codec: "MP3", bitrate: 128, hls: 0, votes: 0, clickcount: 0, custom: false, favorite: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  useSettings.setState({ value: { ...defaultSettings }, ready: true, saving: false, error: "" });
  useRadio.setState({ station, items: [], total: 0,
    playState: "playing", nowPlayingOpen: false, dialog: null, settingsOpen: false,
    sleepTimer: { deadline: 0, generation: 0, expired: false } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps all playback indicators static by default and applies the saved setting immediately", async () => {
  const { container } = render(<><PlayerBar /><SettingsPage /></>);
  const control = screen.getByRole("combobox", { name: "Playback animation" }) as HTMLSelectElement;
  expect(control.value).toBe("false");
  expect(container.querySelectorAll(".eq-bars")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  vi.mocked(Service.updateSettings).mockResolvedValueOnce({ ...defaultSettings, playbackAnimations: true });
  await act(async () => { fireEvent.change(control, { target: { value: "true" } }); });
  expect(Service.updateSettings).toHaveBeenLastCalledWith({ playbackAnimations: true });
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(250));
  expect(container.querySelectorAll(".eq-bars[data-frame]")).toHaveLength(2);
  vi.mocked(Service.updateSettings).mockResolvedValueOnce(defaultSettings);
  await act(async () => { fireEvent.change(control, { target: { value: "false" } }); });
  expect(Service.updateSettings).toHaveBeenLastCalledWith({ playbackAnimations: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(container.querySelectorAll(".eq-bars[data-frame]")).toHaveLength(0);
});

it("keeps the previous animation preference after a save failure", async () => {
  render(<><PlayerBar /><SettingsPage /></>);
  vi.mocked(Service.updateSettings).mockRejectedValueOnce(new Error("disk full"));
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "Playback animation" }), { target: { value: "true" } });
  });
  expect(useSettings.getState().value.playbackAnimations).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
});

it("stops obscured indicators and shares the clock with the details view", () => {
  useSettings.setState({ value: { ...defaultSettings, playbackAnimations: true } });
  useRadio.setState({ items: [useRadio.getState().station!], total: 1 });
  const { container } = render(<><StationList /><PlayerBar /><NowPlayingLayer /></>);
  act(() => vi.advanceTimersByTime(250));
  expect(container.querySelectorAll(".eq-bars[data-frame]")).toHaveLength(3);
  act(() => useRadio.setState({ nowPlayingOpen: true }));
  act(() => vi.advanceTimersByTime(250));
  expect(container.querySelectorAll(".eq-bars[data-frame]")).toHaveLength(1);
  expect(screen.getByRole("dialog").querySelector(".eq-bars[data-frame]")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);
  act(() => useRadio.setState({ nowPlayingOpen: false, playState: "paused" }));
  expect(container.querySelectorAll(".eq-bars")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
