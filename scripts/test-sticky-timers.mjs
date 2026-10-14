// QA BUG-14: the timer that takes a sticky toast away must belong to the toast it was armed for. Two `Restart now` attempts made two
// 30 s timers and the first one removed the second toast after 20 s. Behaviour of src/stickyTimers.ts with real (short) timers, and a
// source check that nothing in src arms a sticky toast's expiry with a bare setTimeout again.
// Run: node --experimental-strip-types scripts/test-sticky-timers.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stickyTimers, STICKY_MS } from "../src/stickyTimers.ts";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
assert.equal(STICKY_MS, 30_000);

// 1. Re-arming a key: the toast goes once, counted from the LAST arming (the first timer is gone).
{
  const removed = [];
  const t0 = Date.now();
  const timers = stickyTimers((key) => removed.push([key, Date.now() - t0]));
  timers.arm("a", 200);
  await wait(120);
  timers.arm("a", 200); // second attempt
  await wait(150); // t = 270: the first timer (200) would have fired by now
  assert.deepEqual(removed, [], "the first timer must not remove the newer toast");
  await wait(150); // t = 420: the second timer (120 + 200 = 320) has fired
  assert.equal(removed.length, 1, "removed exactly once");
  assert.equal(removed[0][0], "a");
  assert.ok(removed[0][1] >= 300, `removed at ${removed[0][1]} ms, expected about 320 (counted from the second arming)`);
}

// 2. Different keys do not touch each other; cancel stops a timer.
{
  const removed = [];
  const timers = stickyTimers((key) => removed.push(key));
  timers.arm("a", 60);
  timers.arm("b", 60);
  timers.cancel("a");
  await wait(150);
  assert.deepEqual(removed, ["b"]);
  timers.cancel("never-armed"); // harmless
}

// 3. The sticky toasts of updates.ts use it: no bare setTimeout that ends in setStickyToast(…, null), and a new attempt cancels the old timer.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
for (const f of walk(root).filter((f) => /\.tsx?$/.test(f) && !f.endsWith("stickyTimers.ts"))) {
  const text = readFileSync(f, "utf8");
  assert.ok(!/setTimeout\([^;\n]*setStickyToast\(/.test(text), `${f}: a sticky toast's expiry is armed with a bare setTimeout (use stickyTimers.arm)`);
}
const updates = read("src/updates.ts");
assert.match(updates, /stickyTimer\.arm\(RESTART_STOPPED\)/, "the restart-stopped toast is armed through the helper");
assert.match(updates, /stickyTimer\.arm\(key\)/, "the update result toast is armed through the helper");
assert.match(updates, /st\.setStickyToast\(RESTART_STOPPED, null\)[^\n]*\n\s*stickyTimer\.cancel\(RESTART_STOPPED\)/, "a new Restart now attempt cancels the old timer where it removes the old toast");
console.log("sticky-timers: all checks passed");
