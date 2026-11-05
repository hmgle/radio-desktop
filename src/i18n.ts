import { useEffect, useSyncExternalStore } from "react";
import { isMyGo, onLocaleChange } from "mygo-runtime";
import { currentLocale } from "mygo-runtime/i18n";
import { messages as m } from "./locales";

export function useLocale() {
  const tag = useSyncExternalStore((notify) => isMyGo() ? onLocaleChange(notify) : () => {}, currentLocale, () => "en");
  useEffect(() => {
    document.documentElement.lang = tag;
    document.documentElement.dir = "ltr";
  }, [tag]);
  return tag;
}

// Errors keep stable identifiers until rendered, including failures that
// were already visible when the listener changed the app's language.
export function errorText(error: string): string {
  const match = /radio:(\w+)(?:: ([\s\S]*))?/.exec(error);
  if (!match) return error;
  const key = match[1] as keyof typeof m;
  if (key === "syncFailed") return m.syncFailed(match[2] ?? "");
  const message = m[key];
  if (typeof message !== "function") return error;
  const label = (message as () => string)();
  return match[2] ? `${label} (${match[2]})` : label;
}
