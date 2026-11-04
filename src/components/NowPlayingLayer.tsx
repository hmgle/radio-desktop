import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorText } from "../i18n";
import { messages as m } from "../locales";
import { Service } from "../mygo";
import { useRadio } from "../store";
import { Modal } from "./Dialogs";
import { EqBars, HeartIcon, RadioIcon, CountryFlag } from "./ui";

export function NowPlayingLayer() {
  const open = useRadio((s) => s.nowPlayingOpen);
  const station = useRadio((s) => s.station);
  const openNowPlaying = useRadio((s) => s.openNowPlaying);

  if (!open || !station) return null;

  return (
    <Modal
      title={m.stationDetails()}
      onClose={() => openNowPlaying(false)}
      className="np-layer relative flex h-full w-full flex-col bg-[var(--app-bg)] px-6 pt-5 text-[var(--app-text)] sm:px-8"
    >
      <button
        type="button"
        onClick={() => openNowPlaying(false)}
        className="absolute right-6 top-3 rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-800"
        aria-label={m.closeEsc()}
        title={m.closeEsc()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
      <StationDetails key={station.stationuuid || station.url} />
    </Modal>
  );
}

function StationDetails() {
  const { station, title, icyName, playState, playbackError, artworkUrl, volume, togglePlay, setVolume, toggleFavorite } =
    useRadio(useShallow((s) => ({ station: s.station, title: s.title, icyName: s.icyName, playState: s.playState, playbackError: s.playbackError, artworkUrl: s.artworkUrl, volume: s.volume, togglePlay: s.togglePlay, setVolume: s.setVolume, toggleFavorite: s.toggleFavorite })));
  if (!station) return null;

  const playing = playState === "playing";
  const active = playing || playState === "connecting";
  const status = {
    playing: m.playing(), connecting: m.connecting(), paused: m.paused(),
    ready: m.ready(), idle: m.notPlaying(), failed: m.failed(),
  }[playState];
  const location = [station.country || station.countrycode, station.state].filter(Boolean).join(" · ");
  const tags = [...new Set((station.tagsList?.length ? station.tagsList : (station.tags || "").split(",")).map((tag) => tag.trim()).filter(Boolean))];
  const streamURL = station.url_resolved || station.url;
  const unknown = m.unknown();

  return (
    <div className="np-layer-body min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 pt-3">
      <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[250px_minmax(0,1fr)] lg:gap-12">
        <section aria-label={m.nowPlaying()} className="flex min-w-0 flex-col items-center gap-5 pt-1">
          <CoverBig artwork={active ? artworkUrl : ""} favicon={station.favicon} />
          <div className="w-full text-center">
            <p role="status" className={`flex items-center justify-center gap-2 text-xs font-medium ${playState === "failed" ? "text-red-600 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}`}>
              {playing && <EqBars />}{status}
            </p>
            <p className="mt-2 break-words text-base font-medium leading-relaxed">
              {playState === "failed" ? errorText(playbackError) || m.failed() : active ? title || m.noTrackInfo() : m.notPlaying()}
            </p>
            {icyName && icyName !== station.name && <p className="mt-1 break-words text-xs text-neutral-500 dark:text-neutral-400">{icyName}</p>}
          </div>
          <div className="flex items-center justify-center gap-5">
            {station.stationuuid && (
              <button type="button" onClick={() => void toggleFavorite(station)} aria-label={station.favorite ? m.unfavorite() : m.favorite()} title={station.favorite ? m.unfavorite() : m.favorite()} className={`rounded-full p-3 hover:bg-neutral-200 dark:hover:bg-neutral-800 ${station.favorite ? "text-[var(--accent)]" : "text-neutral-500"}`}>
                <HeartIcon filled={station.favorite} />
              </button>
            )}
            <button type="button" onClick={togglePlay} aria-label={active ? m.pause() : m.play()} title={active ? m.pause() : m.play()} className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-lg transition-transform hover:scale-105 active:scale-95">
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6" aria-hidden="true">
                {active ? <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></> : <path d="M8 5.5v13a.6.6 0 0 0 .92.5l10.2-6.5a.6.6 0 0 0 0-1L8.92 5A.6.6 0 0 0 8 5.5z" />}
              </svg>
            </button>
            <button type="button" onClick={() => useRadio.getState().handleUICommand("stop")} aria-label={m.stop()} title={m.stop()} className="rounded-full p-3 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800">
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            </button>
          </div>
          <label className="flex w-full items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <span>{m.volume()}</span>
            <input aria-label={m.volume()} type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" />
            <span className="w-8 text-right tabular-nums">{volume}%</span>
          </label>
        </section>

        <section aria-label={m.stationInfo()} className="min-w-0">
          <p className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">{!station.stationuuid ? m.temporaryStation() : station.custom ? m.custom() : m.stationInfo()}</p>
          <h3 className="break-words text-2xl font-semibold tracking-tight">{station.name}</h3>

          <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <InfoItem label={m.region()}><CountryFlag code={station.countrycode} className="mr-1.5" />{location || unknown}</InfoItem>
            <InfoItem label={m.language()}>{station.language || unknown}</InfoItem>
            <InfoItem label={m.audioFormat()}>{[station.codec?.toUpperCase(), station.hls ? "HLS" : ""].filter(Boolean).join(" · ") || unknown}</InfoItem>
            <InfoItem label={m.bitrate()}>{station.bitrate > 0 ? `${station.bitrate} kbps` : unknown}</InfoItem>
          </dl>

          <div className="mt-6">
            <h4 className="mb-2.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">{m.tags()}</h4>
            {tags.length ? <div className="flex flex-wrap gap-1.5">{tags.map((tag) => <span key={tag} className="max-w-full break-words rounded-lg bg-neutral-200/70 px-2.5 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{tag}</span>)}</div> : <p className="text-sm text-neutral-500 dark:text-neutral-400">{m.noTags()}</p>}
          </div>

          <div className="mt-6 space-y-4 border-t border-neutral-200 pt-5 dark:border-neutral-800">
            <AddressRow key={`stream:${streamURL}`} label={m.streamAddress()} value={streamURL} />
            {station.url && station.url !== streamURL && <AddressRow key={`original:${station.url}`} label={m.originalStreamAddress()} value={station.url} />}
            {station.homepage && <AddressRow key={`home:${station.homepage}`} label={m.stationHomepage()} value={station.homepage} homepage />}
          </div>
        </section>
      </div>
    </div>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="mb-1 text-xs text-neutral-500 dark:text-neutral-400">{label}</dt><dd className="break-words text-sm font-medium">{children}</dd></div>;
}

function AddressRow({ label, value, homepage = false }: { label: string; value: string; homepage?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setError("");
    try {
      await Service.copyText(value);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("radio:copyFailed");
    }
  };
  const open = async () => {
    setError("");
    try { await Service.openHomepage(value); }
    catch { setError("radio:openHomepageFailed"); }
  };

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</h4>
        {value && <div className="flex gap-3 text-xs font-medium">
          {homepage && /^https?:\/\//i.test(value.trim()) && <button type="button" onClick={() => void open()} className="text-[var(--accent)] hover:underline">{m.openHomepage()} ↗</button>}
          <button type="button" onClick={() => void copy()} aria-label={`${m.copy()} · ${label}`} className="text-[var(--accent)] hover:underline">{copied ? m.copied() : m.copy()}</button>
        </div>}
      </div>
      <p className="select-text break-all rounded-lg bg-neutral-200/50 px-3 py-2.5 font-mono text-xs leading-relaxed text-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300">{value || m.unknown()}</p>
      <span role="status" className="sr-only">{copied ? m.copied() : ""}</span>
      {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errorText(error)}</p>}
    </div>
  );
}

function CoverBig({ artwork, favicon }: { artwork?: string; favicon?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => setFailed([]), [artwork, favicon]);
  const src = [artwork, favicon].find((url) => url && !failed.includes(url));

  return (
    <div className="flex aspect-square w-full max-w-64 items-center justify-center overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
      {src ? <img key={src} src={src} alt="" onError={() => setFailed((urls) => [...urls, src])} className="h-full w-full object-contain p-5" /> : <RadioIcon className="h-24 w-24 text-[var(--accent)]" />}
    </div>
  );
}
