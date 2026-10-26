import { useEffect, useState } from "react";
import { Service } from "../mygo";
import { useRadio } from "../store";

/** Minimal modal shell: closes on backdrop click or Escape. */
function Modal(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="w-88 rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="mb-3 text-sm font-semibold">{props.title}</h2>
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
    <Modal title="添加自定义电台" onClose={props.onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="电台名称"
          className={inputClass}
        />
        <input
          required
          value={url}
          onChange={(e) => setURL(e.target.value)}
          placeholder="流地址 https://… (mp3/aac/HLS)"
          className={inputClass}
        />
        <input
          value={homepage}
          onChange={(e) => setHomepage(e.target.value)}
          placeholder="主页（可选）"
          className={inputClass}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "添加中…" : "添加并保存"}
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
    <Modal title="播放流地址" onClose={props.onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
        <input
          autoFocus
          required
          value={url}
          onChange={(e) => setURL(e.target.value)}
          placeholder="https://example.com/live.mp3"
          className={inputClass}
        />
        <p className="text-[11px] text-neutral-400">直接试听，不加入电台库。</p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            取消
          </button>
          <button type="submit" className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-white">
            播放
          </button>
        </div>
      </form>
    </Modal>
  );
}
