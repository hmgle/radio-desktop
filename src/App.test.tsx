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
vi.mock("./components/NowPlayingLayer", () => ({ NowPlayingLayer: () => null }));
vi.mock("./components/SettingsPage", () => ({ SettingsPage: () => <div>preferences</div> }));
vi.mock("./components/Dialogs", () => ({ AddStationDialog: () => <div role="dialog">add</div>, PlayURLDialog: () => <div role="dialog">url</div> }));

beforeEach(() => {
  useRadio.setState({ init: vi.fn().mockResolvedValue(undefined), togglePlay: vi.fn(), settingsOpen: false, dialog: null });
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
  expect(useRadio.getState().togglePlay).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(screen.getByLabelText("Search"));
});
