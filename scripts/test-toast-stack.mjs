// Toasts that stay until answered, and error toasts, are limited to 3 rows per kind (the older ones fold into one "N more" row and come
// back when a shown one goes); an identical error text does not stack. Normal toasts are never hidden. Behaviour of src/toastStack.ts.
// Run: node --experimental-strip-types scripts/test-toast-stack.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addToast, clearableOfKind, isPersistent, lazyText, MAX_PERSISTENT, MAX_TIMED, stackItems, trimToasts } from "../src/toastStack.ts";
import { loadAllLanguages, setLangPref, t } from "../src/i18n/index.ts";

await loadAllLanguages(); // (the languages are chunks of their own: setLangPref needs them loaded)

let id = 0;
const toast = (kind, extra = {}) => ({ id: ++id, text: `t${id}`, kind, ...extra });
const rows = (items) => items.map((i) => ("toast" in i ? i.toast.id : `more:${i.more}:${i.hidden.map((h) => h.id).join(",")}`));

assert.equal(MAX_PERSISTENT, 3);

// 1. up to 3 persistent toasts of a kind are all shown, in order
{
  const ts = [toast("error", { sticky: true }), toast("error", { sticky: true }), toast("error", { sticky: true })];
  assert.deepEqual(rows(stackItems(ts)), ts.map((t) => t.id));
}

// 2. six failed translations (sticky errors): the newest 2 and one "4 more" row = 3 rows, the "more" row where the oldest hidden one was
{
  const ts = Array.from({ length: 6 }, () => toast("error", { sticky: true }));
  const items = stackItems(ts);
  assert.equal(items.length, 3);
  assert.deepEqual(rows(items), [`more:error:${ts.slice(0, 4).map((t) => t.id).join(",")}`, ts[4].id, ts[5].id]);
}

// 3. nothing is lost: when a shown toast goes, an older one is shown again
{
  const ts = Array.from({ length: 5 }, () => toast("error", { sticky: true }));
  assert.equal(stackItems(ts).length, 3);
  const four = stackItems(ts.filter((t) => t !== ts[4]));
  assert.equal(four.length, 3);
  assert.equal(four.filter((i) => "more" in i)[0].hidden.length, 2, "4 left: 2 shown + a row for 2");
  const three = stackItems(ts.slice(0, 3));
  assert.deepEqual(rows(three), ts.slice(0, 3).map((t) => t.id), "3 left: all shown again, no fold");
}

// 4. kinds are counted apart; normal toasts (timed, with Undo) are never hidden or folded
{
  const errs = Array.from({ length: 4 }, () => toast("error", { sticky: true }));
  const info = [toast("info", { sticky: true }), toast("info", { sticky: true })];
  const normal = [toast("success", { ttl: 4500 }), toast("success", { ttl: 4500, undo: () => {} }), toast("info", { ttl: 4500 })];
  const all = [errs[0], normal[0], errs[1], info[0], errs[2], normal[1], errs[3], info[1], normal[2]];
  const ids = rows(stackItems(all));
  for (const n of normal) assert.ok(ids.includes(n.id), "a normal toast stays");
  for (const n of info) assert.ok(ids.includes(n.id), "2 info toasts are within the limit");
  assert.equal(ids.filter((x) => typeof x === "string").length, 1, "one fold for the errors");
  assert.equal(ids.filter((x) => typeof x === "number" && errs.some((e) => e.id === x)).length, 2);
}

// 5. a toast with Undo is not persistent even when it is an error; a timed error is
{
  assert.equal(isPersistent(toast("error", { undo: () => {} })), false);
  assert.equal(isPersistent(toast("error")), true);
  assert.equal(isPersistent(toast("success", { ttl: 4500 })), false);
  assert.equal(isPersistent(toast("info", { sticky: true })), true);
}

