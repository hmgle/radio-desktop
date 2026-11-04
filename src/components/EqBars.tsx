import { useEffect, useRef } from "react";
import { observePlaybackAnimation } from "../playback-animation";
import { useSettings } from "../settings";
import { useRadio } from "../store";

/** Decorative playback indicator with optional low-frequency motion. */
export function EqBars({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const enabled = useSettings((s) => s.ready && s.value.playbackAnimations);
  const obscured = useRadio((s) => s.nowPlayingOpen || s.dialog !== null);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || (obscured && !element.closest('[role="dialog"]'))) return;
    return observePlaybackAnimation(element);
  }, [enabled, obscured]);

  const bar = compact ? "h-2 w-[2px] bg-white" : "h-3 w-[3px] bg-[var(--accent)]";
  return (
    <span ref={ref} aria-hidden="true" className={`eq-bars inline-flex ${compact ? "h-2" : "h-3"} items-end gap-[2px] ${className}`}>
      {[0, 1, 2].map((i) => <span key={i} className={`eq-bar block rounded-sm ${bar}`} />)}
    </span>
  );
}
