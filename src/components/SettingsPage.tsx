import { SleepTimerControl } from "./SleepTimerControl";
import { ClearHistoryRow } from "./ClearHistoryRow";
import { ErrorDetails } from "./ErrorDetails";
import type { ReactNode } from "react";
import { messages as m } from "../locales";
import { useSettings } from "../settings";
import { useRadio } from "../store";

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mb-6"><h2 className="mb-2 px-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400">{title}</h2>
    <div className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">{children}</div>
  </section>;
}

export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
    <div className="min-w-40 flex-1"><div className="text-sm font-medium">{label}</div>{hint && <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{hint}</p>}</div>
    {children}
  </div>;
}

export const settingsControl = "max-w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800";

export function SettingsPage() {
  const catalogSize = useRadio((s) => s.status?.catalogSize ?? 0);
  const { value, ready, saving, error, load, update } = useSettings();
  return <div className="flex-1 overflow-y-auto p-6" aria-label={m.settings()}>
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{m.settings()}</h1>
        <button type="button" className={settingsControl} onClick={() => useRadio.getState().openSettings(false)}>← {m.back()}</button>
      </div>
      <div aria-live="polite" className="mb-3 text-xs text-neutral-500">{saving ? m.saving() : ""}</div>
      {error && <div role="alert" className="mb-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-600"><p>{m.saveFailed()}</p>
        <ErrorDetails error={error} />
        {!ready && <button type="button" onClick={() => void load()} className={settingsControl}>{m.refresh()}</button>}
      </div>}
      <fieldset disabled={!ready} className="min-w-0">
        <SettingsGroup title={m.general()}>
          <SettingsRow label={m.uiLanguage()} hint={m.languageHint()}>
            <select aria-label={m.uiLanguage()} className={settingsControl} value={value.language} onChange={(e) => void update({ language: e.target.value })}>
              <option value="system">{m.system()}</option><option value="en">English</option><option value="zh-CN">简体中文</option>
            </select>
          </SettingsRow>
          <SettingsRow label={m.closeBehavior()} hint={m.closeHint()}>
            <select aria-label={m.closeBehavior()} className={settingsControl} value={value.closeBehavior} onChange={(e) => void update({ closeBehavior: e.target.value })}>
              <option value="hide">{m.closeHide()}</option><option value="quit">{m.closeQuit()}</option>
            </select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={m.appearanceGroup()}>
          <SettingsRow label={m.appearance()} hint={m.appearanceHint()}>
            <select aria-label={m.appearance()} className={settingsControl} value={value.appearance} onChange={(e) => void update({ appearance: e.target.value })}>
              <option value="system">{m.system()}</option><option value="light">{m.light()}</option><option value="dark">{m.dark()}</option>
            </select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={m.playbackGroup()}>
          <SettingsRow label={m.sleepTimer()} hint={m.sleepHint()}><SleepTimerControl /></SettingsRow>
          <SettingsRow label={m.resume()} hint={m.resumeHint()}>
            <select aria-label={m.resume()} className={settingsControl} value={value.resume} onChange={(e) => void update({ resume: e.target.value })}>
              <option value="off">{m.resumeOff()}</option><option value="selection">{m.resumeSelection()}</option><option value="play">{m.resumePlay()}</option>
            </select>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={m.dataGroup()}>
          <ClearHistoryRow />
          <SettingsRow label={m.autoSyncDays()} hint={m.autoSyncHint()}>
            <form onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("days") as HTMLInputElement;
              if (input.reportValidity()) void update({ autoSyncDays: Number(input.value) });
            }}>
              <input key={value.autoSyncDays} name="days" type="number" required min={0} max={365} step={1} aria-label={m.autoSyncDays()} defaultValue={value.autoSyncDays} className={`${settingsControl} w-20`} />
              <button type="submit" className={`${settingsControl} ml-2`}>{m.apply()}</button>
            </form>
          </SettingsRow>
          <SettingsRow label={m.catalogCount(catalogSize)}>
            <SyncButton />
          </SettingsRow>
        </SettingsGroup>
      </fieldset>
      <SettingsGroup title={m.shortcuts()}>
        {[
          ["Space", m.shortcutPlay()], ["Cmd/Ctrl+F", m.shortcutSearch()],
          ["Cmd/Ctrl+N", m.shortcutAdd()], ["Cmd/Ctrl+L", m.shortcutURL()],
          ["Cmd/Ctrl+,", m.shortcutSettings()], ["↑ / ↓ / Home / End / Enter", m.shortcutList()],
          ["Esc", m.shortcutEsc()],
        ].map(([key, label]) => <SettingsRow key={key} label={label!}><kbd className="text-xs text-neutral-500">{key}</kbd></SettingsRow>)}
      </SettingsGroup>
    </div>
  </div>;
}

function SyncButton() {
  const syncing = useRadio((s) => !!s.syncProgress || !!s.status?.syncing);
  return <button type="button" className={settingsControl} disabled={syncing} onClick={() => useRadio.getState().syncNow()}>{syncing ? m.syncBusy() : m.syncNow()}</button>;
}
