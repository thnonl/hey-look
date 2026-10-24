// The AI Assistant problem toast (1.0.6, src/aiProblem.ts + src/aiGuide.ts): which error is which problem, what the toast says in the eight
// languages, which buttons it has, and that every place that uses an AI feature tells its problems through that one toast.
// (scripts/test-ai-guide.mjs drives the real UI in a browser; this one is the logic and the wiring, no browser.)
// Run: node --experimental-strip-types scripts/test-ai-problem.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { aiProblemButtons, aiProblemText, classifyAiError, NOT_SET_UP } from "../src/aiProblem.ts";
import { LANGS, loadAllLanguages, setLangPref, t } from "../src/i18n/index.ts";
import { isTransientAiError, timeoutError } from "../src/aiCall.ts";
import { totalTimeoutError } from "../src/translateJobs.ts";

await loadAllLanguages(); // (the languages are chunks of their own: setLangPref needs them loaded)

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

// ---- 1. error -> problem ------------------------------------------------------------------------------------------------------------
const http = (status, detail) => (detail ? `AI_HTTP|status=${status}|detail=${detail}: The AI Assistant returned an error (${status}): ${detail}` : `AI_HTTP|v=plain|status=${status}: The AI Assistant returned an error (${status}).`);
const TABLE = [
  // [what the call said, kind, status, retry, field the settings put the cursor in]
  [NOT_SET_UP, "notConfigured", undefined, false, "missing"],
  ["AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI", "notConfigured", undefined, false, "missing"],
  [new Error(NOT_SET_UP), "notConfigured", undefined, false, "missing"],
  [http(401, "Incorrect API key provided"), "auth", 401, false, "aiKey"],
  [http(401), "auth", 401, false, "aiKey"],
  [http(403, "Forbidden"), "auth", 403, false, "aiKey"],
  [http(404, "The model `gpt-9` does not exist"), "model", 404, false, "aiModel"],
  [http(404, "model_not_found"), "model", 404, false, "aiModel"],
  [http(404), "badAddress", 404, false, "aiBaseUrl"],
  [http(404, "Not Found"), "badAddress", 404, false, "aiBaseUrl"],
  [http(400, "Unknown model: gpt-9"), "model", 400, false, "aiModel"],
  [http(422, "model is not supported"), "model", 422, false, "aiModel"],
  [http(400, "max_tokens is too large"), "other", 400, false, undefined],
  [http(402, "Payment required"), "other", 402, false, undefined],
  [http(429, "Rate limit reached"), "busy", 429, true, undefined],
  [http(500), "busy", 500, true, undefined],
  [http(502, "Bad gateway"), "busy", 502, true, undefined],
  [http(503, "upstream overloaded"), "busy", 503, true, undefined],
  ["AI_BAD_RESPONSE: The AI Assistant sent an answer the app can’t read.", "unreadable", undefined, true, undefined],
  ["AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.", "timeout", undefined, true, undefined],
  [timeoutError(), "timeout", undefined, true, undefined],
  [totalTimeoutError(), "timeout", undefined, true, undefined],
  ["error sending request for url (https://api.example.com/v1/chat/completions): error trying to connect: dns error: failed to lookup address information", "unreachable", undefined, true, "aiBaseUrl"],
  ["error sending request for url (http://localhost:1/v1/chat/completions): tcp connect error: Connection refused (os error 111)", "unreachable", undefined, true, "aiBaseUrl"],
  ["error sending request for url (https://x.example/v1/chat/completions): invalid peer certificate: UnknownIssuer", "unreachable", undefined, true, "aiBaseUrl"],
  ["builder error: relative URL without a base", "unreachable", undefined, false, "aiBaseUrl"],
  ["error decoding response body", "unreachable", undefined, true, "aiBaseUrl"],
  ["AI_SOMETHING_NEW: a code this version does not know", "other", undefined, false, undefined],
  ["something nobody expected", "other", undefined, true, undefined],
];
for (const [raw, kind, status, retry, focus] of TABLE) {
  const p = classifyAiError(raw);
  const label = String(raw instanceof Error ? raw.message : raw).slice(0, 70);
  assert.ok(p, `${label}: a problem`);
  assert.equal(p.kind, kind, `${label}: kind`);
  assert.equal(p.status, status, `${label}: status`);
  assert.equal(p.retry, retry, `${label}: retry`);
  assert.equal(p.focus, focus, `${label}: field`);
}
// the person's own Cancel is no problem
assert.equal(classifyAiError("AI_CANCELLED: The AI Assistant request was cancelled."), null);
assert.equal(classifyAiError(new Error("AI_CANCELLED: The AI Assistant request was cancelled.")), null);
// "Try again" is offered exactly where the translation's own second try would also be made, plus the slow answers: never for a refusal
for (const [raw] of TABLE) {
  const p = classifyAiError(raw);
  if (p.kind === "auth" || p.kind === "model" || p.kind === "notConfigured" || p.kind === "badAddress") assert.equal(p.retry, false, `${p.kind}: trying again cannot help`);
  if (p.kind === "busy" || p.kind === "timeout" || p.kind === "unreadable") assert.equal(p.retry, true, `${p.kind}: trying again can help`);
}
// the buttons: the settings always; "Try again" only with a retry that exists and a problem it can help with, and then first
assert.deepEqual(aiProblemButtons(classifyAiError(NOT_SET_UP), true), ["settings"]);
assert.deepEqual(aiProblemButtons(classifyAiError(http(401)), true), ["settings"]);
assert.deepEqual(aiProblemButtons(classifyAiError(http(503)), true), ["tryAgain", "settings"]);
assert.deepEqual(aiProblemButtons(classifyAiError(http(503)), false), ["settings"], "nothing to run again (a feature with no retry)");
assert.deepEqual(aiProblemButtons(classifyAiError("AI_TIMEOUT|secs=1: x"), true), ["tryAgain", "settings"]);
// the sorting agrees with the translation's own rule for one more automatic try (transient = connection and 5xx)
for (const [raw] of TABLE) {
  const p = classifyAiError(raw);
  if (isTransientAiError(raw) && p.kind !== "other" && !/builder error/.test(String(raw))) assert.ok(p.retry, `${String(raw).slice(0, 60)}: a transient error may be tried again`);
}

