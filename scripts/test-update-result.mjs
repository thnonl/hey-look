// Source check of the result of an update (QA BUG-12: no "Hey Look! is updated to 1.0.0." toast was seen after any of four updates) and of
// the stale-offer note (QA round 6, stopped server). The behaviour itself was run in the dev mock (a headless browser): the toast stays on
// screen, is acknowledged once, and the offline note shows next to a failed download.
// The texts are in the dictionary (src/i18n/ns/updates.ts): the source is checked for the keys, the English wording through en.
// Run: node --experimental-strip-types scripts/test-update-result.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { en } from "../src/i18n/en.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const updates = read("src/updates.ts");
const api = read("src/api.ts");
const rust = read("src-tauri/src/update.rs");
const lib = read("src-tauri/src/lib.rs");
const card = read("src/components/Updates.tsx");

// 1. The result toast is sticky (it was a 4.5 s toast, gone before anyone looked), closes itself after 30 s, and the page tells the backend once it showed it.
const start = updates.slice(updates.indexOf("startupCheck: async () => {"));
const body = start.slice(0, start.indexOf("\n    },\n"));
assert.match(body, /setStickyToast\(key, \{ text: \(\) => t\(s\.draft \? "updates\.result\.updatedDraft" : "updates\.result\.updated"/, "success result is a sticky toast");
assert.equal(en["updates.result.updated"], "Hey Look! is updated to {version}.");
assert.equal(en["updates.result.updatedDraft"], "Hey Look! is updated to {version}. Your message is in Drafts.");
assert.match(body, /kind: "success"/);
assert.match(body, /text: \(\) => t\("updates\.result\.failed", \{ version: s\.version/, "REQ-30 failed install");
assert.equal(en["updates.result.failed"], "The update to {version} didn’t finish. You can try again in Settings > About.", "REQ-30 wording of the failed install");
assert.match(body, /stickyTimer\.arm\(key\)/, "it goes after 30 s (one timer per toast, see stickyTimers.ts, BUG-14)");
assert.ok(body.indexOf("setStickyToast(key, {") < body.indexOf("api.updateStartupAck()"), "the ack comes after the toast is shown");
assert.ok(!/showToast\(t\("updates\.result/.test(body), "no short-lived toast for the result");

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
assert.ok(!/RESTART_STOPPED_TEXT/.test(updates) && !("updates.restartStopped" in en), "the failed-save toast is gone: the B variant dialog replaced it (1.0.3)");
// REQ-28 c, B variant (owner decision B, AC-74): a failed save asks instead of stopping with a toast.
assert.equal(en["updates.ask.unsavedTitle"], "Your message isn’t saved");
assert.equal(en["updates.ask.unsavedBody"], "Hey Look! couldn’t save it to Drafts ({error}), so it didn’t restart. If you restart now, it’s lost.");
assert.equal(en["updates.action.keepWriting"], "Keep writing");
assert.equal(en["updates.action.restartDiscardMessage"], "Restart and discard");
const unsaved = restartBody.slice(restartBody.indexOf("if (saved !== true) {"), restartBody.indexOf("await st.openCompose(null)"));
assert.match(unsaved, /st\.choose\(\{\s+title: t\("updates\.ask\.unsavedTitle"\),\s+body: t\("updates\.ask\.unsavedBody", \{ error \}\),/, "the dialog has the spec title and body");
assert.match(unsaved, /choices: \[\s+\{ id: "keep", label: t\("updates\.action\.keepWriting"\), kind: "primary" \},\s+\{ id: "restart", label: t\("updates\.action\.restartDiscardMessage"\), kind: "danger" \},\s+\],/, "Keep writing is first (focus, Esc, a click outside) and Restart and discard is the danger button");
assert.match(unsaved, /if \(c !== "restart"\) \{[\s\S]*restart not started: the draft could not be saved[\s\S]*return stay\("dirty"\);/, "Keep writing (or Esc): no restart, startup.log says why, the card keeps Restart now");
const discardPart = unsaved.slice(unsaved.indexOf('c !== "restart"'), unsaved.indexOf("} else {"));
assert.ok(!/draftSaved = true/.test(discardPart), "a discarded message is not reported as saved to Drafts (the result toast after the restart must not say so)");
assert.ok(!/saveDraft|composeSaver/.test(discardPart), "Restart and discard writes no draft");
assert.match(discardPart, /st\.setComposeDirty\(false\);\s*$/, "Restart and discard closes Compose without the unsaved-changes question");
assert.match(unsaved, /\} else \{\s+draftSaved = true;/, "only a saved draft sets the Drafts part of the result toast");
for (const lang of ["vi", "fr"]) {
  const dict = (await import(new URL(`../src/i18n/${lang}.ts`, import.meta.url)))[lang];
  for (const k of ["updates.ask.unsavedTitle", "updates.ask.unsavedBody", "updates.action.keepWriting", "updates.action.restartDiscardMessage"]) assert.ok(dict[k] && dict[k] !== en[k], `${lang} has ${k}`);
  assert.ok(dict["updates.ask.unsavedBody"].includes("{error}"), `${lang} body keeps {error}`);
}
assert.ok(restartBody.indexOf('title: t("updates.ask.unsavedTitle")') < restartBody.indexOf("await api.updateInstall(true, draftSaved)"), "the question comes before the installer");
// the dev mock path of AC-74: #draftfail makes save_draft fail, and the mock counts the calls so a check can see that discarding writes none
const mock = read("src/devMock.ts");
assert.match(mock, /hashTokens\(\)\.has\("draftfail"\)\) throw/, "AC-74 mock path");
assert.match(mock, /__draftSaveCalls/, "the mock counts save_draft calls");
assert.match(restartBody, /try \{\s+return st\.composeSaver \? await st\.composeSaver\(\{ quiet: true \}\) : false;\s+\} catch \{\s+return false;/, "a throwing saver is a failed save");
assert.match(restartBody, /api\.updateNote\(`restart not started: the draft could not be saved/, "startup.log says why");
assert.match(restartBody, /\} catch \(e\) \{[\s\S]*RESTART_STOPPED[\s\S]*api\.updateNote\(`restart not started: \$\{friendlyError\(e\)\}`\)[\s\S]*\} finally \{\s+restarting = false;/, "any other failure before the installer is told too");
assert.ok(restartBody.indexOf('return stay("dirty")') < restartBody.indexOf("await api.updateInstall(true, draftSaved)"), "no install after a failed save");
assert.match(api, /updateNote: \(text: string\) => invoke<void>\("update_note", \{ text \}\)/);
assert.match(lib, /update::update_note,/, "registered as a command");
assert.match(rust, /pub fn update_note\(text: String\)[\s\S]*crate::startup::line\("update"/, "the note goes to startup.log");

console.log("update-result: all checks passed");