// 6. a plain error toast with the text of an earlier one replaces it; other kinds, other texts, sticky ones and Undo ones do not
{
  const a = toast("error", { text: "Failed: X" });
  const b = toast("error", { text: "Failed: Y" });
  const c = toast("error", { text: "Failed: X" });
  const out = addToast([a, b], c);
  assert.deepEqual(out.map((t) => t.id), [b.id, c.id], "the older identical one is replaced, the new one is newest");
  const info = toast("info", { text: "Failed: X" });
  assert.equal(addToast([a], info).length, 2, "another kind");
  const s1 = toast("error", { text: "Translation failed", sticky: true, key: "k1" });
  const s2 = toast("error", { text: "Translation failed", sticky: true, key: "k2" });
  assert.equal(addToast([s1], s2).length, 2, "two jobs keep their own toast (and Retry)");
  const u = toast("error", { text: "Failed: X", undo: () => {} });
  assert.equal(addToast([a], u).length, 2);
}

// 6b. "Dismiss all" of the "N more" row: every persistent toast of that kind (shown and folded), nothing of another kind, no timed toast
{
  const errs = Array.from({ length: 5 }, () => toast("error", { sticky: true }));
  const timedErr = toast("error"); // a timed error is persistent too (it only is an error)
  const undoErr = toast("error", { undo: () => {} });
  const info = toast("info", { sticky: true });
  const ok = toast("success", { ttl: 4500 });
  const all = [...errs, undoErr, info, ok, timedErr];
  const gone = clearableOfKind(all, "error").map((t) => t.id);
  assert.deepEqual(gone, [...errs, timedErr].map((t) => t.id), "the shown rows and the folded ones");
  assert.ok(!gone.includes(undoErr.id) && !gone.includes(info.id) && !gone.includes(ok.id));
  // after clearing them the row is gone and the rest is untouched
  const left = all.filter((t) => !gone.includes(t.id));
  assert.deepEqual(rows(stackItems(left)), [undoErr.id, info.id, ok.id]);
  assert.equal(stackItems(left).some((i) => "more" in i), false);
  assert.equal(readFileSync(new URL("../src/components/overlays.tsx", import.meta.url), "utf8").includes("clearableOfKind(useStore.getState().toasts, item.more)"), true, "the row uses it");
}

// 7. a toast made from a translation key follows the language: the function gives the text of the language in use each time it is drawn
{
  const ready = () => t("reading.translate.ready", { subject: "Q4 plan" });
  const retry = () => t("common.retry");
  setLangPref("en");
  const en = lazyText(ready);
  assert.match(en, /Q4 plan/);
  setLangPref("de");
  const de = lazyText(ready);
  assert.notEqual(de, en, "the same toast, drawn again after the switch, is German");
  assert.match(de, /Q4 plan/);
  assert.notEqual(lazyText(retry), "Retry");
  setLangPref("ja");
  assert.notEqual(lazyText(ready), de);
  setLangPref("en");
  assert.equal(lazyText(retry), "Retry");
  // a plain string (every other toast) stays as it is
  assert.equal(lazyText("Saved"), "Saved");
}

