import { errorText } from "../i18n";
import { messages as m } from "../locales";

export function ErrorDetails({ error }: { error: string }) {
  return <details className="mt-1 max-w-full text-xs">
    <summary className="cursor-pointer">{m.errorDetails()}</summary>
    <p className="mt-1 whitespace-pre-wrap break-words">{errorText(error)}</p>
  </details>;
}
