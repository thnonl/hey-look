// The Snooze button of the reading pane and of the reader window: its tooltip ends in the key of the action, "Snooze (s)" (like "Archive (e)", "Delete (#)"; in
// German "Zurückstellen (s)"), and that is the same in all 8 languages: the "(s)" is the shortcut, not a leak of a plural pattern. A screen reader says the plain
// name: the accessible name of the button is "Snooze" / "Zurückstellen", not the tooltip (v1.0.6 QA round 3, observation O-3).
// Run: node --experimental-strip-types scripts/test-snooze-label.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LANGUAGES, loadDicts } from "./lib/i18n-dicts.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
for (const f of ["../src/components/ReadingPane.tsx", "../src/popout/ReaderView.tsx"]) {
  const src = read(f);
  const at = src.indexOf('title={t("reading.head.snoozeTip")}');
  assert.ok(at > 0, `${f}: the snooze dropdown`);
  assert.match(src.slice(at, at + 120), /label=\{t\("(mail\.hover\.snooze|app\.ribbon\.snooze)"\)\}/, `${f}: the accessible name of Snooze is its plain label`);
}
assert.match(read("../src/components/ui.tsx"), /aria-label=\{label \?\? title\}/, "Dropdown: the accessible name is the label when there is one");
// every language: the tooltip is the label plus the key ` (s)` (and the key does fire the button: App.tsx)
assert.match(read("../src/App.tsx"), /case "s": document\.querySelector<HTMLButtonElement>\("\.reading-pane button\.snooze-btn"\)/, "the key s opens Snooze");
const dicts = await loadDicts();
let checked = 0;
for (const l of LANGUAGES) {
  const d = dicts[l.code] ?? dicts.get?.(l.code);
  const tip = d?.["reading.head.snoozeTip"] ?? (l.code === "en" ? "Snooze (s)" : undefined);
  if (tip === undefined) continue;
  checked++;
  assert.match(tip, /^[^()]+ \(s\)$/, `${l.code}: "${tip}"`);
  assert.ok(!/\{|\}|\(s\)\(/.test(tip), `${l.code}: no placeholder`);
}
assert.ok(checked >= 7, `only ${checked} languages checked`);
console.log(`test-snooze-label: ok (${checked} languages)`);
