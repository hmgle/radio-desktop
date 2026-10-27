import { useEffect, useState } from "react";
import { useRadio } from "../store";
import { player } from "../player";
import { EqBars, HeartIcon, RadioIcon, flagEmoji } from "./ui";

/**
 * The full-window Now Playing layer mygo-cloudmusic style: the track's
 * cover or the station's logo large, what the stream says is playing,
 * and the controls. Opens from the player bar; Escape or the backdrop
 * closes it.
 */
export function NowPlayingLayer() {
  const open = useRadio((s) => s.nowPlayingOpen);
  const openNowPlaying = useRadio((s) => s.openNowPlaying);
  const { station, title, icyName, playState, artworkUrl, volume, togglePlay, setVolume, toggleFavorite } =
    useRadio();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openNowPlaying(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, openNowPlaying]);

  if (!open || !station) return null;

  const playing = playState === "playing";
  const subtitle = title || "—";

  return (
    <div
      className="np-layer fixed inset-0 z-40 flex flex-col bg-black/50 backdrop-blur-2xl"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) openNowPlaying(false);
      }}
    >
      <div className="flex justify-end p-4">
        <button
          type="button"
          onClick={() => openNowPlaying(false)}
          className="rounded-full bg-white/10 p-2 text-white/80 transition-colors hover:bg-white/20"
          title="关闭 (Esc)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="np-layer-body flex flex-1 flex-col items-center justify-center gap-6 px-8 pb-16">
        <CoverBig url={artworkUrl || station.favicon} playing={playing} />

        <div className="max-w-xl text-center">
          <h2 className="flex items-center justify-center gap-2 text-xl font-semibold text-white">
            {playing && <EqBars />}
            {station.name}
          </h2>
          <p className="mt-1 text-sm text-white/60">
            {[station.country && `${flagEmoji(station.countrycode) || "🌍"} ${station.country}`,
              icyName && icyName !== station.name && icyName,
              station.bitrate && `${station.bitrate}kbps`,
              station.codec?.toUpperCase()]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p
            className={`mt-3 text-base ${title ? "text-white/90" : "text-white/40"}`}
            title={subtitle}
          >
            {playing || playState === "connecting" ? subtitle : "未在播放"}
          </p>
          {station.tagsList.length > 0 && (
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {station.tagsList.slice(0, 6).map((tag) => (
                <span key={tag} className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void toggleFavorite(station)}
            className={`rounded-full p-3 transition-colors ${
              station.favorite ? "text-[var(--accent)]" : "text-white/50 hover:text-white"
            }`}
            title={station.favorite ? "取消收藏" : "收藏"}
          >
            <HeartIcon filled={station.favorite} />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-xl transition-transform hover:scale-105 active:scale-95"
            title={playing ? "暂停" : "播放"}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="ml-1 h-6 w-6">
                <path d="M8 5.5v13a.6.6 0 0 0 .92.5l10.2-6.5a.6.6 0 0 0 0-1L8.92 5A.6.6 0 0 0 8 5.5z" />
              </svg>
            )}
          </button>
          <div className="flex items-center gap-2 pl-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-white/50">
              <path d="M4 9.5v5h3.2L12 18.7V5.3L7.2 9.5H4z" fill="currentColor" stroke="none" />
              {volume === 0 ? (
                <path d="m15.5 9.5 5 5m0-5-5 5" strokeLinecap="round" />
              ) : (
                <path d="M15.5 8.8a4.8 4.8 0 0 1 0 6.4M18 6.5a8 8 0 0 1 0 11" strokeLinecap="round" />
              )}
            </svg>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-white/20 accent-[var(--accent)]"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            player.stop();
            openNowPlaying(false);
          }}
          className="text-xs text-white/40 transition-colors hover:text-white/70"
        >
          停止播放
        </button>
      </div>
    </div>
  );
}

function CoverBig(props: { url?: string; playing: boolean }) {
  const { url, playing } = props;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  return (
    <div className="relative flex h-72 w-72 items-center justify-center overflow-hidden rounded-3xl bg-white/5 shadow-2xl">
      {url && !failed ? (
        <img
          key={url}
          src={url}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <RadioIcon className="h-24 w-24 text-white/20" />
      )}
      {playing && (
        <span className="absolute inset-x-0 bottom-0 flex h-6 items-end justify-center gap-[3px] bg-gradient-to-t from-black/70 to-transparent pb-1.5">
          <span className="eq-bar block h-3 w-1 rounded-sm bg-white" />
          <span className="eq-bar block h-3 w-1 rounded-sm bg-white" />
          <span className="eq-bar block h-3 w-1 rounded-sm bg-white" />
        </span>
      )}
    </div>
  );
}
