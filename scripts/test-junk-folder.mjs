// Junk is never created: on a mailbox whose saved folder list names no Junk folder the Junk row is hidden and the actions that move mail
// to Junk are off (with a hint); Archive and Trash rows stay (created on first use, F-14). A Junk folder the server gains later is named by
// the next sync (it rewrites the saved list) and the row and actions come back. Rules of src/junk.ts, and that the screens use them.
// Run: node --experimental-strip-types scripts/test-junk-folder.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountHasJunk, accountsOf, canMoveToJunk, folderVisible, JUNK_ACTIONS, ruleTargetProblem } from "../src/junk.ts";

const KEYS = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
// what `list_folders` gives: every standard row for every account, `listed` = the saved list names it
const rows = (accountId, listed, extra = []) => [...KEYS.map((key) => ({ accountId, key, listed: listed.includes(key) })), ...extra.map((key) => ({ accountId, key, listed: true }))];
const withJunk = rows("a1", ["inbox", "sent", "drafts", "archive", "junk", "trash"]);
const noJunk = rows("a2", ["inbox", "sent", "drafts"], ["f:Work"]); // no Junk, and no Archive / Trash yet either
const folders = [...withJunk, ...noJunk];

// 1. the Junk row follows the saved list; Archive and Trash rows stay even when the server lacks them
assert.equal(folderVisible(folders, "a1", "junk"), true);
assert.equal(folderVisible(folders, "a2", "junk"), false);
for (const k of ["inbox", "drafts", "sent", "archive", "trash", "f:Work"]) assert.equal(folderVisible(folders, "a2", k), true, `${k} stays`);

// 2. the all-mailboxes row (favourites, Settings): there when any mailbox has Junk
assert.equal(folderVisible(folders, null, "junk"), true);
assert.equal(folderVisible(noJunk, null, "junk"), false);
assert.equal(folderVisible([], null, "junk"), true, "nothing loaded yet: nothing is hidden on a guess");
assert.equal(folderVisible(folders, null, "archive"), true);

// 3. the actions: every mailbox of the selection needs a Junk folder
assert.equal(canMoveToJunk(folders, ["a1"]), true);
assert.equal(canMoveToJunk(folders, ["a2"]), false);
assert.equal(canMoveToJunk(folders, ["a1", "a2"]), false, "a mixed selection: off");
assert.equal(canMoveToJunk(folders, []), true, "nothing selected: the buttons are off for other reasons");
assert.equal(accountHasJunk(folders, "unknown"), true, "an account whose folders are not loaded: not blocked");
assert.ok(JUNK_ACTIONS.has("junk") && JUNK_ACTIONS.has("block") && !JUNK_ACTIONS.has("archive") && !JUNK_ACTIONS.has("trash"));

// 4. data without the flag (older data, the dev mock): counts as named
assert.equal(accountHasJunk([{ accountId: "a1", key: "junk" }, { accountId: "a1", key: "inbox" }], "a1"), true);

// 5. the server gains a Junk folder: the next sync names it (listed turns true) and everything comes back, with no other change
{
  const after = [...withJunk, ...noJunk.map((f) => (f.key === "junk" ? { ...f, listed: true } : f))];
  assert.equal(folderVisible(after, "a2", "junk"), true);
  assert.equal(canMoveToJunk(after, ["a2"]), true);
  // and an account that had Junk and lost it (the folder was deleted on the server) goes the other way
  const lost = withJunk.map((f) => (f.key === "junk" ? { ...f, listed: false } : f));
  assert.equal(canMoveToJunk(lost, ["a1"]), false);
}

// 6. accountsOf: the mailboxes of the selected conversations (unknown ids are left out)
{
  const threads = [{ threadId: "t1", accountId: "a1" }, { threadId: "t2", accountId: "a2" }, { threadId: "t3", accountId: "a1" }];
  assert.deepEqual(accountsOf(threads, ["t1", "t3"]), ["a1"]);
  assert.deepEqual(accountsOf(threads, ["t1", "t2", "zz"]).sort(), ["a1", "a2"]);
  assert.deepEqual(accountsOf(threads, []), []);
}

