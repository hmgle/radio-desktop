import { messages as m } from "../locales";
import { useEffect, useRef, useState } from "react";
import { Service } from "../mygo";
import type { Facet } from "../mygo";
import { countryFlagUrl } from "../flags";

/** Country flag from bundled SVG artwork, sized to the surrounding text.
 *
 * Flag emoji are regional indicator pairs, which need a color emoji
 * font; hosts without one show boxed letters instead. SVG artwork is
 * font independent, so codes without artwork fall back to the ISO
 * letters rather than a broken glyph.
 */
export function CountryFlag({ code, className = "" }: { code?: string; className?: string }) {
  const cc = (code ?? "").trim().toUpperCase();
  const [failedSrc, setFailedSrc] = useState("");
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  // "XX" is the directory's placeholder for a station with no country.
  if (cc === "XX") return null;
  const src = countryFlagUrl(cc);
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        width="36"
        height="26"
        aria-hidden="true"
        onError={() => setFailedSrc(src)}
        className={`inline-block h-3 w-auto shrink-0 align-middle ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3 w-4 shrink-0 items-center justify-center rounded-[2px] border border-neutral-300 text-[8px] font-medium leading-none text-neutral-400 dark:border-neutral-600 dark:text-neutral-500 ${className}`}
    >
      {cc}
    </span>
  );
}

export function EqBars({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex h-3 items-end gap-[2px] ${className}`}>
      <span className="eq-bar block h-3 w-[3px] rounded-sm bg-[var(--accent)]" />
      <span className="eq-bar block h-3 w-[3px] rounded-sm bg-[var(--accent)]" />
      <span className="eq-bar block h-3 w-[3px] rounded-sm bg-[var(--accent)]" />
    </span>
  );
}

/** Radio note icon shown when a station has no favicon. */
export function RadioIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2" strokeLinecap="round" />
    </svg>
  );
}

export function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
      <path d="M12 21s-7.5-4.7-9.7-9.1C.8 8.9 2.7 5.5 6 5.5c2 0 3.4 1.1 4.2 2.4h3.6c.8-1.3 2.2-2.4 4.2-2.4 3.3 0 5.2 3.4 3.7 6.4C19.5 16.3 12 21 12 21z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A dropdown that lazy-loads facet values (country/language/tag) from the
 * backend, with a prefix search box. Uses a <button> + absolutely
 * positioned panel; closes on outside click or Escape.
 */
export function FacetSelect(props: {
  label: string;
  kind: "country" | "language" | "tag";
  value: string;
  display?: string;
  onChange: (value: string, label: string) => void;
}) {
  const { label, kind, value, display, onChange } = props;
  const [open, setOpen] = useState(false);
  const [facets, setFacets] = useState<Facet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [prefix, setPrefix] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setFacets(null);
    setFailed(false);
    const load = async () => {
      try {
        const list =
          kind === "country"
            ? await Service.countries(prefix)
            : kind === "language"
              ? await Service.languages(prefix)
              : await Service.tags(prefix);
        if (active) setFacets(list);
      } catch (e) {
        console.error("facets failed", e);
        if (active) setFailed(true);
      }
    };
    const timer = setTimeout(() => void load(), prefix ? 200 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [open, kind, prefix]);

  useEffect(() => {
    if (!open) return setPrefix(""), undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = facets ?? [];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs transition-colors ${
          value
            ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]"
            : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        }`}
      >
        {value ? display || value : label}
        <svg viewBox="0 0 16 16" className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-9 left-0 z-30 flex max-h-80 w-64 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
            <input
              autoFocus
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={m.searchFacet(label)}
              className="h-7 w-full rounded-md bg-neutral-100 px-2 text-xs outline-none dark:bg-neutral-800"
            />
          </div>
          <div className="min-h-20 flex-1 overflow-y-auto overscroll-contain py-1">
            {failed ? (
              <p className="p-3 text-center text-xs text-red-500">{m.loadFailed()}</p>
            ) : facets === null ? (
              <p className="p-3 text-center text-xs text-neutral-400">{m.loading()}</p>
            ) : shown.length === 0 ? (
              <p className="p-3 text-center text-xs text-neutral-400">{m.noMatches()}</p>
            ) : (
              shown.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => {
                    onChange(f.value, f.label);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                    f.value === value ? "font-medium text-[var(--accent)]" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {kind === "country" && <CountryFlag code={f.value} />}
                    <span className="truncate">{f.label}</span>
                  </span>
                  <span className="ml-2 shrink-0 text-[10px] text-neutral-400">{f.count}</span>
                </button>
              ))
            )}
          </div>
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("", "");
                setOpen(false);
              }}
              className="border-t border-neutral-100 py-1.5 text-center text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800"
            >
              {m.clearFilter()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
