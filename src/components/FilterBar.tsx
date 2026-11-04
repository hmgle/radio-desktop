import { messages as m } from "../locales";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRadio, type SortKey } from "../store";
import { FacetSelect } from "./ui";


const BITRATES = [0, 64, 96, 128, 192, 320];

export function FilterBar() {
  const SORTS: { key: SortKey; label: string }[] = [
    { key: "popularity", label: m.sortPopularity() },
    { key: "votes", label: m.sortVotes() },
    { key: "name", label: m.sortName() },
    { key: "bitrate", label: m.sortBitrate() },
    { key: "random", label: m.sortRandom() },
  ];
  const { query, setQuery, country, language, tag, minBitrate, sort, setFilter, total, source } =
    useRadio(useShallow((s) => ({ query: s.query, setQuery: s.setQuery, country: s.country, language: s.language, tag: s.tag, minBitrate: s.minBitrate, sort: s.sort, setFilter: s.setFilter, total: s.total, source: s.source })));

  const [countryLabel, setCountryLabel] = useState("");
  const [languageLabel, setLanguageLabel] = useState("");
  const [tagLabel, setTagLabel] = useState("");

  const hasFilter = country || language || tag || minBitrate > 0;
  const searchLabel = source === "all" ? m.searchAll() : source === "favorites" ? m.searchFavorites() : source === "history" ? m.searchHistory() : m.searchCustom();

  return (
    <div className="flex flex-col gap-2 border-b border-neutral-200 bg-white/70 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="absolute top-2.5 left-2.5 h-4 w-4 text-neutral-400">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            id="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={searchLabel}
            placeholder={searchLabel}
            className="h-9 w-full rounded-xl border border-neutral-300 bg-white pr-9 pl-8 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700 dark:bg-neutral-900"
          />
          {query && <button type="button" aria-label={m.clearSearch()} title={m.clearSearch()} onClick={() => {
            setQuery("");
            document.getElementById("search-input")?.focus();
          }} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5"><path d="m4 4 8 8m0-8-8 8" strokeLinecap="round" /></svg>
          </button>}
        </div>
        <span className="shrink-0 text-xs text-neutral-400">{m.results(total)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FacetSelect
          label={m.country()}
          kind="country"
          value={country}
          display={countryLabel}
          onChange={(v, label) => {
            setCountryLabel(label);
            setFilter({ country: v });
          }}
        />
        <FacetSelect
          label={m.language()}
          kind="language"
          value={language}
          display={languageLabel}
          onChange={(v, label) => {
            setLanguageLabel(label);
            setFilter({ language: v });
          }}
        />
        <FacetSelect
          label={m.tag()}
          kind="tag"
          value={tag}
          display={tagLabel}
          onChange={(v, label) => {
            setTagLabel(label);
            setFilter({ tag: v });
          }}
        />
        <div className="relative">
          <select
            aria-label={m.bitrate()}
            value={minBitrate}
            onChange={(e) => setFilter({ minBitrate: Number(e.target.value) })}
            className={`h-8 appearance-none rounded-lg border px-2.5 pr-6 text-xs transition-colors ${
              minBitrate > 0
                ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]"
                : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            {BITRATES.map((b) => (
              <option key={b} value={b}>
                {b === 0 ? m.unlimitedBitrate() : `≥ ${b}kbps`}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 16 16" className="pointer-events-none absolute top-2.5 right-1.5 h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="relative">
          <select
            aria-label={m.sortOrder()}
            value={sort}
            onChange={(e) => setFilter({ sort: e.target.value as SortKey })}
            className="h-8 appearance-none rounded-lg border border-neutral-300 bg-white px-2.5 pr-6 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {m.sortBy(s.label)}
              </option>
            ))}
          </select>
          <svg viewBox="0 0 16 16" className="pointer-events-none absolute top-2.5 right-1.5 h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" />
          </svg>
        </div>
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setCountryLabel("");
              setLanguageLabel("");
              setTagLabel("");
              setFilter({ country: "", language: "", tag: "", minBitrate: 0 });
            }}
            className="h-8 rounded-lg px-2 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {m.reset()}
          </button>
        )}
      </div>
    </div>
  );
}