// 7. wiring: the screens use the rules
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(read("../src/components/FolderPane.tsx"), /std\.filter\(\(k\) => folderVisible\(folders, a\.id, k\)\)/);
  assert.match(read("../src/components/FolderPane.tsx"), /favs\.filter\(\(f\) => folderVisible\(folders, f\.acct, f\.key\)\)/);
  const ribbon = read("../src/components/Ribbon.tsx");
  assert.match(ribbon, /\.\.\.junkOff \},\n\s*\{ label: t\("app\.ribbon\.blockSender"\)/);
  // (1.0.6) the ribbon's Move to menu and the row context menu share moveChoices (src/rowMenu.ts), which applies folderVisible
  assert.match(ribbon, /moveChoices\(folders, acct, scope\)/, "Move to > Junk");
  assert.match(read("../src/rowMenu.ts"), /folderVisible\(folders, f\.accountId, f\.key\)/, "Move to > Junk (shared rule)");
  const reading = read("../src/components/ReadingPane.tsx");
  assert.match(reading, /moveJunk"\), onClick: .*\.\.\.junkOff/);
  assert.match(reading, /blockSender"\), onClick: .*\.\.\.junkOff/);
  assert.match(read("../src/store.ts"), /JUNK_ACTIONS\.has\(action\) && !canMoveToJunk\(get\(\)\.folders, accountsOf\(get\(\)\.threads, ids\)\)/, "the keyboard shortcut is stopped too");
  assert.match(read("../src/components/CommandBar.tsx"), /folderVisible\(s\.folders, s\.accountId, f\)/);
  assert.match(read("../src/components/SettingsDialog.tsx"), /folderVisible\(folders, scope, k\.key\)/);
  assert.match(read("../src-tauri/src/lib.rs"), /listed: map\.contains_key\(&k\)/, "the backend says which rows its saved list names");
}

// 5. (W6.2) a filter that moves mail to Junk: the editor greys the option out and the list tags the rule where the mailbox has no Junk folder
{
  const ids = ["a1", "a2"];
  const junkRule = (accountId) => ({ action: "junk", accountId });
  assert.equal(ruleTargetProblem(junkRule("a1"), folders, ids), null, "a mailbox with Junk");
  assert.equal(ruleTargetProblem(junkRule("a2"), folders, ids), "no-junk", "a mailbox without Junk");
  assert.equal(ruleTargetProblem(junkRule(null), folders, ids), null, "all mailboxes: works where there is a Junk folder");
  assert.equal(ruleTargetProblem(junkRule(null), noJunk, ["a2"]), "no-junk", "all mailboxes and none has Junk");
  assert.equal(ruleTargetProblem(junkRule(null), [], ids), null, "all mailboxes, folders not loaded yet: not judged");
  assert.equal(ruleTargetProblem(junkRule("zz"), folders, ids), null, "a mailbox whose folders are not loaded: not judged");
  assert.equal(ruleTargetProblem(junkRule(undefined), noJunk, ["a2"]), "no-junk", "no mailbox field counts as all mailboxes");
  for (const action of ["archive", "trash", "read", "star", "pin", "move"]) assert.equal(ruleTargetProblem({ action, accountId: "a2" }, folders, ids), null, action);
  // a Junk folder the server gains: the next sync names it and the rule works again with no change
  const gained = [...withJunk, ...rows("a2", ["inbox", "sent", "drafts", "junk"])];
  assert.equal(ruleTargetProblem(junkRule("a2"), gained, ids), null);
  const dlg = readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8").replaceAll(String.fromCharCode(13), "");
  assert.ok(dlg.includes('ruleTargetProblem(r, folders, accountIds) && <span className="ov-tag">{t("mail.junk.none")}</span>'), "the list tag");
  assert.ok(dlg.includes('<option value="junk" disabled={junkProblem && cur.action !== "junk"}>{junkProblem ? t("settings.filters.toJunkNone") : t("settings.filters.toJunk")}</option>'), "the option");
  assert.ok(dlg.includes('cur.action === "junk" && junkProblem && <div className="muted small" role="note">{t("mail.junk.noneTip")}</div>'), "the hint under the select");
}

console.log("ok - test-junk-folder");
