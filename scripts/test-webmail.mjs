// "Search in Gmail" (W8.9): the app's folders as Gmail terms, and the exact shape of the link. Behaviour of src/webmail.ts (the dev preview's `__webmailCheck()` runs a longer
// list of the same functions). The Archive of a Gmail mailbox is "All Mail" - Inbox mail in it, Spam and Trash out - which is what a plain Gmail search covers, so Archive and "all"
// add no folder term (not `in:anywhere`, which would reach Spam and Trash too, and not `-in:inbox`). The link carries the account address (authuser) and the search text
// (fragment) and nothing else.
// Run: node --experimental-strip-types scripts/test-webmail.mjs
import assert from "node:assert/strict";
import { gmailSearchUrl, toGmailQuery } from "../src/webmail.ts";

const eq = (q, want, folder) => assert.equal(toGmailQuery(q, folder), want, `${JSON.stringify(q)}${folder ? ` in ${folder}` : ""}`);

// the two changed cases: Archive and "all" name no folder
eq("in:archive x", "x");
eq("folder:archive x", "x");
eq("IN:ARCHIVE x", "x", "inbox"); // (a folder named in the query beats the open folder; the term is empty, so the open folder is not added either)
eq("folder:all x", "x");
eq("in:all invoice", "invoice");
// the open folder: Archive and the "all" view add nothing, a search from the Inbox keeps `in:inbox`
eq("invoice", "invoice", "archive");
eq("invoice", "invoice", "all");
eq("invoice", "invoice in:inbox", "inbox");
eq("invoice", "invoice in:inbox", "unread");
// the other folders are unchanged
eq("x", "x in:sent", "sent");
eq("in:sent x", "in:sent x");
eq("in:drafts x", "in:drafts x");
eq("in:trash x", "in:trash x");
eq("in:bin x", "in:trash x");
eq("in:deleted x", "in:trash x");
eq("in:spam x", "in:spam x");
eq("in:junk x", "in:spam x");
eq("in:inbox x", "in:inbox x");
eq("x", "x in:spam", "junk");
eq("x", "x in:trash", "trash");
eq("x", "x in:drafts", "drafts");
eq("folder:Projects/Hey x", "label:Projects/Hey x");
eq("x", "x label:Projects/Hey-Look", "f:Projects/Hey Look");
eq("x", "x is:starred", "starred");
// a search with no words does not get a folder alone
eq("", "", "inbox");
eq("is:pinned", "", "inbox");
// the operators the app has
eq("from:linh subject:roadmap review", "from:linh subject:roadmap review");
eq("since:7d until:30d", "newer_than:7d older_than:30d");
eq("after:2026-01-31 before:2026-02-15", "after:2026/01/31 before:2026/02/15");

// the link: exactly authuser (the address) and the search in the fragment, encoded; no other parameter
const url = (email, q) => gmailSearchUrl(email, q);
assert.equal(url("nam@gmail.com", "invoice"), "https://mail.google.com/mail/?authuser=nam%40gmail.com#search/invoice");
assert.equal(url("nam@gmail.com", "invoice in:inbox"), "https://mail.google.com/mail/?authuser=nam%40gmail.com#search/invoice%20in%3Ainbox");
assert.equal(url("a+b@gmail.com", "x y"), "https://mail.google.com/mail/?authuser=a%2Bb%40gmail.com#search/x%20y", "a + in the address is %2B");
assert.equal(url("nam@gmail.com", 'from:"Linh Tran" subject:"q4 plan"'), "https://mail.google.com/mail/?authuser=nam%40gmail.com#search/from%3A%22Linh%20Tran%22%20subject%3A%22q4%20plan%22", "quotes and colons");
assert.equal(url("nam@gmail.com", "hóa đơn 請求書"), "https://mail.google.com/mail/?authuser=nam%40gmail.com#search/h%C3%B3a%20%C4%91%C6%A1n%20%E8%AB%8B%E6%B1%82%E6%9B%B8", "non-ASCII is UTF-8 percent-encoded");
for (const u of [url("nam@gmail.com", "a b"), url("a+b@gmail.com", "x&y=1?z#w")]) {
  const parsed = new URL(u);
  assert.equal(parsed.origin + parsed.pathname, "https://mail.google.com/mail/");
  assert.deepEqual([...parsed.searchParams.keys()], ["authuser"], "the only parameter is authuser");
  assert.ok(parsed.hash.startsWith("#search/"), "the search text is in the fragment");
  assert.ok(!u.slice(u.indexOf("#") + 1).includes("#") && !u.slice(0, u.indexOf("#")).includes("x&y"), "a & ? # in the search cannot become a parameter");
}
console.log("ok - test-webmail");
