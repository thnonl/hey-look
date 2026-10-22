// OBS-1 (1.0.4): Archive / Delete / Junk / Move must look up (and, for Archive and Trash, create) the target folder on the server BEFORE
// the mail leaves the list and "Archived" appears. When that fails the mail stays and the error comes at once; the Undo window of the
// normal case is unchanged. The server side is covered by the Rust tests (foldermove_tests.rs, `prepare_*`); this checks the order in
// src/store.ts `act` and the pieces it relies on.
// Run: node --experimental-strip-types scripts/test-prepare-move.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const store = read("../src/store.ts");
const act = store.slice(store.indexOf("  act: async"), store.indexOf("  openCompose: async"));

const iPrepare = act.indexOf("api.prepareAction(");
const iHide = act.indexOf("set({ threads: threads.filter((t) => !ids.includes(t.threadId)), folders: withThreadsGone(");
const iQueue = act.indexOf("api.queueAction(");
const iToast = act.indexOf("get().showToast(\n            label,");
assert.ok(iPrepare > 0 && iHide > 0 && iQueue > 0 && iToast > 0, "the pieces are found");
assert.ok(iPrepare < iHide, "the folder is looked up before the mail leaves the list");
assert.ok(iPrepare < iQueue && iPrepare < iToast, "and before the move is queued and the success message is shown");
// a failed look-up: the error toast, and `return` before anything is hidden
const catchBlock = act.slice(act.indexOf("catch (e)", iPrepare), act.indexOf("} finally", iPrepare));
assert.match(catchBlock, /showToast\(\(\) => t\("errors\.toast\.failed", \{ error: friendlyError\(e\) \}\), undefined, "error"\);\s*return;/, "error shown at once, nothing hidden");
// a delete from the Trash (permanent) is not a move: no folder to look up
assert.match(act, /const real = moveLike && action === "trash" && scope === "trash" \? "delete_forever" : action;/);
assert.match(act, /if \(real !== "delete_forever"\) \{\s*for \(const id of ids\) preparing\.add\(id\);/);
// a second press while the first one is still looking does not start another
assert.match(act, /const todo = ids\.filter\(\(id\) => !preparing\.has\(id\)\);[^\n]*\n\s*if \(todo\.length === 0\) return;/);
assert.match(act, /finally \{\s*for \(const id of ids\) preparing\.delete\(id\);/, "the guard is always released");
// the Undo window of the normal case is untouched
assert.match(act, /api\.queueAction\(ids, real, arg \?\? null, scope \?\? null, prefs\.undoActionSeconds, verify\)/);
assert.match(act, /void api\.cancelAction\(token\)\.then\(\(\) => get\(\)\.refresh\(\)\)/);
// (BUG-1) what the look-up says (the saved list was trusted) is handed on, so the backend checks that folder during the Undo window
assert.match(act, /verify = await api\.prepareAction\(/);
assert.match(act, /let verify = false;/);

// api.ts and the backend command exist under the same name
assert.match(read("../src/api.ts"), /prepareAction: \(threadIds: string\[\], action: string, arg: string \| null, scope: string \| null\) =>\s*invoke<boolean>\("prepare_action", \{ threadIds, action, arg, scope \}\)/);
const lib = read("../src-tauri/src/lib.rs");
assert.match(lib, /async fn prepare_action\(/);
assert.match(lib, /thread_action,\s*prepare_action,/, "registered");
// the failure is the coded error the UI already translates (FOLDER_NOT_CREATED / FOLDER_MISSING)
const backend = read("../src/i18n/ns/backend.ts");
assert.ok(backend.includes('"backend.FOLDER_NOT_CREATED"') && backend.includes('"backend.FOLDER_MISSING"'));
console.log("prepare-move: all checks passed");
