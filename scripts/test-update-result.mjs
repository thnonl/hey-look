// Source check of the result of an update (QA BUG-12: no "Hey Look! is updated to 1.0.0." toast was seen after any of four updates) and of
// the stale-offer note (QA round 6, stopped server). The behaviour itself was run in the dev mock (a headless browser): the toast stays on
// screen, is acknowledged once, and the offline note shows next to a failed download.
// Run: node scripts/test-update-result.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const updates = read("src/updates.ts");
const api = read("src/api.ts");
const rust = read("src-tauri/src/update.rs");
const lib = read("src-tauri/src/lib.rs");
const card = read("src/components/Updates.tsx");

// 1. The result toast is sticky (it was a 4.5 s toast, gone before anyone looked), closes itself after 30 s, and the page tells the backend once it showed it.
const start = updates.slice(updates.indexOf("startupCheck: async () => {"));
const body = start.slice(0, start.indexOf("\n    },\n"));
assert.match(body, /setStickyToast\(key, \{ text: `Hey Look! is updated to/, "success result is a sticky toast");
assert.match(body, /kind: "success"/);
assert.match(body, /The update to \$\{s\.version\} didn’t finish\. You can try again in Settings > About\./, "REQ-30 wording of the failed install");
assert.match(body, /setTimeout\(\(\) => useStore\.getState\(\)\.setStickyToast\(key, null\), 30_000\)/, "it goes after 30 s");
assert.ok(body.indexOf("setStickyToast(key, {") < body.indexOf("api.updateStartupAck()"), "the ack comes after the toast is shown");
assert.ok(!/showToast\(`Hey Look! is updated/.test(body), "no short-lived toast for the result");

// 2. The ack exists on both sides, and the backend keeps the marker until it arrives.
assert.match(api, /updateStartupAck: \(\) => invoke<void>\("update_startup_ack"\)/);
assert.match(lib, /update::update_startup_ack,/, "registered as a command");
const state = rust.slice(rust.indexOf("fn startup_state(db: &Db, current: &str)"));
const stateBody = state.slice(0, state.indexOf("\n}\n"));
assert.ok(!/set_setting\(&c, "update_installing", ""\);\n    let _ = db::set_setting\(&c, "update_restart_draft"/.test(stateBody), "reading the state does not clear the marker");
assert.match(rust, /pub fn update_startup_ack[\s\S]*forget_install\(&state\.db\)/, "the ack clears it");

// 3. The marker is written before the installer starts (the installer ends the process) and logged in startup.log.
assert.match(rust, /fn remember_install[\s\S]*crate::startup::line\("update", &format!\("install of \{version\} started from \{current\}: marker written/);

// 4. After a failed download the offline note is shown next to the failure (REQ-47 h keeps the failure on the card).
assert.match(card, /isStaleOffer\(update\) && \(mine === "idle" \|\| mine === "failed"\)/);
// 5. BUG-13: `Restart now` with a draft that cannot be saved is never silent. The error toast is sticky (a toast of 8 s was gone before the
// QA looked, and a slow server makes the save take seconds), a saver that throws counts as a failed save, anything else that goes wrong
// before the installer starts is told too, and startup.log gets a line saying why no restart began (QA found no `[update]` line).
const restart = updates.slice(updates.indexOf("restartToUpdate: async () => {"));
const restartBody = restart.slice(0, restart.indexOf("\n    },\n"));
assert.match(updates, /const RESTART_STOPPED_TEXT = "Couldn’t save your draft, so Hey Look! didn’t restart\. Your message is still open\."/, "REQ-28 c wording");
assert.match(restartBody, /setStickyToast\(RESTART_STOPPED, \{ text: RESTART_STOPPED_TEXT, kind: "error", closeLabel: "Close" \}\)/, "the failed save toast is sticky");
assert.ok(!/showToast\(RESTART_STOPPED_TEXT/.test(restartBody) && !/showToast\("Couldn’t save your draft/.test(restartBody), "not a short-lived toast");
assert.match(restartBody, /try \{\s+return st\.composeSaver \? await st\.composeSaver\(\{ quiet: true \}\) : false;\s+\} catch \{\s+return false;/, "a throwing saver is a failed save");
assert.match(restartBody, /api\.updateNote\(`restart not started: the draft could not be saved/, "startup.log says why");
assert.match(restartBody, /\} catch \(e\) \{[\s\S]*RESTART_STOPPED[\s\S]*api\.updateNote\(`restart not started: \$\{friendlyError\(e\)\}`\)[\s\S]*\} finally \{\s+restarting = false;/, "any other failure before the installer is told too");
assert.ok(restartBody.indexOf('return stay("dirty")') < restartBody.indexOf("await api.updateInstall(true, draftSaved)"), "no install after a failed save");
assert.match(api, /updateNote: \(text: string\) => invoke<void>\("update_note", \{ text \}\)/);
assert.match(lib, /update::update_note,/, "registered as a command");
assert.match(rust, /pub fn update_note\(text: String\)[\s\S]*crate::startup::line\("update"/, "the note goes to startup.log");

console.log("update-result: all checks passed");
