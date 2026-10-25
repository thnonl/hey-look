// The name of a folder as shown in the list header, the rule list, the search rows and the command bar (1.0.9: a folder "QA-1.0.8" was shown as "8", the label was cut at every dot).
// Pure: src/prefs.ts folderLabel / folderLabelIn. Run: node --experimental-strip-types scripts/test-folder-label.mjs
import assert from "node:assert/strict";
import { folderLabel, folderLabelIn } from "../src/folderLabel.ts";

let checks = 0;
const eq = (a, b, m) => (assert.equal(a, b, m), checks++);

// without a folder list (the fallback): only the slash cuts, a dot is part of the name
eq(folderLabel("f:QA-1.0.8"), "QA-1.0.8", "dots and dashes stay");
eq(folderLabel("f:Release v1.0"), "Release v1.0");
eq(folderLabel("f:2026.10"), "2026.10");
eq(folderLabel("f:Projects/2026"), "2026", "a subfolder of a slash server: its own part");
eq(folderLabel("f:Projects/Hey Look"), "Hey Look");
eq(folderLabel("f:INBOX.Clients"), "Clients", "the INBOX. namespace of a dot server is dropped");
eq(folderLabel("f:QA-1.0.8", "QA-1.0.8"), "QA-1.0.8", "with the server name");
eq(folderLabel("f:x", ""), "x", "an empty name falls back on the key");
eq(folderLabel("inbox"), "Inbox", "a standard folder by its role");

// with the folder list: the label the backend cut at the delimiter of that server
const folders = [
  { accountId: "a1", key: "f:QA-1.0.8", name: "QA-1.0.8", label: "QA-1.0.8" },
  { accountId: "a1", key: "f:INBOX.Clients.Acme", name: "INBOX.Clients.Acme", label: "Acme" }, // a dot server: the delimiter cuts here
  { accountId: "a2", key: "f:Projects/2026", name: "Projects/2026", label: "2026" },
  { accountId: "a2", key: "f:Plain", name: "Plain" }, // an older backend: no label
  { accountId: "a1", key: "f:Plain", name: "Plain" },
];
eq(folderLabelIn(folders, "f:QA-1.0.8", "a1"), "QA-1.0.8", "the header of a folder with dots");
eq(folderLabelIn(folders, "f:QA-1.0.8"), "QA-1.0.8", "no mailbox given (all mailboxes)");
eq(folderLabelIn(folders, "f:INBOX.Clients.Acme", "a1"), "Acme", "a dot server keeps its nested label");
eq(folderLabelIn(folders, "f:Projects/2026", "a2"), "2026");
eq(folderLabelIn(folders, "f:Plain", "a2"), "Plain", "no label: the fallback");
eq(folderLabelIn(folders, "f:Projects/2026", "a1"), "2026", "another mailbox has no such folder: the list entry of any mailbox, else the fallback");
eq(folderLabelIn(folders, "f:Gone.1.0", "a1"), "Gone.1.0", "a folder that is not in the list (a rule whose folder was removed)");
eq(folderLabelIn([], "f:QA-1.0.8"), "QA-1.0.8", "folders not loaded yet");
eq(folderLabelIn(folders, "archive", "a1"), "Archive", "a standard folder by its role");

console.log(`test-folder-label: ok (${checks} checks)`);
