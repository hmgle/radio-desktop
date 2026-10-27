import { useEffect, useRef, useState } from "react";
import { useRadio } from "../store";
import type { Station } from "../mygo";
import { Service } from "../mygo";
import { EqBars, HeartIcon, RadioIcon, flagEmoji } from "./ui";

function StationRow(props: { station: Station; selected: boolean }) {
  const { station, selected } = props;
  const playStation = useRadio((s) => s.playStation);
  const toggleFavorite = useRadio((s) => s.toggleFavorite);
  const playState = useRadio((s) => s.playState);
  const currentUUID = useRadio((s) => s.station?.stationuuid);
  const active = currentUUID === station.stationuuid;
  const playing = active && playState === "playing";

  const [imgFailed, setImgFailed] = useState(false);

  const meta: string[] = [];
  if (station.countrycode) meta.push(`${flagEmoji(station.countrycode) || "🌍"} ${station.country || station.countrycode}`);
  if (station.bitrate) meta.push(`${station.bitrate}kbps`);
  if (station.codec) meta.push(station.codec.toUpperCase());
  if (station.custom) meta.push("自定义");

  return (
    <div
      data-uuid={station.stationuuid}
      onClick={() => void playStation(station)}
      className={`group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
        active
          ? "bg-[var(--accent)]/8 dark:bg-[var(--accent)]/15"
          : selected
            ? "bg-neutral-200/70 dark:bg-neutral-800/70"
            : "hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60"
      } ${selected ? "ring-1 ring-[var(--accent)]/40" : ""}`}
    >
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
        {station.favicon && !imgFailed ? (
          <img
            src={station.favicon}
            alt=""
            onError={() => setImgFailed(true)}
            className="h-10 w-10 object-contain"
          />
        ) : (
          <RadioIcon className="h-5 w-5" />
        )}
        {playing && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/45">
            <EqBars />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${active ? "font-medium text-[var(--accent)]" : ""}`}>
          {station.name}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
          {meta.length > 0 && <span>{meta.join(" · ")}</span>}
          {station.tagsList.length > 0 && (
            <span className="truncate opacity-70">
              {" · "}
              {station.tagsList.slice(0, 3).join(" / ")}
            </span>
          )}
        </p>
      </div>

      {active && playState === "connecting" && (
        <span className="shrink-0 text-[11px] text-neutral-400">连接中…</span>
      )}
      {active && playState === "failed" && (
        <span className="shrink-0 text-[11px] text-red-500">播放失败</span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void toggleFavorite(station);
        }}
        className={`shrink-0 rounded-lg p-1.5 transition-colors ${
          station.favorite
            ? "text-[var(--accent)]"
            : "text-neutral-300 opacity-0 hover:text-neutral-500 group-hover:opacity-100 dark:text-neutral-600 dark:hover:text-neutral-300"
        }`}
        title={station.favorite ? "取消收藏" : "收藏"}
      >
        <HeartIcon filled={station.favorite} />
      </button>

      {station.custom && (
        <button
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await Service.removeCustomStation(station.stationuuid);
              void useRadio.getState().refresh();
            } catch (err) {
              console.error("remove custom station failed", err);
            }
          }}
          className="shrink-0 rounded-lg p-1.5 text-neutral-300 opacity-0 transition-colors hover:text-red-500 group-hover:opacity-100 dark:text-neutral-600"
          title="删除自定义电台"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function StationList() {
  const { items, total, loading, loadingMore, loadMore, source, refresh, playStation } =
    useRadio();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  // A fresh list starts unselected.
  useEffect(() => setSelectedIdx(-1), [source]);

  // The keyboard selection follows the list into view.
  useEffect(() => {
    if (selectedIdx < 0 || !items[selectedIdx]) return;
    listRef.current
      ?.querySelector(`[data-uuid="${CSS.escape(items[selectedIdx]!.stationuuid)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, items]);

  const onKey = (e: React.KeyboardEvent) => {
    if (items.length === 0) return;
    const clamp = (i: number) => Math.min(items.length - 1, Math.max(0, i));
    let next = selectedIdx;
    if (e.key === "ArrowDown") next = clamp(selectedIdx < 0 ? 0 : selectedIdx + 1);
    else if (e.key === "ArrowUp") next = clamp(selectedIdx < 0 ? items.length - 1 : selectedIdx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Enter" && selectedIdx >= 0 && items[selectedIdx]) {
      e.preventDefault();
      void playStation(items[selectedIdx]!);
      return;
    } else return;
    e.preventDefault();
    setSelectedIdx(next);
  };

  // Infinite scroll: fetch the next page when the sentinel scrolls in.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const emptyHint =
    source === "all"
      ? "目录为空或没有匹配的电台，试试更新目录或更换关键词"
      : source === "favorites"
        ? "还没有收藏，点击列表右侧的 ♥ 收藏电台"
        : source === "history"
          ? "还没有播放记录"
          : "还没有自定义电台，点击左侧“添加电台”";

  return (
    <div
      ref={listRef}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label="电台列表"
      className="flex-1 overflow-y-auto px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/30"
    >
      {loading ? (
        <div className="flex flex-col gap-2 px-0">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-neutral-200/60 dark:bg-neutral-800/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <RadioIcon className="h-10 w-10 text-neutral-300 dark:text-neutral-600" />
          <p className="max-w-64 text-xs leading-relaxed text-neutral-400">{emptyHint}</p>
          {source === "all" && (
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              刷新
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((st, i) => (
            <StationRow key={st.stationuuid} station={st} selected={i === selectedIdx} />
          ))}
          <div ref={sentinelRef} className="h-4" />
          <p className="py-2 text-center text-[11px] text-neutral-400">
            {loadingMore
              ? "加载中…"
              : items.length >= total
                ? `共 ${total.toLocaleString()} 个电台`
                : `已显示 ${items.length.toLocaleString()} / ${total.toLocaleString()}`}
          </p>
        </div>
      )}
    </div>
  );
}
