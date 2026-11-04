import { messages as m } from "../locales";
import { useEffect, useId, useRef, useState } from "react";
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

export { EqBars } from "./EqBars";

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
  const [pending, setPending] = useState(false);
  const [prefix, setPrefix] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    setPending(true);
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
      } finally {
        if (active) setPending(false);
      }
    };
    const timer = setTimeout(() => void load(), prefix ? 200 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [open, kind, prefix]);

  useEffect(() => {
    if (!open) {
      // Drop the previous visit's rows so a reopened popup never shows a stale
      // prefix result, and never leaves a request marked as in flight.
      setPrefix("");
      setFacets(null);
      setFailed(false);
      setPending(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
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
    <div ref={rootRef} className="relative" onBlur={(e) => {
      // A null relatedTarget is not a focus move away: macOS WebKit does not
      // give <button> focus on click, so pressing an option drops focus to the
      // document (webkit.org/b/229895). Closing here would unmount the option
      // before its click is dispatched, so let the pointer path below decide.
      const next = e.relatedTarget as Node | null;
      if (!next) return;
      if (!e.currentTarget.contains(next)) setOpen(false);
    }} onKeyDown={(e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
        return;
      }
      if ((e.key === "Home" || e.key === "End") && e.target instanceof HTMLInputElement) return;
      const options = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!options.length) return;
      e.preventDefault();
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1;
      options[next]?.focus();
    }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={value ? `${label}: ${display || value}` : label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 max-w-48 items-center gap-1 rounded-lg border px-2.5 text-xs transition-colors ${
          value
            ? "border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--accent)]"
            : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        }`}
      >
        <span className="truncate">{value ? display || value : label}</span>
        <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 opacity-60" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div ref={panelRef} id={panelId} role="dialog" aria-label={label} className="absolute top-9 left-0 z-30 flex max-h-[min(20rem,calc(100vh-15rem))] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
          <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
            <input
              autoFocus
              aria-label={m.searchFacet(label)}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={m.searchFacet(label)}
              className="h-7 w-full rounded-md bg-neutral-100 px-2 text-xs outline-none dark:bg-neutral-800"
            />
          </div>
          <div className="min-h-20 flex-1 overflow-y-auto overscroll-contain py-1" aria-busy={pending}>
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
                  // Keep the search box focused while pressing an option, so the
                  // prefix and the keyboard position survive the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(f.value, f.label);
                    close();
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
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange("", "");
                close();
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