// 8. trimToasts (W1.9, 1.0.7): the limit of the state is for timed toasts only; a sticky toast (a running translation ...) is never removed to make room
{
  const ids = (l) => l.map((t) => t.id);
  assert.equal(MAX_TIMED, 5);
  // 7 sticky + 3 timed: nothing to remove (3 timed are within the limit), every sticky toast is kept
  const sticky = Array.from({ length: 7 }, () => toast("info", { sticky: true }));
  const timed = Array.from({ length: 3 }, () => toast("success", { ttl: 4500 }));
  assert.deepEqual(ids(trimToasts([...sticky, ...timed])), ids([...sticky, ...timed]));
  // 7 sticky + 6 timed: the oldest timed one goes, all 7 sticky stay
  const six = Array.from({ length: 6 }, () => toast("success", { ttl: 4500 }));
  const out = trimToasts([...sticky.slice(0, 3), ...six, ...sticky.slice(3)]);
  assert.equal(out.filter((t) => t.sticky).length, 7, "no sticky toast is removed");
  assert.deepEqual(ids(out.filter((t) => !t.sticky)), ids(six.slice(1)), "the oldest timed toast goes");
  assert.deepEqual(ids(out), ids([...sticky.slice(0, 3), ...six.slice(1), ...sticky.slice(3)]), "the order is kept");
  // 8 timed: the 5 newest
  const eight = Array.from({ length: 8 }, () => toast("success", { ttl: 4500 }));
  assert.deepEqual(ids(trimToasts(eight)), ids(eight.slice(3)));
  // Undo toasts are kept before plain ones: 3 with Undo (oldest) and 4 plain -> the 3 oldest plain ones go
  const undos = Array.from({ length: 3 }, () => toast("success", { ttl: 8000, undo: () => {} }));
  const plain = Array.from({ length: 4 }, () => toast("info", { ttl: 4500 }));
  assert.deepEqual(ids(trimToasts([...undos, ...plain])), ids([...undos, plain[2], plain[3]]), "plain toasts go before Undo toasts");
  // only Undo toasts over the limit: the oldest Undo goes (last resort)
  const six2 = Array.from({ length: 6 }, () => toast("success", { ttl: 8000, undo: () => {} }));
  assert.deepEqual(ids(trimToasts(six2)), ids(six2.slice(1)));
  // a timed error is timed too
  const errs = Array.from({ length: 6 }, () => toast("error"));
  assert.deepEqual(ids(trimToasts(errs)), ids(errs.slice(1)));
  // within the limit: the same list, a copy
  const few = [toast("info"), toast("info", { sticky: true })];
  assert.deepEqual(trimToasts(few), few);
  assert.notEqual(trimToasts(few), few);
  // the AC of the row: 6 running translations (sticky) and 5 Undo toasts: all 11 stay
  const jobs = Array.from({ length: 6 }, () => toast("info", { sticky: true }));
  let list = [...jobs];
  const deletes = [];
  for (let i = 0; i < 5; i++) { const u = toast("success", { ttl: 8000, undo: () => {} }); deletes.push(u); list = trimToasts(addToast(list, u)); }
  assert.deepEqual(ids(list), ids([...jobs, ...deletes]), "6 running translations + 5 Undo toasts: every Undo toast and every job toast is there");
  // the stack still folds the jobs: 3 rows per kind at most, "N more" for the rest
  assert.equal(stackItems(list).filter((i) => "more" in i).length, 1);
}

// 9. the store trims through trimToasts and does not cut the sticky ones
{
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.match(store, /toasts: trimToasts\(addToast\(s\.toasts\.map\(refreshed\)/, "showToast trims through trimToasts");
  assert.ok(!/slice\(-5\)/.test(store), "no hard cut to 5 toasts left in the store");
}

// 10. W13.1: the Undo toast of a send stays exactly the Undo send time (the message is held that long); the toast of another Undo (delete, archive) keeps the
// undoActionSeconds rule. A toast made with a time stays that long, and a toast with Undo made without one keeps the old rule.
{
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../src/components/Compose.tsx", import.meta.url), "utf8");
  assert.ok(store.includes("const ttl = ttlMs ?? (undo ? Math.max(5000, get().prefs.undoActionSeconds * 1000)"), "an explicit time wins; Undo without one keeps the undoActionSeconds rule");
  assert.ok(store.includes("setTimeout(() => get().dismissToast(id), ttl)"), "and the toast goes when that time is over");
  const sendToast = compose.match(/showToast\(\(\) => t\("compose\.toast\.sending"\), undoSend, "info", undefined, ([^)]*)\)/);
  assert.ok(sendToast && sendToast[1] === "wait * 1000", "the send's Undo toast lasts the Undo time `wait`, which is also the time the message is held");
  assert.ok(compose.includes("heldId = await api.outboxHold(d, Math.floor(Date.now() / 1000) + wait, replacesRef());"), "...and `wait` is the hold time");
}

console.log("ok - test-toast-stack");
