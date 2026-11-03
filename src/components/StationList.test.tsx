// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRadio } from "../store";
import type { Station } from "../mygo";
import { StationList } from "./StationList";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: {}, events: {} }));

let observers: { callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
const station = (id: string): Station => ({ stationuuid: id, name: id, tagsList: [] } as unknown as Station);

beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
    }
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  Element.prototype.scrollIntoView = vi.fn();
  useRadio.setState({ items: [], total: 0, loading: false, loadingMore: false,
    loadMore: vi.fn().mockResolvedValue(undefined), playStation: vi.fn().mockResolvedValue(undefined),
    toggleFavorite: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("observes a sentinel appearing after an empty/loading render, including refresh", () => {
  render(<StationList />);
  expect(observers).toHaveLength(0);
  act(() => useRadio.setState({ loading: true }));
  act(() => useRadio.setState({ loading: false, items: [station("a")], total: 3 }));
  expect(observers).toHaveLength(1);
  expect(observers[0]!.observe).toHaveBeenCalledWith(expect.any(HTMLElement));
  act(() => observers[0]!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(useRadio.getState().loadMore).toHaveBeenCalledTimes(1);
  act(() => useRadio.setState({ loading: true, items: [] }));
  expect(observers[0]!.disconnect).toHaveBeenCalled();
  act(() => useRadio.setState({ loading: false, items: [station("b")], total: 2 }));
  expect(observers).toHaveLength(2);
});

it("keeps arrow navigation on row buttons without playing on their Enter", () => {
  useRadio.setState({ items: [station("a"), station("b")], total: 2 });
  render(<StationList />);
  const heart = screen.getAllByTitle("收藏")[0]!;
  fireEvent.keyDown(heart, { key: "ArrowDown" });
  fireEvent.keyDown(heart, { key: "Enter" });
  expect(useRadio.getState().playStation).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByLabelText("电台列表"), { key: "Enter" });
  expect(useRadio.getState().playStation).toHaveBeenCalledWith(expect.objectContaining({ stationuuid: "a" }));
});
