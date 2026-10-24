// The model list URL of Settings > AI Assistant > Advanced (W8.11): where the list is asked, which server counts as "the same", when the key goes along, and how the tab asks.
// resolveModelsUrl and originOf run the cases of scripts/fixtures/ai-models-url/cases.json, which the backend runs too (cargo test --lib ai::tests::models_url_is_resolved_like_the_settings_tab).
// Run: node --experimental-strip-types scripts/test-ai-models-url.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostLabel, keyIsSent, MAX_MODELS_URL, originOf, otherServer, resolveModelsUrl } from "../src/aiModelsUrl.ts";
import { keyTag, modelsFetchKey, NO_LIST } from "../src/aiModelsKey.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { cases } = JSON.parse(read("./fixtures/ai-models-url/cases.json"));
assert.ok(cases.length >= 30, `the fixture has its cases (${cases.length})`);

// ---- 1. the cases both sides run
for (const c of cases) {
  const value = c.valueLen ? "/" + "a".repeat(c.valueLen - 1) : c.value;
  const r = resolveModelsUrl(c.base, value);
  const want = c.result === "none" ? { kind: "none" } : c.result === "invalid" ? { kind: "invalid" } : { kind: "url", url: c.result === "long" ? "https://x.test/" + "a".repeat(c.valueLen - 1) : c.result };
  assert.deepEqual(r, want, c.name);
  if (c.origin) assert.equal(originOf(r.url), c.origin, `${c.name}: origin`);
}
assert.equal(MAX_MODELS_URL, 2000);

// ---- 2. the server of the list
const base = "http://127.0.0.1:31841/v1";
const R = (v) => resolveModelsUrl(base, v);
assert.equal(otherServer(base, "", R("")), false, "an empty list URL is the Base URL's server");
assert.equal(otherServer(base, "/api/tags", R("/api/tags")), false, "a path stays on the server");
assert.equal(otherServer(base, "http://127.0.0.1:31841/openai/models?api-version=2024-10-21", R("http://127.0.0.1:31841/openai/models?api-version=2024-10-21")), false, "AC-8.11.3: the same server, an absolute URL");
assert.equal(otherServer(base, "http://127.0.0.1:31842/v1/models", R("http://127.0.0.1:31842/v1/models")), true, "AC-8.11.4: another port is another server");
assert.equal(otherServer(base, "http://localhost:31841/api/tags", R("http://localhost:31841/api/tags")), true, "AC-8.11.6: localhost is not 127.0.0.1");
assert.equal(otherServer(base, "https://127.0.0.1:31841/x", R("https://127.0.0.1:31841/x")), true, "another scheme is another server");
assert.equal(otherServer(base, "HTTP://127.0.0.1:31841/x", R("HTTP://127.0.0.1:31841/x")), false, "capitals do not make another server");
assert.equal(otherServer("https://api.test:443/v1", "https://api.test/x", resolveModelsUrl("https://api.test:443/v1", "https://api.test/x")), false, "the default port counts as no port");
assert.equal(otherServer(base, "models", R("models")), false, "an invalid value is no other server");
assert.equal(otherServer("", "/x", resolveModelsUrl("", "/x")), false, "no Base URL: nothing");
assert.equal(hostLabel("http://127.0.0.1:31842/v1/models"), "127.0.0.1:31842");
assert.equal(hostLabel("https://API.Example.com/v1/models"), "api.example.com");
assert.equal(hostLabel("https://[::1]:8080/x"), "[::1]:8080");

