// Toasts that stay until answered, and error toasts, are limited to 3 rows per kind (the older ones fold into one "N more" row and come
// back when a shown one goes); an identical error text does not stack. Normal toasts are never hidden. Behaviour of src/toastStack.ts.
// Run: node --experimental-strip-types scripts/test-toast-stack.mjs
import assert from "node:assert/strict";
import { addToast, isPersistent, MAX_PERSISTENT, stackItems } from "../src/toastStack.ts";

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

console.log("ok - test-toast-stack");
