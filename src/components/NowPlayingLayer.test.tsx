// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Service, type Station } from "../mygo";
import { useRadio } from "../store";
import { NowPlayingLayer } from "./NowPlayingLayer";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: { copyText: vi.fn(), openHomepage: vi.fn() }, events: {} }));

const station: Station = {
  stationuuid: "radio-1", name: "Test Radio", url: "https://radio.example/original",
  url_resolved: "https://cdn.example/live.mp3", homepage: "https://radio.example/",
  favicon: "https://radio.example/logo.png", country: "China", countrycode: "CN",
  state: "Shanghai", language: "Chinese", languagecodes: "zh", tags: "",
  tagsList: ["jazz", "soul", "news", "culture", "talk", "music", "local", "jazz"],
  codec: "mp3", bitrate: 128, hls: 0, votes: 0, clickcount: 0, custom: false, favorite: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Service.copyText).mockResolvedValue(undefined);
  vi.mocked(Service.openHomepage).mockResolvedValue(undefined);
  useRadio.setState({ nowPlayingOpen: true, station: { ...station }, playState: "playing",
    title: "Artist — Song", icyName: "", artworkUrl: "", volume: 80, playbackError: "",
    togglePlay: vi.fn(), toggleFavorite: vi.fn(), setVolume: vi.fn(), handleUICommand: vi.fn() });
});
afterEach(cleanup);

it("shows all station details and tags, with resolved and original stream addresses", () => {
  render(<NowPlayingLayer />);
  expect(screen.getByRole("dialog", { name: "Station details" })).toBeTruthy();
  for (const text of ["Test Radio", "Artist — Song", "China · Shanghai", "Chinese", "MP3", "128 kbps", "local", station.url, station.url_resolved, station.homepage]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  expect(screen.getAllByText("jazz")).toHaveLength(1);
});

it("copies the selected address and opens the homepage through the desktop service", async () => {
  render(<NowPlayingLayer />);
  fireEvent.click(screen.getByRole("button", { name: "Copy · Stream address" }));
  await waitFor(() => expect(Service.copyText).toHaveBeenCalledWith(station.url_resolved));
  expect((await screen.findAllByText("Copied")).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /Open homepage/ }));
  await waitFor(() => expect(Service.openHomepage).toHaveBeenCalledWith(station.homepage));
});

it("shows action failures and clears copied state when the station changes", async () => {
  vi.mocked(Service.copyText).mockRejectedValueOnce(new Error("unavailable"));
  vi.mocked(Service.openHomepage).mockRejectedValueOnce(new Error("unavailable"));
  render(<NowPlayingLayer />);
  fireEvent.click(screen.getByRole("button", { name: "Copy · Stream address" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Could not copy");
  fireEvent.click(screen.getByRole("button", { name: /Open homepage/ }));
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Copy · Stream address" }));
  await screen.findAllByText("Copied");
  act(() => useRadio.setState({ station: { ...station, stationuuid: "radio-2" } }));
  expect(screen.queryAllByText("Copied")).toHaveLength(0);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

it("handles URL previews and missing metadata without duplicate address rows or zero bitrate", () => {
  useRadio.setState({ station: { ...station, stationuuid: "", url_resolved: "", homepage: "", country: "", countrycode: "", state: "", language: "", codec: "", bitrate: 0, tagsList: [], tags: "" }, title: "", playState: "connecting" });
  render(<NowPlayingLayer />);
  expect(screen.getByText("URL preview")).toBeTruthy();
  expect(screen.getByText("Connecting…")).toBeTruthy();
  expect(screen.getByText("No track information provided")).toBeTruthy();
  expect(screen.getByText("No tags provided")).toBeTruthy();
  expect(screen.queryByText("0 kbps")).toBeNull();
  expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(1);
});

it("falls back from artwork to the station logo, then to the radio symbol", () => {
  useRadio.setState({ artworkUrl: "https://art.example/cover.png" });
  const { container } = render(<NowPlayingLayer />);
  const cover = () => container.querySelector('img[src^="https://"]')!;
  expect(cover().getAttribute("src")).toBe("https://art.example/cover.png");
  fireEvent.error(cover());
  expect(cover().getAttribute("src")).toBe(station.favicon);
  fireEvent.error(cover());
  expect(cover()).toBeNull();
});

it("keeps focus inside the details and restores the player trigger on Escape", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  render(<NowPlayingLayer />);
  const close = screen.getByRole("button", { name: "Close (Esc)" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy · Station homepage" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("shows playback failures and keeps the controls usable", () => {
  useRadio.setState({ playState: "failed", playbackError: "radio:errorNetwork" });
  render(<NowPlayingLayer />);
  expect(screen.getByText(/Cannot connect to the station/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(useRadio.getState().togglePlay).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "42" } });
  expect(useRadio.getState().setVolume).toHaveBeenCalledWith(42);
  fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
  expect(useRadio.getState().handleUICommand).toHaveBeenCalledWith("stop");
  expect(screen.getByRole("dialog")).toBeTruthy();
});
