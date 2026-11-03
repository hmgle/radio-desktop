// Run with: bun tools/update-flags.ts (requires gh and tar).
// Assets are checked in; normal builds do not require network access.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Twemoji v14.0.2, pinned to its commit rather than a mutable tag.
const revision = "7a3dad4a4da30497093dab22eafba135f02308e1";
const root = fileURLToPath(new URL("../", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "radio-flags-"));

try {
  const archive = execFileSync("gh", ["api", `repos/twitter/twemoji/tarball/${revision}`], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const prefix = execFileSync("tar", ["-tz"], { input: archive,
    maxBuffer: 16 * 1024 * 1024 }).toString().split("/")[0]!;
  execFileSync("tar", ["-xz", "-C", work, "--strip-components=1",
    `${prefix}/assets/svg`, `${prefix}/LICENSE-GRAPHICS`], { input: archive });

  const output = join(root, "src/assets/flags");
  mkdirSync(output, { recursive: true });
  const flags = new Map<string, string>();
  for (const name of readdirSync(join(work, "assets/svg")).sort()) {
    const match = /^(1f1[a-f][0-9a-f])-(1f1[a-f][0-9a-f])\.svg$/.exec(name);
    if (!match) continue;
    const points = match.slice(1).map((point) => parseInt(point!, 16));
    if (points.some((point) => point < 0x1f1e6 || point > 0x1f1ff)) continue;
    const code = String.fromCharCode(...points.map((point) => point - 0x1f1e6 + 65));
    const original = readFileSync(join(work, "assets/svg", name), "utf8");
    if (!original.includes('viewBox="0 0 36 36"')) throw new Error(`Unexpected viewBox: ${name}`);
    flags.set(code, original.replace('viewBox="0 0 36 36"', 'viewBox="0 5 36 26"'));
  }
  if (flags.size < 249) throw new Error(`Incomplete flag set: ${flags.size}`);
  for (const [code, svg] of flags) writeFileSync(join(output, `${code}.svg`), svg);
  for (const name of readdirSync(output)) {
    if (/^[A-Z]{2}\.svg$/.test(name) && !flags.has(name.slice(0, 2))) rmSync(join(output, name));
  }

  const notice = `Twemoji flag artwork\nCopyright 2019 Twitter, Inc and other contributors\nSource: https://github.com/twitter/twemoji/tree/${revision}\nLicense: CC BY 4.0, https://creativecommons.org/licenses/by/4.0/\nChanges: cropped the SVG viewBox to remove vertical padding.\n\n`;
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "public/third-party-notices.txt"),
    notice + readFileSync(join(work, "LICENSE-GRAPHICS"), "utf8").replace(/[ \t]+$/gm, ""));
  console.log(`Updated ${flags.size} flags and their license notice.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
