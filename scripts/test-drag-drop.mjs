// Drag and drop between windows (W4.7): the decisions of src/dragDrop.ts and how the pieces are wired. The browser side is scripts/test-popout-dnd.mjs; the registry is Rust (drag.rs).
// Run: node --experimental-strip-types scripts/test-drag-drop.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dragIds, dropAction, dropAllowed, fileDropOk, FILE_DRAG, MAIL_DRAG, mayDragRow, parsePayload, tokenIn, tokenType } from "../src/dragDrop.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// ---- the folders the "Move to" menu offers for a mailbox (src/rowMenu.ts moveChoices): the standard folders and the folders of the person; no Drafts, no Sent
const keys = { a1: ["inbox", "archive", "junk", "trash", "f:Projects", "f:Projects/Hey Look"], a2: ["inbox", "archive", "trash"] };
const moveKeys = (acct) => keys[acct] ?? [];
const item = (threadId, accountId = "a1", folder = "inbox") => ({ threadId, accountId, folder });
const ok = (items, accountId, key) => dropAllowed(items, { accountId, key }, moveKeys);

// ---- dropAllowed (REQ-4.7.2)
assert.equal(ok([item("t1")], "a1", "archive"), true, "a folder of the same mailbox");
assert.equal(ok([item("t1")], "a1", "f:Projects"), true, "a folder of the person");
assert.equal(ok([item("t1")], "a1", "f:Projects/Hey Look"), true, "a subfolder");
assert.equal(ok([item("t1"), item("t2"), item("t3")], "a1", "junk"), true, "several conversations of one mailbox");
assert.equal(ok([item("t1")], "a2", "archive"), false, "a folder of another mailbox");
assert.equal(ok([item("t1", "a1"), item("t2", "a2")], "a1", "archive"), false, "conversations of two mailboxes: no folder takes them");
assert.equal(ok([item("t1")], "a1", "inbox"), false, "the folder they are in");
assert.equal(ok([item("t1"), item("t2")], "a1", "inbox"), false, "all of them in it");
assert.equal(ok([item("t1", "a1", "inbox"), item("t2", "a1", "archive")], "a1", "inbox"), true, "one of them is elsewhere: the others are moved");
assert.equal(ok([item("t1")], "a1", "drafts"), false, "Drafts is not a choice of Move to");
assert.equal(ok([item("t1")], "a1", "sent"), false, "Sent is not a choice of Move to");
assert.equal(ok([item("t1")], "a2", "junk"), false, "a mailbox without a Junk folder has none");
for (const virtual of ["unread", "starred", "pinned", "snoozed", "scheduled", "all"]) assert.equal(ok([item("t1")], "a1", virtual), false, `${virtual} is a view, not a folder`);
assert.equal(ok([item("t1")], null, "archive"), false, "a row of the favourites for all mailboxes, a heading");
assert.equal(ok([], "a1", "archive"), false, "nothing is dragged");

// ---- what a drop does (REQ-4.7.3): the buttons for Junk / Delete / Archive, else Move to
assert.deepEqual(dropAction("junk"), { action: "junk" });
assert.deepEqual(dropAction("trash"), { action: "trash" });
assert.deepEqual(dropAction("archive"), { action: "archive" });
assert.deepEqual(dropAction("inbox"), { action: "move", arg: "inbox" });
assert.deepEqual(dropAction("f:Projects"), { action: "move", arg: "f:Projects" });

// ---- which rows are dragged (REQ-4.7.1)
assert.deepEqual(dragIds("t2", new Set(["t1", "t2", "t3"])), ["t1", "t2", "t3"], "a checked row takes all checked rows");
assert.deepEqual(dragIds("t9", new Set(["t1", "t2"])), ["t9"], "a row that is not checked goes alone");
assert.deepEqual(dragIds("t9", new Set()), ["t9"]);
assert.equal(mayDragRow("inbox", "inbox"), true);
assert.equal(mayDragRow("all", "inbox"), true);
assert.equal(mayDragRow("drafts", "drafts"), false, "Drafts are edited");
assert.equal(mayDragRow("all", "drafts"), false, "a draft row of a cross-folder view");
assert.equal(mayDragRow("scheduled", "inbox"), false, "the Scheduled list");

// ---- the chip rules (REQ-4.7.4)
const chip = { kind: "file", name: "report.pdf", mime: "application/pdf", dataBase64: "AAAA", from: "compose-1", compose: "m1" };
assert.equal(fileDropOk(chip, "m2"), true, "another message");
assert.equal(fileDropOk(chip, "m1"), false, "its own message");
assert.equal(fileDropOk(chip, ""), false, "a message that cannot be told");

