// What the person can read when an AI Assistant call fails (Translate, Summarize, Write with AI, the model list in Settings): always a sentence of
// the dictionary made from a code, in the language in use, with the provider's own short words kept as they came; never raw JSON, never the API
// key, never a code name. The Rust side has its own tests (src-tauri/src/ai.rs); this one covers the sentences and the call sites.
// Run: node --experimental-strip-types scripts/test-ai-errors.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backendText } from "../src/backendErrors.ts";
import { LANGS, setLangPref } from "../src/i18n/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

// 8. every AI error the person can read, in every language: made from a code, no raw JSON, no key, no code name
{
  const key = "sk-live-0123456789abcdef";
  const coded = [
    "AI_NOT_CONFIGURED: AI not configured: set endpoint and model in Settings > AI",
    "AI_TIMEOUT|secs=180: The AI Assistant didn’t answer within 180 seconds.",
    "AI_TIMEOUT_TOTAL|mins=15: The translation took longer than 15 minutes in all.",
    "AI_CANCELLED: The AI Assistant request was cancelled.",
    "AI_HTTP|status=500|detail=The model is overloaded.: The AI Assistant returned an error (500): The model is overloaded.",
    "AI_HTTP|v=plain|status=502: The AI Assistant returned an error (502).",
    "AI_BAD_RESPONSE: The AI Assistant sent an answer the app can’t read.",
  ];
  for (const l of LANGS) {
    setLangPref(l.code);
    for (const raw of coded) {
      const text = backendText(raw);
      assert.ok(text, `${l.code}: ${raw} has a sentence`);
      assert.ok(!/[{}]|AI_|\||sk-/.test(text), `${l.code}: ${text}`);
      assert.ok(!text.includes(key));
    }
    assert.match(backendText(coded[1]), /180/, `${l.code}: the seconds are in the timeout sentence`);
    assert.match(backendText(coded[2]), /15/, `${l.code}: the minutes are in the total-time sentence`);
    assert.match(backendText(coded[4]), /500/);
    assert.match(backendText(coded[4]), /The model is overloaded\./, `${l.code}: the provider's own words stay as they came (English)`);
  }
  setLangPref("en");
}

// 9. where AI errors come from, in the code: the one place that calls the model, the one place that shows its errors
{
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) files.push(p);
    }
  };
  walk(join(root, "src"));
  const rel = (p) => p.slice(root.length).replace(/\\/g, "/");
  const callers = files.filter((p) => /\baiComplete\b/.test(readFileSync(p, "utf8"))).map(rel).sort();
  assert.deepEqual(callers, ["src/aiCall.ts", "src/api.ts", "src/translate.ts", "src/translateRun.ts", "src/useAiSlot.ts"], "a new caller of the model must show its errors like these do (friendlyError) and be cancellable");
  const read = (p) => readFileSync(join(root, p), "utf8");
  // each screen that gets an outcome shows errors through friendlyError, never the raw value
  assert.match(read("src/components/ReadingPane.tsx"), /"error" in out\) showToast\(\(\) => friendlyError\(out\.error\)/);
  assert.match(read("src/components/Compose.tsx"), /"error" in out\) return showToast\(\(\) => friendlyError\(out\.error\)/);
  assert.match(read("src/translate.ts"), /friendlyError\(outcome\.error\)/);
  assert.match(read("src/components/SettingsDialog.tsx"), /setModelsErr\(friendlyError\(e\)\)/);
  // the Rust side: no error text is built from the answer, the request or the key
  const rs = read("src-tauri/src/ai.rs");
  const prod = rs.slice(0, rs.indexOf("#[cfg(test)]"));
  assert.doesNotMatch(prod, /format!\([^;]*\{(body|text|answer|key|resp|prompt|system)\b[^}]*\}/, "no format! of the answer, the key or the prompt in an error");
  assert.doesNotMatch(prod, /unexpected AI response/, "the old error that printed the provider's JSON");
}

console.log("ok - test-ai-errors");