// ---- 2. the words, in every language -------------------------------------------------------------------------------------------------
const KINDS = ["notConfigured", "auth", "unreachable", "badAddress", "model", "busy", "unreadable", "timeout", "other"];
const SAMPLE = { notConfigured: NOT_SET_UP, auth: http(401), unreachable: "error sending request for url (http://x/)", badAddress: http(404), model: http(404, "model x not found"), busy: http(429), unreadable: "AI_BAD_RESPONSE: x", timeout: "AI_TIMEOUT|secs=3: x", other: http(400, "Max tokens is too large") };
const seen = new Map();
for (const lang of ["en", ...LANGS.map((l) => l.code).filter((c) => c !== "en")]) {
  setLangPref(lang);
  for (const feature of ["summarize", "translate", "write"]) for (const kind of KINDS) {
    const p = classifyAiError(SAMPLE[kind]);
    assert.equal(p.kind, kind, `sample of ${kind}`);
    const text = aiProblemText(feature, p, "The AI Assistant returned an error (400): Max tokens is too large");
    const lines = text.split("\n");
    assert.equal(lines.length, 3, `${lang} ${feature} ${kind}: title, cause, next step`);
    for (const l of lines) {
      assert.ok(l.trim().length >= 3, `${lang} ${kind}: an empty line`);
      assert.doesNotMatch(l, /[{}]|undefined|NaN|AI_[A-Z]|reading\.aiProblem|sk-/, `${lang} ${feature} ${kind}: ${l}`);
    }
    if (kind === "auth" || kind === "busy" || kind === "badAddress") assert.ok(lines[1].includes(String(p.status)), `${lang} ${kind}: the status number is in the cause (${lines[1]})`);
    if (kind === "other") assert.equal(lines[1], "The AI Assistant returned an error (400): Max tokens is too large", "an error with no sentence of its own shows its own (already cut) sentence");
    // translated, not the English text left in: the title and the next step differ from English
    if (lang !== "en") {
      const eng = seen.get(`en|${feature}|${kind}`).split("\n");
      assert.notEqual(lines[0], eng[0], `${lang} ${feature}: the title is English`);
      assert.notEqual(lines[2], eng[2], `${lang} ${kind}: the next step is English`);
    }
    seen.set(`${lang}|${feature}|${kind}`, text);
  }
  for (const key of ["reading.aiProblem.openSettings", "reading.aiProblem.tryAgain"]) assert.ok(t(key).length > 3 && !/[{}]/.test(t(key)), `${lang} ${key}`);
}
setLangPref("en");
// a language switch while the toast is up: the text is made again in the language in use (the toast holds a function)
const make = () => aiProblemText("summarize", classifyAiError(http(401)), "");
setLangPref("en");
const inEnglish = make();
setLangPref("de");
assert.notEqual(make(), inEnglish);
assert.ok(make().includes("401"));
setLangPref("en");
assert.equal(make(), inEnglish);
// the English words are what the owner asked for
setLangPref("en");
const en = (raw, feature = "summarize") => aiProblemText(feature, classifyAiError(raw), "").split("\n");
assert.deepEqual(en(NOT_SET_UP), ["AI Assistant is not set up", "Its address and model are not saved yet.", "In Settings, enter the address of your AI provider, an API key and a model name."]);
assert.equal(en(http(401))[1], "The provider rejected the key (401).");
assert.equal(en(http(404, "model"))[1], "The model name was not found.");
assert.equal(en(http(503))[1], "The provider is busy, try again later (503).");
assert.equal(en("AI_BAD_RESPONSE: x")[1], "The answer could not be read.");
assert.equal(en("AI_TIMEOUT|secs=3: x")[1], "It took too long.");
assert.equal(en("error sending request for url (http://x/)")[1], "Could not reach the address you entered.");
assert.equal(en(NOT_SET_UP, "translate")[0], "AI Assistant is not set up", "the title does not blame a feature");
assert.equal(en(http(401), "translate")[0], "Translate did not work");
assert.equal(en(http(401), "write")[0], "Write with AI did not work");

