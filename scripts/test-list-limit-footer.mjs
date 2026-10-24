// F-13: "Download limit reached (500 mails per mailbox) ..." appeared under a 4-mail Unread list. The cap is about how much mail of the
// mailbox was downloaded; a filtered list (Unread / Flagged filter, or the Unread view) is a handful of matches, so there the plain
// end-of-list line is shown. Unfiltered folders at the cap keep the notice. Source check of src/components/MessageList.tsx.
// Run: node --experimental-strip-types scripts/test-list-limit-footer.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/MessageList.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// A list is "filtered" under a Filter menu choice or in the Unread view.
assert.match(src, /const filtered = filter !== "all" \|\| folder === "unread";/, "filtered = Filter menu active or the Unread view");
// The cap's notice needs an unfiltered list; reachedEnd (the plain line) is the fallback and is not tied to it.
assert.match(src, /const capped = reachedEnd && !filtered && targets\.some\(\(id\) => limited\[exhaustedKey\(id, folder\)\]\);/, "capped (the cap's notice) is off for a filtered list");
assert.match(src, /const reachedEnd = targets\.length > 0 && targets\.every\(\(id\) => exhausted\[exhaustedKey\(id, folder\)\] \|\| limited\[exhaustedKey\(id, folder\)\]\);/, "the end-of-list line still covers a mailbox stopped by the cap");
// The footer chooses: notice (capped) before the end line (reachedEnd) - so a filtered capped list ends with the end line.
const status = src.slice(src.indexOf("const pagingStatus"), src.indexOf("const renderItem"));
assert.ok(status.indexOf("capped ?") > 0 && status.indexOf("capped ?") < status.indexOf("reachedEnd ?"), "pagingStatus: notice first, then the end line");
assert.match(status, /mail\.list\.limitReached/);
assert.match(status, /mail\.list\.reachedEnd/);
// One definition of "filtered" (the row prefetch used to spell it out on its own).
assert.match(src, /prefetch=\{!filtered\}/);
assert.ok(!/filter === "all" && folder !== "unread"/.test(src), "no second spelling of the rule");
// The "Downloading mails N / M" line is a running download, not the cap: it does not depend on the filter.
assert.match(src, /const download = downloadLine\(backfill, \{ inboxish, searching, accountId, accountIds: accounts\.map\(\(a\) => a\.id\) \}\);/);
// W6.3: the notice follows every prune (a sync, a push, the limit lowered): the backend says so (`mail-pruned`), the store marks every folder of that mailbox, a sync keeps what it was told
{
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(app.includes('listen<{ accountId: string; removed: number }>("mail-pruned", (e) => useStore.getState().onPruned(e.payload.accountId))'), "App.tsx listens to mail-pruned");
  assert.ok(store.includes("onPruned: (accountId) => {") && store.includes("limitedKeys(accountId, get().folders)"), "the store marks the folders of the mailbox");
  assert.ok(store.includes("limited: Object.fromEntries([...prunedDuringSync]"), "a sync keeps the marks it was told about");
  assert.ok(store.includes("api.pruneToLimit(keep ? [keep] : [])") && store.includes("patch.maxDownload < get().prefs.maxDownload"), "only a LOWER limit asks for a prune, with the open conversation");
  // an unfiltered list only: the footer rule above is unchanged
  assert.match(src, /const capped = reachedEnd && !filtered/);
}
console.log("list-limit-footer: all checks passed");
