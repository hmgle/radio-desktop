import { useState } from "react";
import { Service } from "../mygo";
import { useRadio } from "../store";
import { messages as m } from "../locales";
import { Modal } from "./Dialogs";
import { ErrorDetails } from "./ErrorDetails";

export function ClearHistoryRow() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cleared, setCleared] = useState(false);
  const close = () => { if (!busy) setOpen(false); };
  return <div className="px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-40 flex-1"><div className="text-sm font-medium">{m.clearHistory()}</div><p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{m.clearHistoryHint()}</p></div>
      <button type="button" onClick={() => { setError(""); setCleared(false); setOpen(true); }} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:text-red-400">{m.clear()}</button>
    </div>
    <p aria-live="polite" className="mt-1 text-xs text-neutral-500">{cleared ? m.historyCleared() : ""}</p>
    {open && <Modal title={m.clearHistory()} onClose={close}>
      <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{m.confirmClearHistory()}</p>
      {error && <div role="alert" className="mt-2 text-xs text-red-500"><p>{m.clearHistoryFailed()}</p><ErrorDetails error={error} /></div>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={close} className="rounded-lg px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">{m.cancel()}</button>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try {
            await Service.clearHistory();
            setOpen(false); setCleared(true);
            if (useRadio.getState().source === "history") void useRadio.getState().refresh();
          } catch (e) { setError(String(e)); }
          finally { setBusy(false); }
        }} className="rounded-lg bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? m.clearing() : m.clear()}</button>
      </div>
    </Modal>}
  </div>;
}
