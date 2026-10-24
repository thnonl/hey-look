// Settings > AI Assistant asks the endpoint for its model list only when the request changed (W8.2, extended by W8.11): the rule of src/aiModelsKey.ts.
// A state machine that does what AiTab does (the fetch key of the inputs, a debounce that rests for 600 ms, "ask when the key differs from the last request") runs the sequences of the
// acceptance criteria and counts the requests. The tab's wiring is pinned as source text.
// Run: node --experimental-strip-types scripts/test-ai-models-key.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keyIdentity, keyTag, modelsFetchKey, normEndpoint, NO_LIST } from "../src/aiModelsKey.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- the pieces
assert.equal(normEndpoint("  https://api.example.com/v1/  "), "https://api.example.com/v1");
assert.equal(normEndpoint("https://api.example.com/v1///"), "https://api.example.com/v1");
assert.equal(normEndpoint("   "), "");
assert.equal(keyIdentity("", { has: false, tag: "s" }), "no-key");
assert.equal(keyIdentity("", { has: true, tag: "s" }), "s", "the saved key");
assert.equal(keyIdentity("  abc ", { has: true, tag: "s" }), keyTag("abc"), "a typed key wins over the saved one, trimmed");
assert.equal(keyIdentity("abc", { has: false, tag: "s" }), keyTag("abc"));
assert.equal(modelsFetchKey("  ", "abc", { has: true, tag: "s" }), NO_LIST, "no Base URL: nothing to ask");
assert.equal(modelsFetchKey("https://x.test/v1/", "", { has: false, tag: "s" }), modelsFetchKey("https://x.test/v1", "", { has: false, tag: "s" }), "a trailing slash is not another request");
assert.notEqual(modelsFetchKey("https://x.test/v1", "", { has: false, tag: "s" }), modelsFetchKey("https://x.test/v2", "", { has: false, tag: "s" }));

// ---- the tab: inputs -> fetch key -> a request when it differs from the last one
class Tab {
  constructor() {
    this.endpoint = "";
    this.typed = "";
    this.saved = { has: false, tag: "s" };
    this.asked = null; // the last request's key
    this.requests = [];
    this.pending = null; // the key waiting for its 600 ms
  }
  key() { return modelsFetchKey(this.endpoint, this.typed, this.saved); }
  /** one change of the inputs: the debounce restarts */
  touch() { this.pending = this.key(); }
  /** the typing rested for 600 ms */
  rest() {
    const k = this.pending ?? this.key();
    this.pending = null;
    if (k === this.asked) return;
    this.asked = k;
    if (k !== NO_LIST) this.requests.push({ endpoint: this.endpoint.trim(), key: this.typed.trim() || (this.saved.has ? "saved" : "") });
  }
  open(endpoint, hasKey) { this.endpoint = endpoint; this.saved = { has: hasKey, tag: "s" }; this.touch(); this.rest(); }
  setEndpoint(v) { this.endpoint = v; this.touch(); }
  type(v) { this.typed = v; this.touch(); }
  /** Save: the typed key becomes the saved one (the box is emptied), nothing is asked by the save itself */
  save() { if (this.typed.trim()) { this.saved = { has: true, tag: keyTag(this.typed) }; this.typed = ""; } this.touch(); }
  removeKey() { this.saved = { has: false, tag: "s" }; this.touch(); }
}