// ---- the token types: the kind and the token, readable while the pointer moves (REQ-4.7.5)
const t = "0f3c9d2e-1b7a-4c55-9e0a-5d6a7b8c9d0e";
assert.equal(tokenType(t), `application/x-heylook-tok-${t}`);
assert.equal(tokenIn([MAIL_DRAG, tokenType(t)], "mail"), t);
assert.equal(tokenIn([tokenType(t), MAIL_DRAG], "mail"), t, "the order does not matter");
assert.equal(tokenIn([FILE_DRAG, tokenType(t)], "file"), t);
assert.equal(tokenIn([FILE_DRAG, tokenType(t)], "mail"), null, "a chip is not a conversation");
assert.equal(tokenIn([MAIL_DRAG], "mail"), null, "no token");
assert.equal(tokenIn(["text/plain", "Files"], "mail"), null, "a file from outside, text: not ours");
assert.equal(tokenIn([MAIL_DRAG, "application/x-heylook-tok-"], "mail"), null, "an empty token");
assert.equal(tokenIn([MAIL_DRAG, "application/x-heylook-tok-../x"], "mail"), null, "a token is letters, digits and hyphens");

// ---- what the backend returns, read defensively
assert.equal(parsePayload(null), null);
assert.equal(parsePayload({ kind: "text", text: "x" }), null);
assert.equal(parsePayload({ kind: "mail", items: [] }), null);
assert.equal(parsePayload({ kind: "mail", items: [{ threadId: "", accountId: "a1" }] }), null);
assert.deepEqual(parsePayload({ kind: "mail", items: [{ threadId: "t1", accountId: "a1", folder: "inbox", extra: 1 }, 5], from: "reader-2", view: "starred" }), { kind: "mail", items: [{ threadId: "t1", accountId: "a1", folder: "inbox" }], from: "reader-2", view: "starred" });
assert.equal(parsePayload({ kind: "file", name: "", dataBase64: "AA" }), null);
assert.deepEqual(parsePayload({ kind: "file", name: "a.pdf", dataBase64: "AA", compose: "m1" }), { kind: "file", name: "a.pdf", mime: "application/octet-stream", dataBase64: "AA", from: "", compose: "m1" });

// ---- the wiring
{
  const list = read("src/components/MessageList.tsx");
  assert.ok(list.includes("onDragStart={mayDragRow(folder, it.t.folder) ? (e) => startRowDrag(e, it.t.threadId) : undefined}"), "a row is a source unless it is a draft or in the Scheduled list");
  assert.ok(list.includes('draggable={onDragStart && !inPreview ? true : undefined}'), "the Appearance preview rows are not draggable");
  const pane = read("src/components/FolderPane.tsx");
  const dm = read("src/dropMail.ts");
  assert.ok(pane.includes("dropAllowed(p.items, { accountId: acct, key }, moveKeys)") && dm.includes("dropAllowed(p.items, { accountId: acct, key }, moveKeys)") && dm.includes("dropAction(key)"), "the folders decide with the one function and do what the buttons do");
  assert.ok(pane.includes('import("../dropMail")') && pane.includes("const taken = takeDrag(token);"), "the drop is a chunk of its own, loaded on the first drop");
  assert.ok(dm.includes("await st.act(p.items.map((i) => i.threadId), action, arg, label, p.view);"), "the move is act(): the Undo toast of the main window");
  assert.ok(dm.includes('if (p.from.startsWith("reader-")) void api.popoutClose(p.from)'), "a reader window is closed once its conversation moved (REQ-R6)");
  assert.ok(pane.includes("moveChoices(folders, accountId, undefined)") && dm.includes("moveChoices(st.folders, accountId, undefined)"), "the choices of the Move to menu");
  const reader = read("src/popout/ReaderView.tsx");
  assert.ok(reader.includes("startMailDrag(e, [{ threadId: info.threadId, accountId: info.accountId, folder: info.folder }], info.view)"), "the subject of a reader window is a source");
  const compose = read("src/components/Compose.tsx");
  assert.ok(compose.includes("onDragStart={(e) => startFileDrag(e, a, recoveryId)}") && compose.includes("fileDropOk(p, recoveryId)"), "the chips are sources, the pane takes the chip of another message");
  assert.ok(compose.includes("void addFiles([new File([bytes], p.name, { type: p.mime })])"), "a chip is attached by the road of a file from the picker: the limit, the blocked types and the notice apply");
  assert.ok(!compose.includes("MAIL_DRAG") && !compose.includes('tokenIn(e.dataTransfer.types, "mail")'), "a conversation dropped on a message is not accepted (forward as attachment is an owner NO)");
  const wire = read("src/dragWire.ts");
  assert.ok(wire.includes("dt.setData(payload.kind === \"mail\" ? MAIL_DRAG : FILE_DRAG, token)") && wire.includes('dt.setData(tokenType(token), "1")'), "the drag data are the token types and nothing else");
  assert.ok(!/setData\(\s*["']text/.test(wire) && !wire.includes("text/plain") && !wire.includes("text/uri-list"), "no text flavour: dropped in another program it does nothing");
  // the three places of the four commands (the Rust test drag::tests::the_drag_commands_are_in_the_three_places also reads them)
  for (const c of ["drag_begin", "drag_peek", "drag_take", "drag_end"]) assert.ok(read("src/api.ts").includes(`"${c}"`), c);
}

console.log("ok - test-drag-drop");
