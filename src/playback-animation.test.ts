// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observePlaybackAnimation } from "./playback-animation";

let intersect: IntersectionObserverCallback;
let motion: MediaQueryList;
let hidden: boolean;
let observers: { observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
let dispose: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  dispose = [];
  observers = [];
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  motion = Object.assign(new EventTarget(), { matches: false }) as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => motion));
  vi.stubGlobal("IntersectionObserver", class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      intersect = callback;
      observers.push(this);
    }
  });
});
afterEach(() => {
  dispose.forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function indicator() {
  const element = document.createElement("span");
  dispose.push(observePlaybackAnimation(element));
  return element;
}
function visibility(element: HTMLElement, visible: boolean) {
  intersect([{ target: element, isIntersecting: visible } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
}

it("shares one clock and updates only visible indicators at most four times per second", () => {
  const first = indicator();
  const second = indicator();
  expect(observers).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  visibility(first, true);
  visibility(second, true);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(249);
  expect(first.hasAttribute("data-frame")).toBe(false);
  vi.advanceTimersByTime(1);
  expect(first.dataset.frame).toBe(second.dataset.frame);
  expect(first.hasAttribute("data-frame")).toBe(true);
  const frame = first.dataset.frame;
  vi.advanceTimersByTime(100);
  expect(first.dataset.frame).toBe(frame);
  visibility(first, false);
  expect(first.hasAttribute("data-frame")).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  visibility(second, false);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops in a hidden document and resumes when visible", () => {
  const element = indicator();
  visibility(element, true);
  vi.advanceTimersByTime(250);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  expect(element.hasAttribute("data-frame")).toBe(false);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(250);
  expect(element.hasAttribute("data-frame")).toBe(true);
});

it("honors reduced motion initially and when the system preference changes", () => {
  Object.assign(motion, { matches: true });
  const element = indicator();
  visibility(element, true);
  expect(vi.getTimerCount()).toBe(0);
  Object.assign(motion, { matches: false });
  motion.dispatchEvent(new Event("change"));
  vi.advanceTimersByTime(250);
  expect(element.hasAttribute("data-frame")).toBe(true);
  Object.assign(motion, { matches: true });
  motion.dispatchEvent(new Event("change"));
  expect(vi.getTimerCount()).toBe(0);
  expect(element.hasAttribute("data-frame")).toBe(false);
});

it("cleans up the last indicator and ignores queued observer callbacks", () => {
  const element = indicator();
  visibility(element, true);
  const oldCallback = intersect;
  dispose.pop()!();
  expect(observers[0]!.unobserve).toHaveBeenCalledWith(element);
  expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  // Re-enabling on the same DOM node must not accept the old observer.
  dispose.push(observePlaybackAnimation(element));
  oldCallback([{ target: element, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(vi.getTimerCount()).toBe(0);
  visibility(element, true);
  expect(vi.getTimerCount()).toBe(1);
});

it("can animate without IntersectionObserver while still respecting document visibility", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const element = indicator();
  vi.advanceTimersByTime(250);
  expect(element.hasAttribute("data-frame")).toBe(true);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
});
