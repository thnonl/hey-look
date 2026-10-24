// Confidential mail and the AI Assistant (W8.3): Summarize is greyed with the reason when every message of the conversation is confidential, a mixed conversation is summarised
// without them and the card says so, Translate rows carry their reason, and the pane and the reader window decide the same way (one helper).
// Run: node --experimental-strip-types scripts/test-ai-confidential.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiAvailability } from "../src/aiAvailability.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- 1. the helper
const c = { confidential: true };
const n = { confidential: false };
assert.equal(aiAvailability([]), "on", "an empty list");
assert.equal(aiAvailability([n]), "on");
assert.equal(aiAvailability([{}]), "on", "no flag is not confidential");
assert.equal(aiAvailability([{ confidential: null }]), "on");
assert.equal(aiAvailability([c]), "off-confidential", "AC-8.3.1: one confidential message");
assert.equal(aiAvailability([c, c, c]), "off-confidential", "all confidential");
assert.equal(aiAvailability([n, c]), "on-partial", "AC-8.3.2: mixed");
assert.equal(aiAvailability([c, n, c]), "on-partial");
assert.equal(aiAvailability([n, n]), "on");

// ---- 2. both views use it, in the same order: the all-confidential check comes before the "not set up" branch
for (const [file, label] of [["../src/components/ReadingPane.tsx", "the reading pane"], ["../src/popout/ReaderView.tsx", "the reader window"]]) {
  const s = read(file);
  assert.match(s, /import \{ aiAvailability \} from "(\.\.\/aiAvailability)";/, `${label} imports the helper`);
  const fn = s.slice(s.indexOf("const summarize = async () => {"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  assert.ok(body.indexOf('aiAvailability(messages) === "off-confidential"') > -1, `${label}: summarize checks the helper`);
  assert.ok(body.indexOf('aiAvailability(messages) === "off-confidential"') < body.indexOf("aiReady()"), `${label}: the confidential check comes before aiReady (REQ-8.3.3: never "Set up AI" for it)`);
  assert.match(body, /t\("reading\.ai\.noConfidential"\)/, `${label}: a stale click gets the reason as an info toast (REQ-8.3.4)`);
  assert.match(body, /t\("reading\.ai\.unlockEncrypted"\)/, `${label}: only locked messages left: unlock first`);
  assert.doesNotMatch(body, /messages\.some\(\(m\) => m\.confidential\) \? t\("reading\.ai\.noConfidential"\)/, `${label}: the old mixed toast is gone`);
  assert.match(s, /disabled=\{[^}]*avail === "off-confidential"\}/, `${label}: the button is disabled`);
  assert.match(s, /title=\{avail === "off-confidential" \? t\("reading\.ai\.noConfidential"\)/, `${label}: the title is the reason`);
  assert.match(s, /aiConfigured \|\| avail === "off-confidential" \? t\("reading\.head\.summarize"\)/, `${label}: the label stays Summarize, not Set up AI`);
  assert.match(s, /setSummaryNoConf\(messages\.some\(\(m\) => m\.confidential\)\)/, `${label}: a summary of a mixed conversation says so`);
  assert.match(s, /setSummaryNoConf\(false\)/, `${label}: the note resets with the summary`);
  assert.match(s, /\{summaryNoConf && <div className="muted small tr-hint">\{t\("reading\.head\.summaryNoConf"\)\}<\/div>\}/, `${label}: the note is under the summary`);
  assert.ok(s.indexOf("summaryCut && <div") < s.indexOf("summaryNoConf && <div"), `${label}: after the cut line`);
  assert.match(s, /title: [^\n]*t\("reading\.ai\.unlockThis"\)[^\n]*t\("reading\.ai\.noConfidential"\)/, `${label}: the Translate rows carry their reason`);
}

// ---- 3. the text exists in all eight languages and says "confidential" the way the Confidential banner does
const langs = ["vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
const en = read("../src/i18n/ns/reading.ts");
assert.match(en, /"reading\.head\.summaryNoConf": "Confidential messages in this conversation were left out\."/);
for (const l of langs) assert.match(read(`../src/i18n/locales/${l}/reading.ts`), /"reading\.head\.summaryNoConf": "[^"]{8,}"/, `${l} has the note`);
console.log("ok - test-ai-confidential");
