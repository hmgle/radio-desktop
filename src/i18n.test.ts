import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { messagesIn } from "./locales";
import { errorText } from "./i18n";

it("ships matching message keys and placeholders in both languages", () => {
  const en = JSON.parse(readFileSync("locales/en.json", "utf8"));
  const zh = JSON.parse(readFileSync("locales/zh-CN.json", "utf8"));
  const keys = (data: Record<string, unknown>) => Object.keys(data).filter((k) => !k.startsWith("@")).sort();
  expect(keys(zh)).toEqual(keys(en));
  for (const key of keys(en)) {
    const params = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?:[,}])/g)].map((m) => m[1]))].sort();
    expect(params(zh[key]), key).toEqual(params(en[key]));
  }
  expect(messagesIn("en").results(1)).toBe("1 result");
  expect(messagesIn("en").results(2)).toBe("2 results");
  expect(messagesIn("zh-CN").results(2)).toBe("2 个结果");
  expect(messagesIn("fr").all()).toBe("All stations");
});

it("translates an existing error after the runtime changes language", () => {
  const runtime = { locale: "en" };
  vi.stubGlobal("mygo", runtime);
  expect(errorText("radio:errorBlocked")).toContain("Playback was blocked");
  runtime.locale = "zh-CN";
  expect(errorText("radio:errorBlocked")).toContain("播放被系统阻止");
  expect(errorText("Error: radio:syncShrink: diagnostic")).toContain("diagnostic");
  vi.unstubAllGlobals();
});