// ---- 3. when the key goes along: to the Base URL's server, or to the one server that was allowed, never elsewhere
const other = "http://127.0.0.1:31842/v1/models";
const otherOrigin = originOf(other);
assert.equal(otherOrigin, "http://127.0.0.1:31842");
assert.equal(keyIsSent(base, "", R(""), ""), true, "mode (b): the Base URL's server");
assert.equal(keyIsSent(base, "/api/tags", R("/api/tags"), ""), true, "a path on the Base URL's server");
assert.equal(keyIsSent(base, other, R(other), ""), false, "another server: no, by default");
assert.equal(keyIsSent(base, other, R(other), otherOrigin), true, "another server that was allowed: yes");
assert.equal(keyIsSent(base, other, R(other), "http://127.0.0.1:31843"), false, "AC-8.11.5: the permission was for another port");
assert.equal(keyIsSent(base, other, R(other), "http://localhost:31842"), false, "another host");
assert.equal(keyIsSent(base, "models", R("models"), otherOrigin), false, "an invalid list URL is asked of nobody");
assert.equal(keyIsSent("", "/x", resolveModelsUrl("", "/x"), ""), false, "no Base URL: nothing");
// AC-8.11.12: with the Base URL moved to the other server the same list URL is on the Base URL's server
assert.equal(keyIsSent("http://127.0.0.1:31842/v1", "/api/tags", resolveModelsUrl("http://127.0.0.1:31842/v1", "/api/tags"), ""), true);