// AC-8.2.1: open: 1; a typed key: 2 (with it); Save: still 2
{
  const t = new Tab();
  t.open("http://127.0.0.1:31841/v1", false);
  assert.equal(t.requests.length, 1, "opening the tab asks once");
  t.type("qa-key-1"); t.rest();
  assert.equal(t.requests.length, 2, "a typed key asks again");
  assert.equal(t.requests[1].key, "qa-key-1");
  t.save(); t.rest();
  assert.equal(t.requests.length, 2, "Save asks nothing: the typed key became the saved key");
  // AC-8.2.2: Save again
  t.save(); t.rest();
  assert.equal(t.requests.length, 2, "a second Save asks nothing");
  // AC-8.2.3: a trailing slash added and taken back within the debounce; then another server
  t.setEndpoint("http://127.0.0.1:31841/v1/"); t.setEndpoint("http://127.0.0.1:31841/v1"); t.rest();
  assert.equal(t.requests.length, 2, "added and taken back: nothing");
  t.setEndpoint("http://127.0.0.1:31841/v1/"); t.rest();
  assert.equal(t.requests.length, 2, "a trailing slash alone is the same request");
  t.setEndpoint("http://127.0.0.1:31842/v1"); t.rest();
  assert.equal(t.requests.length, 3, "another server: one more");
  // AC-8.2.4: remove the saved key
  t.removeKey(); t.rest();
  assert.equal(t.requests.length, 4, "removing the saved key asks again, without the key");
  assert.equal(t.requests[3].key, "");
  // AC-8.2.5: the tab opens again: one more
  const t2 = new Tab();
  t2.open("http://127.0.0.1:31842/v1", false);
  assert.equal(t2.requests.length, 1);
}
// a saved key at open, nothing typed, Save with nothing typed: nothing
{
  const t = new Tab();
  t.open("https://api.example.com/v1", true);
  assert.equal(t.requests.length, 1);
  t.save(); t.rest(); t.save(); t.rest();
  assert.equal(t.requests.length, 1, "Save with nothing typed and the Base URL unchanged asks nothing");
  // a new key that is saved: one for the typing, none for the Save
  t.type("new-key"); t.rest();
  assert.equal(t.requests.length, 2);
  t.save(); t.rest();
  assert.equal(t.requests.length, 2);
  // typing the saved key's text again is the same request
  t.type("new-key"); t.rest();
  assert.equal(t.requests.length, 2, "the key that was just saved, typed again: the same request");
  // another key: another request
  t.type("other-key"); t.rest();
  assert.equal(t.requests.length, 3);
  // typed and cleared before it rested: nothing
  t.type("zzz"); t.type("other-key"); t.rest();
  assert.equal(t.requests.length, 3, "changed and taken back inside the debounce");
  t.type(""); t.rest();
  assert.equal(t.requests.length, 4, "clearing a typed key goes back to the saved one: that is another request");
}
// no Base URL: no request; an emptied Base URL asks nothing, a typed one asks once
{
  const t = new Tab();
  t.open("", false);
  assert.equal(t.requests.length, 0);
  t.setEndpoint("https://x.test/v1"); t.rest();
  assert.equal(t.requests.length, 1);
  t.setEndpoint(""); t.rest();
  assert.equal(t.requests.length, 1, "an empty Base URL asks nothing");
  t.setEndpoint("https://x.test/v1"); t.rest();
  assert.equal(t.requests.length, 2, "the same address again after an empty one is a request again (the list was cleared)");
}
// fast typing of the Base URL: one request for the end of it
{
  const t = new Tab();
  t.open("https://x.test/v1", false);
  for (const ch of ["h", "ht", "htt", "https://y.test/v1"]) t.setEndpoint(ch);
  t.rest();
  assert.equal(t.requests.length, 2, "letter by letter: one request when the typing rests");
}

// ---- the wiring in AiTab (source pins)
const tsx = read("../src/components/SettingsDialog.tsx");
const tab = tsx.slice(tsx.indexOf("function AiTab()"), tsx.indexOf("\nfunction KeyRow("));
assert.match(tab, /const fetchKey = modelsFetchKey\(v\.ai_endpoint, key, \{ has: hasKey, tag: savedTag \}, resolved\.kind === "none" \? undefined : \{ url: resolved\.kind === "url" \? resolved\.url : "invalid", sendKey \}\);/, "the fetch key comes from the inputs (the Base URL, the key used, the resolved list and whether the key goes there)");
assert.match(tab, /if \(!ready \|\| fetchKey === asked\?\.k\) return;/, "nothing is asked when the key is the one of the last request");
assert.match(tab, /const due = \{ k: fetchKey, endpoint: v\.ai_endpoint\.trim\(\), key: key\.trim\(\), modelsUrl: modelsUrl\.trim\(\), keyOrigin, invalid: resolved\.kind === "invalid" \};[\s\S]*?setTimeout\(\(\) => setAsked\(due\), 600\)/, "the request is due when the typing rests for 600 ms");
assert.match(tab, /api\.aiListModels\(asked\.endpoint, asked\.key \|\| undefined, asked\.modelsUrl \|\| undefined, asked\.keyOrigin \|\| undefined\)/, "the request is made from what was asked");
assert.match(tab, /\}, \[asked\]\);/, "and only when the request changes");
assert.match(tab, /setSavedTag\(keyTag\(key\)\);\s*\/\/[^\n]*\n\s*setHasKey\(true\);\s*setKey\(""\);/, "Save: the typed key becomes the saved key with the same identity");
assert.doesNotMatch(tab, /\}, \[ready, v\.ai_endpoint, key, hasKey\]\);/, "the old effect that asked on every change of the key box and hasKey is gone");
assert.doesNotMatch(tab.slice(tab.indexOf("const save = async")), /aiListModels/, "Save never asks by itself");
console.log("ok - test-ai-models-key");
