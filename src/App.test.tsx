// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { useRadio } from "./store";

vi.mock("./player", () => ({ player: { stop: vi.fn() } }));
vi.mock("./mygo", () => ({ Service: {}, events: {} }));
vi.mock("mygo-runtime", () => ({ currentWindow: { setTitle: vi.fn().mockResolvedValue(undefined) }, isMyGo: () => false }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <aside /> }));
vi.mock("./components/FilterBar", () => ({ FilterBar: () => <input id="search-input" aria-label="Search" /> }));
vi.mock("./components/StationList", () => ({ StationList: () => <div>stations</div> }));
vi.mock("./components/PlayerBar", () => ({ PlayerBar: () => <footer /> }));
vi.mock("./components/NowPlayingLayer", () => ({ NowPlayingLayer: () => useRadio((s) => s.nowPlayingOpen) ? <button>Now playing</button> : null }));
vi.mock("./components/SettingsPage", () => ({ SettingsPage: () => <div>preferences</div> }));
vi.mock("./components/Dialogs", () => ({ AddStationDialog: () => <div role="dialog">add</div>, PlayURLDialog: () => <div role="dialog">url</div> }));

beforeEach(() => {
  useRadio.setState({ init: vi.fn().mockResolvedValue(undefined), togglePlay: vi.fn(), settingsOpen: false, nowPlayingOpen: false, dialog: null });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { return window.setTimeout(() => callback(0), 0); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens preferences by keyboard without unmounting the station view", async () => {
  render(<App />);
  const list = screen.getByText("stations");
  fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
  expect(screen.getByText("preferences")).toBeTruthy();
  expect(screen.getByText("stations")).toBe(list);
  fireEvent.keyDown(document.body, { code: "Space" });
  expect(useRadio.getState().togglePlay).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  expect(useRadio.getState().settingsOpen).toBe(false);
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search")));
});

it("does not play or focus the hidden search through a modal", () => {
  render(<App />);
  act(() => useRadio.getState().openDialog("add"));
  fireEvent.keyDown(document.body, { code: "Space" });
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
  expect(useRadio.getState().dialog).toBe("add");
  expect(useRadio.getState().settingsOpen).toBe(false);
  expect(useRadio.getState().togglePlay).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(screen.getByLabelText("Search"));
});

it.each(["ctrlKey", "metaKey"])("closes Now Playing before focusing search with %s+F", async (modifier) => {
  useRadio.setState({ nowPlayingOpen: true });
  render(<App />);
  const overlay = screen.getByRole("button", { name: "Now playing" });
  overlay.focus();
  fireEvent.keyDown(overlay, { key: "f", [modifier]: true });
  expect(useRadio.getState().nowPlayingOpen).toBe(false);
  expect(screen.queryByRole("button", { name: "Now playing" })).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Search")));
});

it("keeps a local confirmation modal open when settings shortcuts are pressed", () => {
  useRadio.setState({ settingsOpen: true });
  render(<><App /><div role="dialog" aria-modal="true"><button>Confirm</button></div></>);
  const confirm = screen.getByRole("button", { name: "Confirm" });
  confirm.focus();
  const openSettings = vi.spyOn(useRadio.getState(), "openSettings");
  fireEvent.keyDown(confirm, { key: ",", ctrlKey: true });
  fireEvent.keyDown(confirm, { key: ",", metaKey: true });
  fireEvent.keyDown(confirm, { key: "f", ctrlKey: true });
  act(() => {
    for (const command of ["settings", "add", "playURL"]) useRadio.getState().handleUICommand(command);
  });
  expect(openSettings).not.toHaveBeenCalled();
  expect(useRadio.getState().dialog).toBeNull();
  expect(document.activeElement).toBe(confirm);
  expect(useRadio.getState().settingsOpen).toBe(true);
  openSettings.mockRestore();
});

it("does not move focus behind an overlay opened before the next animation frame", () => {
  let nextFrame!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  render(<App />);
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  act(() => useRadio.getState().openNowPlaying(true));
  const overlay = screen.getByRole("button", { name: "Now playing" });
  overlay.focus();
  act(() => nextFrame(0));
  expect(document.activeElement).toBe(overlay);
});