// ---- 4. the fetch key (W8.2 + W8.11): the resolved address and whether the key is sent
const saved = { has: true, tag: "s" };
const fk = (baseUrl, value, typed = "", keyOrigin = "") => {
  const r = resolveModelsUrl(baseUrl, value);
  if (r.kind === "none") return NO_LIST;
  return modelsFetchKey(baseUrl, typed, saved, { url: r.kind === "url" ? r.url : "invalid", sendKey: keyIsSent(baseUrl, value, r, keyOrigin) });
};
assert.equal(fk("", ""), NO_LIST, "no Base URL");
assert.equal(fk(base, "/api/tags"), fk(base + "/", "/api/tags"), "a trailing / of the Base URL is the same request");
assert.equal(fk(base, "/api/tags"), fk(base, " /api/tags "), "spaces around the list URL are the same request");
assert.equal(fk(base, "/api/tags"), fk(base, "http://127.0.0.1:31841/api/tags"), "a relative and an absolute list URL with the same result are one request");
assert.notEqual(fk(base, "/api/tags"), fk(base, "/model/info"), "another list");
assert.notEqual(fk(base, ""), fk(base, "/api/tags"), "automatic against a list URL");
assert.notEqual(fk(base, other), fk(base, other, "", otherOrigin), "the switch turned on is another request (the key goes along)");
assert.equal(fk(base, other, "", otherOrigin), fk(base, other, "", otherOrigin));
assert.equal(fk(base, "models"), fk(base, "ftp://x"), "invalid is invalid: no request for either, and the same slot text");
assert.notEqual(fk(base, "models"), fk(base, "/api/tags"));
// the key that is not sent does not make another request when it changes
assert.equal(fk(base, other, ""), fk(base, other, "typed-key"), "a key that does not go there is no change of the request");
assert.notEqual(fk(base, "/api/tags", ""), fk(base, "/api/tags", "typed-key"), "a key that goes there is");
assert.equal(modelsFetchKey(base, "", saved, { url: "x", sendKey: true }), modelsFetchKey(base, "", { has: true, tag: "s" }, { url: "x", sendKey: true }));
assert.equal(modelsFetchKey(base, "k", { has: false, tag: "s" }, { url: "x", sendKey: true }), modelsFetchKey(base, "", { has: true, tag: keyTag("k") }, { url: "x", sendKey: true }), "Save with a list URL: the same request");
// AC-8.11.13: typing /api/tags letter by letter: the rest after the last letter is the only one asked
{
  const keys = new Set();
  let asked = null;
  let requests = 0;
  for (const ch of ["/", "/a", "/ap", "/api", "/api/", "/api/t", "/api/ta", "/api/tag", "/api/tags"]) {
    const k = fk(base, ch);
    keys.add(k);
    // (the tab asks when the typing rests: only the last value counts)
    asked = k;
  }
  requests = asked === fk(base, "") ? 0 : 1;
  assert.equal(requests, 1);
}
// ---- 5. source pins: the tab, the backend command, the page's call
const tsx = read("../src/components/SettingsDialog.tsx");
const tab = tsx.slice(tsx.indexOf("function AiTab()"), tsx.indexOf("\nfunction KeyRow("));
assert.ok(tab.indexOf("<details") < tab.indexOf('<div className="ai-actions">'), "the disclosure is above Save and the status slot (what Save stores is above Save)");
assert.match(tab, /await Promise\.all\(\[api\.setSetting\("ai_endpoint", v\.ai_endpoint\), api\.setSetting\("ai_model", v\.ai_model\), api\.setSetting\("ai_models_url", modelsUrl\.trim\(\)\), api\.setSetting\("ai_models_key_origin", permitted\)\]\);/, "Save stores the list URL (as typed, trimmed, also when invalid) and the permission with the other two settings in one Promise.all");
assert.match(tab, /const permitted = other && sendKey && resolved\.kind === "url" \? \(originOf\(resolved\.url\) \?\? ""\) : "";/, "the permission is the list's origin while the switch is on for another server, else empty");
assert.match(tab, /setKeyOrigin\(on && resolved\.kind === "url" \? \(originOf\(resolved\.url\) \?\? ""\) : ""\)/, "the switch stores the origin of the server it names");
assert.match(tab, /\{other && \(/, "the warning and the switch are only for another server");
assert.match(tab, /t\("settings\.ai\.modelsUrlOtherHost", \{ host: listHost \}\)/);
assert.match(tab, /label=\{t\("settings\.ai\.modelsUrlSendKey", \{ host: listHost \}\)\}/);
assert.match(tab, /id="set-aiModelsUrl" aria-label=\{t\("settings\.ai\.modelsUrl"\)\} aria-describedby="set-aiModelsUrlHint" spellCheck=\{false\} autoComplete="off" placeholder=\{autoUrl\}/, "the field: its label, its hint, no spell check, the automatic address as the placeholder");
assert.match(tab, /: modelsState === "invalid" \? t\("backend\.AI_MODELS_URL_BAD"\)\n\s*: modelsState === "loading"/, "the status order: failed save, invalid list URL, loading, failed list, no models");
assert.match(tab, /if \(asked\.k === NO_LIST \|\| asked\.invalid\) \{/, "an invalid list URL makes no request");
assert.doesNotMatch(tab, /disabled=\{[^}]*(modelsState|asked|resolved|fetchState)/, "nothing is disabled by the list");
const api = read("../src/api.ts");
assert.match(api, /aiListModels: \(endpoint: string, key\?: string, modelsUrl\?: string, keyOrigin\?: string\) => invoke<string\[\]>\("ai_list_models", \{ endpoint, key: key \?\? null, modelsUrl: modelsUrl \?\? null, keyOrigin: keyOrigin \?\? null \}\)/, "the page's call");
const lib = read("../src-tauri/src/lib.rs");
assert.match(lib, /async fn ai_list_models\(endpoint: String, key: Option<String>, models_url: Option<String>, key_origin: Option<String>\) -> R<Vec<String>>/, "the same command with two optional arguments (no new command: generate_handler!, APP_COMMANDS and the capabilities do not change)");
// chat calls never read the list URL
const ai = read("../src-tauri/src/ai.rs");
assert.doesNotMatch(ai.slice(ai.indexOf("async fn complete_within"), ai.indexOf("fn net_error")), /models_url|key_origin/, "Summarize, Translate and Write with AI never use the list URL");
assert.doesNotMatch(lib.slice(lib.indexOf("async fn ai_complete"), lib.indexOf("async fn ai_list_models")), /ai_models_url|ai_models_key_origin/, "the chat command does not read the settings of the list");
console.log("ok - test-ai-models-url");
