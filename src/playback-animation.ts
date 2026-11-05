// One low-frequency clock for visible indicators. CSS infinite animations
// keep WebKit rendering every frame even with steps() timing functions.
const FRAME_MS = 250;
const indicators = new Map<HTMLElement, boolean>();
let timer: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
let frame = 0;

function refresh() {
  const allowed = !document.hidden && !reducedMotion?.matches;
  let visible = false;
  for (const [element, inViewport] of indicators) {
    if (allowed && inViewport) visible = true;
    else element.removeAttribute("data-frame");
  }
  if (visible && timer === null) {
    timer = setInterval(() => {
      frame = (frame + 1) % 4;
      for (const [element, inViewport] of indicators) {
        if (inViewport) element.dataset.frame = String(frame);
      }
    }, FRAME_MS);
  } else if (!visible && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function observePlaybackAnimation(element: HTMLElement): () => void {
  if (indicators.size === 0) {
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reducedMotion?.addEventListener("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    if (typeof IntersectionObserver !== "undefined") {
      const instance = new IntersectionObserver((entries) => {
        if (observer !== instance) return;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (indicators.has(target)) indicators.set(target, entry.isIntersecting);
        }
        refresh();
      });
      observer = instance;
    }
  }
  indicators.set(element, observer === null);
  observer?.observe(element);
  refresh();
  return () => {
    observer?.unobserve(element);
    indicators.delete(element);
    element.removeAttribute("data-frame");
    refresh();
    if (indicators.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", refresh);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}
