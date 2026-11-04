// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlayerBar } from "./PlayerBar";
import { useRadio } from "../store";
import { player } from "../player";
import type { Station } from "../mygo";

vi.mock("../player", () => ({ player: { stop: vi.fn() } }));
vi.mock("../mygo", () => ({ Service: {}, events: {} }));
afterEach(cleanup);

it("stops a connecting stream while keeping its station selected", () => {
  const station = { stationuuid: "test", name: "Test" } as Station;
  useRadio.setState({ station, playState: "connecting", sessionId: 3 });
  render(<PlayerBar />);
  fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
  expect(player.stop).toHaveBeenCalledOnce();
  expect(useRadio.getState().sessionId).toBe(0);
  expect(useRadio.getState().station).toBe(station);

  act(() => useRadio.setState({ station: null, playState: "idle", nowPlayingOpen: false }));
  fireEvent.click(screen.getByTitle("View station details"));
  expect(useRadio.getState().nowPlayingOpen).toBe(false);
});
