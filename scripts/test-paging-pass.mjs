// 1.0.8: the end of a `loadMore` pass (src/pagingPass.ts) and the places in the store / list that must keep "Loading…" from staying.
// A list that shows part of the downloaded mail (Flagged / Unread filter, a tab, the Unread view) is short however much is downloaded: a pass that stored mail but
// gave the list no new line must stop the passes, or the footer says "Loading…" for as long as the mailbox has older mail.
// Run: node --experimental-strip-types scripts/test-paging-pass.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mayPageByItself, passVerdict, withDeadline } from "../src/pagingPass.ts";

const v = (added, done, rowsBefore, rowsAfter) => passVerdict({ added, done, rowsBefore, rowsAfter });

// nothing left to ask for: the footer says so, whatever happened to the list
assert.equal(v(0, true, 1, 1), "end");
assert.equal(v(120, true, 1, 1), "end");
assert.equal(v(120, true, 1, 9), "end");
// the list grew: the next pass may follow when its end is in view
assert.equal(v(200, false, 10, 14), "more");
assert.equal(v(50, false, 1, 2), "more");
// mail came, no new line (one flagged message of 3000): stalled, the footer's button is the way on
assert.equal(v(200, false, 1, 1), "stalled");
assert.equal(v(50, false, 5, 5), "stalled");
assert.equal(v(200, false, 5, 3), "stalled", "a list that got shorter (a message left the filter) did not grow either");
// the server said nothing is left but did not say it is done (the old rule: nothing came back)
assert.equal(v(0, false, 10, 10), "stalled");
// the list grew from something else (a sync) while nothing was stored: still nothing came of the passes
assert.equal(v(0, false, 10, 12), "stalled");

// ---- the end of a list asks by itself only where that makes sense (QA 1.0.8: the Unread view of six mailboxes, two rows, "Loading…" for 40 s and more)
const may = (partial, sortAsc, scrollTop, fits) => mayPageByItself({ partial, sortAsc, scrollTop, fits });
assert.equal(may(false, false, 0, true), false, "a whole folder that fits in the window (QA-1.0.8 with 2 mails): the button, no request");
assert.equal(may(false, false, 0, false), true, "a folder longer than the window asks as before");
assert.equal(may(true, false, 0, true), false, "a short filtered list: the button, no request");
assert.equal(may(true, true, 0, true), false, "oldest first: same");
assert.equal(may(true, false, 0, false), false, "a filtered list that can scroll but was not scrolled: not yet");
assert.equal(may(true, false, 120, false), true, "scrolled (newest first): it asks as the end comes near");
assert.equal(may(true, true, 0, false), true, "oldest first: older mail is at the top, a list that can scroll asks");

// ---- a request that never answers ends the wait
{
  const never = new Promise(() => {});
  await assert.rejects(withDeadline(never, 30), /timed out/);
  assert.equal(await withDeadline(Promise.resolve(7), 1000), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error("boom")), 1000), /boom/);
  const late = new Promise((r) => setTimeout(() => r("late"), 80));
  await assert.rejects(withDeadline(late, 20), /timed out/);
  await late; // the late answer is dropped, nothing is thrown
}

// ---- the store
const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const more = store.slice(store.indexOf("loadMore: async"), store.indexOf("onBackfill: (p)"));
assert.ok(more.includes("withDeadline(api.loadOlder(id, role, 50), LOAD_OLDER_DEADLINE_MS)"), "no request is waited for for ever");
assert.match(more, /const rowsBefore = get\(\)\.threads\.length;/, "the pass notes how many lines the list had");
assert.match(more, /passVerdict\(\{ added, done, rowsBefore, rowsAfter: get\(\)\.threads\.length \}\) === "stalled"\) set\(\{ moreError: true \}\)/, "a stalled pass stops the passes");
assert.match(more, /set\(\{ moreError: true, moreFail: \{ error: e, account: acct \} \}\)/, "a failure keeps its reason for the footer");
assert.match(more, /finally \{\s*if \(alive\(\)\) set\(\{ loadingMore: false \}\);/, "the flag goes down in a finally, whatever happened");
// a pass of another view ends when the view changes: the folder, the mailbox, the search ... and the filter and the tab
assert.match(store, /function cancelMore\(\) \{\s*moreRun\+\+;\s*useStore\.setState\(\{ loadingMore: false, moreError: false, moreFail: null \}\);/);
for (const name of ["setFocus", "setFilter", "setView", "setSearch", "setSearchScope"]) {
  const at = store.indexOf(`  ${name}: async`);
  assert.ok(at > 0 && /cancelMore\(\)/.test(store.slice(at, at + 400)), `${name} ends the running pass`);
}
// the list read that was overtaken does not end "Loading…" / the skeleton of the one that still runs
assert.match(store, /if \(listReads\.current\(run\)\) set\(\{ loading: false \}\);/);
// a sync (new mail, new state of the folder) lets the passes try again
assert.match(store, /exhausted: \{\}, limited: Object\.fromEntries\(\[\.\.\.prunedDuringSync\]\.map\(\(k\) => \[k, true as const\]\)\), moreError: false, moreFail: null/);

// ---- the list: the footer
const list = readFileSync(new URL("../src/components/MessageList.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const status = list.slice(list.indexOf("const pagingStatus"), list.indexOf("const renderItem"));
assert.ok(status.indexOf("loadingMore ?") >= 0 && status.indexOf("moreFail ?") > status.indexOf("loadingMore ?") && status.indexOf("moreFail ?") < status.indexOf("capped ?"), "pagingStatus: loading, then the failure, then the cap / end / button");
assert.match(status, /common\.retry/, "the failure has Retry");
assert.match(status, /onClick=\{\(\) => void loadMore\(true\)\}>\{tr\("common\.retry"\)/, "Retry asks again");
// the end of the list asks through the rule, and "partial" is a filter, a tab or the Unread view
assert.ok(list.includes("const partial = filtered || showTabs;"), "partial: a filter, a tab or the Unread view");
assert.ok(/fits: el\.scrollHeight <= el\.clientHeight \+ 1 \}\)\) return;\s+void loadMore\(\);/.test(list), "the end of the list asks through the rule");
// an empty filtered list is the empty state, never the paging footer: the footer needs a row
assert.match(list, /const pageable = canPageBack\(folder, searching\) && threads\.length > 0;/);

console.log("paging-pass: all checks passed");
