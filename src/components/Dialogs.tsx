import { errorText } from "../i18n";
import { messages as m } from "../locales";
import { useEffect, useId, useRef, useState } from "react";
import { Service } from "../mygo";
import { useRadio } from "../store";

/** Modal shell with a keyboard focus trap and focus restoration. */
export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const previous = previousFocus.current;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('a[href]:not([tabindex="-1"]), summary:not([tabindex="-1"]), button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
    if (!panel.current?.contains(document.activeElement)) (focusable()[0] ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); }
      if (e.key === "Tab") {
        const fields = focusable();
        const index = fields.indexOf(document.activeElement as HTMLElement);
        if (!fields.length) { e.preventDefault(); panel.current?.focus(); }
        else if (e.shiftKey && index <= 0) { e.preventDefault(); fields.at(-1)?.focus(); }
        else if (!e.shiftKey && (index < 0 || index === fields.length-1)) { e.preventDefault(); fields[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={props.className ?? "w-88 max-w-[calc(100vw-2rem)] rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"}>
        <h2 id={titleId} className="mb-3 text-sm font-semibold">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

const inputClass =
  "h-9 w-full rounded-lg border border-neutral-300 bg-white px-2.5 text-sm outline-none transition-colors focus:border-[var(--accent)] dark:border-neutral-700 dark:bg-neutral-800";

export function AddStationDialog(props: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [url, setURL] = useState("");
  const [homepage, setHomepage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await Service.addCustomStation(name.trim(), url.trim(), homepage.trim());
      const st = useRadio.getState();
      if (st.source !== "custom") st.setSource("custom");
      else void st.refresh();
      props.onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={m.addCustom()} onClose={props.onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={m.stationName()}
          className={inputClass}
        />
        <input
          required
          value={url}
          onChange={(e) => setURL(e.target.value)}
          placeholder={m.streamURL()}
          className={inputClass}
        />
        <input
          value={homepage}
          onChange={(e) => setHomepage(e.target.value)}
          placeholder={m.homepage()}
          className={inputClass}
        />
        {error && <p className="text-xs text-red-500">{errorText(error)}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {m.cancel()}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? m.adding() : m.addSave()}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PlayURLDialog(props: { onClose: () => void }) {
  const [url, setURL] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await useRadio.getState().playURL(url.trim());
      props.onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Modal title={m.playURL()} onClose={props.onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <input
          autoFocus
          required
          value={url}
          onChange={(e) => setURL(e.target.value)}
          placeholder="https://example.com/live.mp3"
          className={inputClass}
        />
        <p className="text-[11px] text-neutral-400">{m.previewHint()}</p>
        {error && <p className="text-xs text-red-500">{errorText(error)}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {m.cancel()}
          </button>
          <button type="submit" className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-white">
            {m.play()}
          </button>
        </div>
      </form>
    </Modal>
  );
}