// ---- 3. the wiring: one helper, one toast, every entry point ------------------------------------------------------------------------
const guide = read("src/aiGuide.ts");
assert.match(guide, /export const AI_PROBLEM_KEY = "ai-problem";/, "one key: a new problem replaces the one on screen, they never stack");
assert.match(guide, /setStickyToast\(AI_PROBLEM_KEY, \{[\s\S]*?text: \(\) => aiProblemText\([\s\S]*?escCloses: true,\s*guide: true,/, "sticky (no ttl), a function text, Esc closes it, laid out as guidance");
assert.doesNotMatch(guide.slice(guide.indexOf("setStickyToast(AI_PROBLEM_KEY, {"), guide.indexOf("export const showAiNotSetUp")), /\bttl\b/, "no timer on it");
assert.match(guide, /label: \(\) => t\("reading\.aiProblem\.openSettings"\)/);
assert.match(guide, /label: \(\) => t\("reading\.aiProblem\.tryAgain"\)/);
assert.match(guide, /closeLabel: \(\) => t\("common\.close"\)/, "the X is named");
assert.match(guide, /type: "settings", tab: "ai", focus: field, nonce: Date\.now\(\)/, "Settings on the AI Assistant tab, with the field and a nonce (it also works when Settings is open already)");
assert.match(guide, /if \(!p\) return false;/, "Cancel shows nothing");
// the entry points: no screen opens Settings by itself or shows an AI error as a plain toast any more
const files = [];
(function walk(d) {
  for (const n of readdirSync(new URL(d, root))) {
    const rel = `${d}${n}`;
    if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
    else if (/\.(ts|tsx)$/.test(n)) files.push(rel);
  }
})("src/");
for (const f of files) {
  if (f === "src/aiGuide.ts") continue;
  assert.doesNotMatch(read(f), /setDialog\(\{ type: "settings", tab: "ai"/, `${f}: Settings > AI Assistant is opened by the toast of src/aiGuide.ts`);
}
const pane = read("src/components/ReadingPane.tsx");
assert.match(pane, /if \(!\(await aiReady\(\)\)\) \{\s*showAiNotSetUp\("summarize"\);/, "Summarize: not set up -> the toast");
assert.match(pane, /export async function translateMessage[\s\S]*?if \(!\(await aiReady\(\)\)\) \{\s*showAiNotSetUp\("translate"\);/, "Translate: not set up -> the toast, no job");
assert.match(pane, /showAiProblem\(out\.error, \{ feature: "summarize", retry: \(\) => void summarize\(\), tied: true \}\)/);
assert.match(pane, /useEffect\(\(\) => \(\) => leaveAiContext\("summarize"\), \[selected\]\)/, "the Try again of a summary goes with its conversation");
const reader = read("src/popout/ReaderView.tsx");
assert.match(reader, /if \(!\(await aiReady\(\)\)\) \{\s*showAiNotSetUp\("summarize"\)/, "the reader window");
assert.match(reader, /showAiProblem\(out\.error, \{ feature: "summarize", retry: \(\) => void summarize\(\) \}\)/);
assert.match(reader, /translateMessage\(last, l\)/, "its Translate entries are the shared ones");
const compose = read("src/components/Compose.tsx");
assert.match(compose, /void aiReady\(\)\.then\(\(ok\) => \(ok \? setAiOpen\(true\) : showAiNotSetUp\("write"\)\)\)/, "Write with AI: not set up -> the toast");
assert.match(compose, /showAiProblem\(out\.error, \{ feature: "write", retry: \(\) => void letAiWrite\(\), tied: true \}\)/);
assert.match(compose, /useEffect\(\(\) => \(\) => leaveAiContext\("write"\), \[\]\)/, "the Try again of a text goes with its message");
const tr = read("src/translate.ts");
assert.match(tr, /if \(j\.status === "failed"\) \{[\s\S]*?showAiProblem\(j\.errorSource \?\? j\.error \?\? "", \{ feature: "translate", retry: \(\) => startTranslation\(j\) \}\);/, "a failed translation: the problem toast, Try again resumes it");
// a pop-out window sends Settings to the main window (these two replace setDialog; the kinds are checked by test-popout)
assert.match(read("src/popout/readerBridge.ts"), /else void askMain\("dialog", \{ dialog: d \}\)/);
assert.match(read("src/popout/ComposeView.tsx"), /setDialog: \(d\) => \{\s*if \(d\) notifyMain\("dialog", \{ dialog: d \}\);/);
// the Settings page: the three fields the toast names are there, and the cursor goes in without scrolling
const settings = read("src/components/SettingsDialog.tsx");
for (const id of ["set-aiBaseUrl", "set-aiKey", "set-aiModel"]) assert.ok(settings.includes(`id="${id}"`), `${id} in the AI Assistant tab`);
assert.equal((settings.match(/id="set-aiModel"/g) || []).length, 2, "the Model control has the id as a list and as a text box");
assert.match(settings, /if \(focus\.startsWith\("ai"\)\) \{\s*const el = document\.getElementById\(\x60set-\$\{focus\}\x60\);\s*if \(el\) \(el\.focus\(\{ preventScroll: true \}\), \(deepDone\.current = done\)\);\s*return;\s*\}/, "an AI field: the cursor goes in, nothing scrolls or moves (the other deep links use the jump of settingsJump.ts)");
assert.match(settings, /\[focus, tab, mbTab, nonce\]\);/, "asked again while Settings is open: the cursor goes in again");
// Esc on the toast closes the toast and nothing else (the app's own Esc closes the open conversation)
const overlays = read("src/components/overlays.tsx");
assert.match(overlays, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*st\.dismissToast\(t\.id\);/);
// the code of every AI error the backend makes is one this file sorts
const rs = read("src-tauri/src/ai.rs");
const codes = new Set([...rs.slice(0, rs.indexOf("#[cfg(test)]")).matchAll(/"(AI_[A-Z_]+)[|:"]/g)].map((m) => m[1]));
for (const c of codes) assert.ok(["AI_CANCELLED", "AI_NOT_CONFIGURED", "AI_TIMEOUT", "AI_BAD_RESPONSE", "AI_HTTP"].includes(c), `the backend sends ${c}: src/aiProblem.ts must sort it`);
for (const c of ["AI_CANCELLED", "AI_NOT_CONFIGURED", "AI_TIMEOUT", "AI_BAD_RESPONSE", "AI_HTTP"]) assert.ok(codes.has(c), `ai.rs still sends ${c}`);

console.log(`ok - test-ai-problem (${TABLE.length} errors sorted, ${seen.size} texts in ${LANGS.length} languages)`);
