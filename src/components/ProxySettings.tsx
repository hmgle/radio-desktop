import { useState } from "react";
import type { Settings } from "../mygo";
import { messages as m } from "../locales";
import { useSettings } from "../settings";
import { SettingsGroup, SettingsRow, settingsControl } from "./SettingsPage";

export function ProxySettings() {
  const value = useSettings((s) => s.value);
  return <SettingsGroup title={m.networkGroup()}>
    <ProxyForm key={`${value.proxyMode}:${value.proxyURL}`} value={value} />
  </SettingsGroup>;
}

function ProxyForm({ value }: { value: Settings }) {
  const [mode, setMode] = useState(value.proxyMode);
  const [address, setAddress] = useState(value.proxyURL);
  const { update, saving } = useSettings();
  return <form aria-label={m.networkProxy()} onSubmit={(e) => {
    e.preventDefault();
    void update({ proxyMode: mode, proxyURL: mode === "manual" ? address.trim() : "" });
  }}>
    <SettingsRow label={m.networkProxy()} hint={m.proxyScope()}>
      <select aria-label={m.proxyMode()} className={settingsControl} value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="auto">{m.proxyAuto()}</option>
        <option value="manual">{m.proxyManual()}</option>
        <option value="direct">{m.proxyDirect()}</option>
      </select>
    </SettingsRow>
    {mode === "manual" && <SettingsRow label={m.proxyAddress()} hint={m.proxyAddressHint()}>
      <input aria-label={m.proxyAddress()} type="url" required value={address} onChange={(e) => setAddress(e.target.value)}
        autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:8080" className={`${settingsControl} w-64`} />
    </SettingsRow>}
    <SettingsRow label={m.proxyRestart()} hint={mode === "direct" ? m.proxyDirectHint() : undefined}>
      <button type="submit" disabled={saving} className={settingsControl}>{m.apply()}</button>
    </SettingsRow>
  </form>;
}
