import { errorText } from "../i18n";
import { messages as m } from "../locales";
import { useRadio, type Source } from "../store";


export function Sidebar(props: {
  onAddStation: () => void;
  onPlayURL: () => void;
}) {
  const SOURCES: { key: Source; label: string; icon: string }[] = [
    { key: "all", label: m.all(), icon: "🌐" },
    { key: "favorites", label: m.favorite(), icon: "❤️" },
    { key: "history", label: m.history(), icon: "🕘" },
    { key: "custom", label: m.customStations(), icon: "✏️" },
  ];
  const settingsOpen = useRadio((s) => s.settingsOpen);
  const source = useRadio((s) => s.source);
  const setSource = useRadio((s) => s.setSource);
  const status = useRadio((s) => s.status);
  const syncProgress = useRadio((s) => s.syncProgress);
  const lastSyncResult = useRadio((s) => s.lastSyncResult);
  const syncNow = useRadio((s) => s.syncNow);

  const catalogSize = status?.catalogSize ?? 0;
  const lastSync = status?.lastSyncAt ? new Date(status.lastSyncAt * 1000) : null;
  const syncing = !!syncProgress || !!status?.syncing;

  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-neutral-200 bg-white/60 dark:border-neutral-800 dark:bg-neutral-900/40">
      <nav className="flex flex-col gap-0.5 p-2 pt-3">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSource(s.key)}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              !settingsOpen && source === s.key
                ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]"
                : "text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            <span className="w-5 text-center text-sm">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="mt-1 flex flex-col gap-1 border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={props.onAddStation}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span className="w-5 text-center">＋</span>
          {m.addStation()}
        </button>
        <button
          type="button"
          onClick={props.onPlayURL}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span className="w-5 text-center">▶</span>
          {m.playLink()}
        </button>
      </div>

      <button type="button" onClick={() => useRadio.getState().openSettings(true)} aria-current={settingsOpen ? "page" : undefined} className={`mx-2 mb-3 rounded-lg px-2.5 py-2 text-left text-sm ${settingsOpen ? "bg-[var(--accent)]/10 font-medium text-[var(--accent)]" : "text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}>⚙ {m.settings()}</button>
      <div className="mt-auto border-t border-neutral-200 p-3 text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {syncProgress ? (
          <p className="text-[var(--accent)]">
            {m.syncProgress(syncProgress.accepted)}
          </p>
        ) : syncing ? (
          <p className="text-[var(--accent)]">{m.syncing()}</p>
        ) : lastSyncResult?.error ? (
          <p className="text-red-500" title={lastSyncResult.error}>
            {m.syncFailed(errorText(lastSyncResult.error))}
          </p>
        ) : (
          <p>
            {m.catalogCount(catalogSize)}
            {lastSync && (
              <span className="block text-neutral-400 dark:text-neutral-500">
                {m.updated(lastSync)}
              </span>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="mt-1.5 w-full rounded-md border border-neutral-300 py-1 hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {syncing ? m.syncBusy() : m.syncNow()}
        </button>
      </div>
    </aside>
  );
}
