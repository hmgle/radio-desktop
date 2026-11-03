import { useRadio, type Source } from "../store";

const SOURCES: { key: Source; label: string; icon: string }[] = [
  { key: "all", label: "全部电台", icon: "🌐" },
  { key: "favorites", label: "收藏", icon: "❤️" },
  { key: "history", label: "最近播放", icon: "🕘" },
  { key: "custom", label: "我的电台", icon: "✏️" },
];

export function Sidebar(props: {
  onAddStation: () => void;
  onPlayURL: () => void;
}) {
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
      <nav className="flex flex-col gap-0.5 p-2">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSource(s.key)}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              source === s.key
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
          添加电台
        </button>
        <button
          type="button"
          onClick={props.onPlayURL}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span className="w-5 text-center">▶</span>
          播放链接
        </button>
      </div>

      <div className="mt-auto border-t border-neutral-200 p-3 text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {syncProgress ? (
          <p className="text-[var(--accent)]">
            正在同步目录… 已获取 {syncProgress.accepted.toLocaleString()} 台
          </p>
        ) : syncing ? (
          <p className="text-[var(--accent)]">正在同步目录…</p>
        ) : lastSyncResult?.error ? (
          <p className="text-red-500" title={lastSyncResult.error}>
            同步失败：{lastSyncResult.error.slice(0, 60)}
          </p>
        ) : (
          <p>
            目录：{catalogSize.toLocaleString()} 个电台
            {lastSync && (
              <span className="block text-neutral-400 dark:text-neutral-500">
                更新于 {lastSync.toLocaleDateString()} {lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
          {syncing ? "同步中…" : "更新电台目录"}
        </button>
      </div>
    </aside>
  );
}
