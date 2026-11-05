import { useEffect, useState } from "react";
import { messages as m } from "../locales";
import { useRadio } from "../store";
import { ErrorDetails } from "./ErrorDetails";

function useSleepRemaining() {
  const deadline = useRadio((s) => s.sleepTimer.deadline);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return { deadline, minutes: Math.max(0, Math.ceil((deadline - now) / 60000)) };
}

export function SleepTimerControl() {
  const { deadline, minutes } = useSleepRemaining();
  const error = useRadio((s) => s.sleepError);
  const [busy, setBusy] = useState(false);
  return <div className="flex flex-col items-end gap-1">
    <select aria-label={m.sleepTimer()} value={deadline ? "active" : "0"} disabled={busy}
      className="rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
      onChange={async (e) => {
        setBusy(true);
        await useRadio.getState().setSleepTimer(Number(e.target.value));
        setBusy(false);
      }}>
      {deadline > 0 && <option value="active" disabled>{m.sleepRemaining(minutes, new Date(deadline))}</option>}
      <option value="0">{m.sleepOff()}</option>
      {[15, 30, 60, 120].map((v) => <option key={v} value={v}>{m.minutes(v)}</option>)}
    </select>
    {error && <div role="alert" className="max-w-full text-xs text-red-500"><p>{m.sleepFailed()}</p><ErrorDetails error={error} /></div>}
  </div>;
}

export function SleepTimerStatus() {
  const { deadline, minutes } = useSleepRemaining();
  if (!deadline) return null;
  return <button type="button" onClick={() => useRadio.getState().openSettings(true)}
    title={m.sleepRemaining(minutes, new Date(deadline))} aria-label={m.sleepRemaining(minutes, new Date(deadline))}
    className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800">
    ◷ {m.minutes(minutes)}
  </button>;
}
