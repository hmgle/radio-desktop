import { SleepTimerStatus } from "./SleepTimerControl";
import { errorText } from "../i18n";
import { messages as m } from "../locales";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRadio } from "../store";
import { EqBars, HeartIcon, RadioIcon, CountryFlag } from "./ui";


/**
 * Cover image with a fallback chain: track artwork → station favicon →
 * generic icon. A URL that fails to load is skipped until it changes.
 */
function CoverArt(props: { artwork?: string; favicon?: string; playing: boolean }) {
  const { artwork, favicon, playing } = props;
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  useEffect(() => setFailed({}), [artwork, favicon]);

  const sources = [artwork, favicon].filter((u): u is string => !!u && !failed[u]);
  const src = sources[0];

  return (
    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          onError={() => setFailed((f) => ({ ...f, [src]: true }))}
          className="h-11 w-11 object-cover"
        />
      ) : (
        <RadioIcon className="h-5 w-5" />
      )}
      {playing && (
        <span className="absolute inset-x-0 bottom-0 flex h-3.5 items-end justify-center gap-[2px] bg-gradient-to-t from-black/60 to-transparent pb-0.5">
          <span className="eq-bar block h-2 w-[2px] rounded-sm bg-white" />
          <span className="eq-bar block h-2 w-[2px] rounded-sm bg-white" />
          <span className="eq-bar block h-2 w-[2px] rounded-sm bg-white" />
        </span>
      )}
    </div>
  );
}

export function PlayerBar() {
  const STATE_LABEL: Record<string, string> = {
    connecting: m.connecting(),
    ready: m.ready(),
    failed: m.failed(),
  };
  const { station, title, icyName, playState, playbackError, artworkUrl, volume, togglePlay, setVolume, toggleFavorite } =
    useRadio(useShallow((s) => ({ station: s.station, title: s.title, icyName: s.icyName, playState: s.playState, playbackError: s.playbackError, artworkUrl: s.artworkUrl, volume: s.volume, togglePlay: s.togglePlay, setVolume: s.setVolume, toggleFavorite: s.toggleFavorite })));
  const openNowPlaying = useRadio((s) => s.openNowPlaying);

  const playing = playState === "playing";
  const active = playing || playState === "connecting";
  const disabled = !station;
  const subtitle =
    (playState === "failed" ? errorText(playbackError) : "") || title || (icyName && station && icyName !== station.name ? icyName : "") || "—";

  return (
    <footer className="flex h-16 shrink-0 items-center gap-3 border-t border-neutral-200 bg-white/80 px-4 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/70">
      {/* Station identity: click for the big Now Playing view */}
      <button
        type="button"
        onClick={() => openNowPlaying(true)}
        disabled={disabled}
        title={m.viewArtwork()}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-1 py-1 text-left transition-colors hover:bg-neutral-200/40 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-neutral-800/40"
      >
        <CoverArt
          artwork={playing || playState === "connecting" ? artworkUrl : ""}
          favicon={station?.favicon}
          playing={playing}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {playing && <EqBars className="shrink-0" />}
            <p title={station?.name} className="truncate text-sm font-medium">
              {station?.name || m.noStation()}
              {station?.countrycode && (
                <span className="ml-1.5 text-[11px] font-normal text-neutral-400">
                  <CountryFlag code={station.countrycode} className="mr-1" />
                  {station.country || station.countrycode}
                </span>
              )}
            </p>
          </div>
          {/* ICY title */}
          <div className="mt-0.5 overflow-hidden">
            <p
              className={`truncate text-xs text-neutral-500 dark:text-neutral-400 ${
                playState === "failed" ? "text-red-500" : ""
              }`}
              title={subtitle}
            >
              {playing || playState === "connecting" || (playState === "failed" && playbackError) ? subtitle : STATE_LABEL[playState] || subtitle}
            </p>
          </div>
        </div>
      </button>

      <SleepTimerStatus />
      {/* Controls */}
      <div className="flex shrink-0 items-center gap-1.5">
        {station?.stationuuid && (
          <button
            type="button"
            onClick={() => void toggleFavorite(station)}
            className={`rounded-full p-2 transition-colors ${
              station.favorite
                ? "text-[var(--accent)]"
                : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            }`}
            title={station.favorite ? m.unfavorite() : m.favorite()}
          >
            <HeartIcon filled={station.favorite} />
          </button>
        )}
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow transition-transform hover:scale-105 active:scale-95 disabled:opacity-30"
          title={active ? m.pause() : m.play()}
        >
          {active ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4.5 w-4.5">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-4.5 w-4.5">
              <path d="M8 5.5v13a.6.6 0 0 0 .92.5l10.2-6.5a.6.6 0 0 0 0-1L8.92 5A.6.6 0 0 0 8 5.5z" />
            </svg>
          )}
        </button>

        <button type="button" onClick={() => useRadio.getState().handleUICommand("stop")} disabled={disabled || playState === "idle" || playState === "ready"} aria-label={m.stop()} title={m.stop()} className="rounded-full p-2 text-neutral-500 hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-800">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>

        {/* Volume */}
        <div className="flex items-center gap-1.5 pl-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-neutral-400">
            <path d="M4 9.5v5h3.2L12 18.7V5.3L7.2 9.5H4z" fill="currentColor" stroke="none" />
            {volume === 0 ? (
              <path d="m15.5 9.5 5 5m0-5-5 5" strokeLinecap="round" />
            ) : (
              <path d="M15.5 8.8a4.8 4.8 0 0 1 0 6.4M18 6.5a8 8 0 0 1 0 11" strokeLinecap="round" />
            )}
          </svg>
          <input
            aria-label={m.volume()}
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-neutral-300 accent-[var(--accent)] dark:bg-neutral-700"
          />
        </div>
      </div>
    </footer>
  );
}
