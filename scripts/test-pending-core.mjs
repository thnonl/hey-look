// The pending states of 1.0.7 (RULE-2 of spec-107-wp13e-feedback.md): a state that is shown only when the work takes `after` ms and, once shown, stays `min` ms, as pure functions with a fake clock:
//   src/statusHold.ts   the rule behind the "Opening message…" block (RpBody)
//   src/pendingCore.ts  the rule behind the sticky "working" toasts (the count of a big batch, a send, a save)
// Run: node --experimental-strip-types scripts/test-pending-core.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { holdState } from "../src/statusHold.ts";
import { startPending } from "../src/pendingCore.ts";

// 1. holdState
assert.deepEqual(holdState(0, false, 300, 1000), { show: false, since: 0, leftMs: 0 });
assert.deepEqual(holdState(0, true, 300, 1000), { show: true, since: 1000, leftMs: 0 });
assert.deepEqual(holdState(1000, true, 300, 1200), { show: true, since: 1000, leftMs: 0 });
assert.deepEqual(holdState(1000, false, 300, 1100), { show: true, since: 1000, leftMs: 200 }, "no longer wanted after 100 ms: held for the rest of its 300 ms");
assert.deepEqual(holdState(1000, false, 300, 1299), { show: true, since: 1000, leftMs: 1 });
assert.deepEqual(holdState(1000, false, 300, 1300), { show: false, since: 0, leftMs: 0 }, "after 300 ms it goes");
assert.deepEqual(holdState(0, true, 300, 5000), { show: true, since: 5000, leftMs: 0 }, "and a later one starts again");
assert.deepEqual(holdState(1000, false, 0, 1001), { show: false, since: 0, leftMs: 0 }, "the reader window has no minimum");

// 2. startPending with a clock we move by hand
function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    setTimeout(f, ms) { const id = next++; timers.set(id, { at: now + ms, f }); return id; },
    clearTimeout(id) { timers.delete(id); },
    now: () => now,
    advance(ms) {
      const to = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].f();
      }
      now = to;
    },
  };
}
const run = (steps) => {
  const c = clock();
  const log = [];
  const p = startPending(() => log.push(`show@${c.now()}`), () => log.push(`hide@${c.now()}`), c, 100, 300);
  steps(c, p);
  return { log, p };
};

// the work ends before 100 ms: it never shows
assert.deepEqual(run((c, p) => { c.advance(60); p.end(); c.advance(1000); }).log, []);
// it ends at 150 ms: shown at 100, kept until 400
assert.deepEqual(run((c, p) => { c.advance(150); p.end(); c.advance(1000); }).log, ["show@100", "hide@400"]);
// it ends at 1000 ms: shown at 100, gone at once
assert.deepEqual(run((c, p) => { c.advance(1000); p.end(); c.advance(10); }).log, ["show@100", "hide@1000"]);
// end twice: one hide; end before the timer: no show at all even if the clock goes on
{
  const { log, p } = run((c, p) => { c.advance(150); p.end(); p.end(); c.advance(1000); });
  assert.deepEqual(log, ["show@100", "hide@400"]);
  assert.equal(p.shown, false);
}
{
  const r = run((c, p) => { c.advance(100); });
  assert.equal(r.p.shown, true, "shown while the work goes on");
}

// 3. the wiring in the sources
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pt = read("src/pendingToast.ts");
assert.ok(/setStickyToast\(key, \{ text, kind: "info", busy: true, hideClose: true \}\)/.test(pt), "a sticky info toast with the spinner (RULE-3 d)");
assert.ok(/after = 100, min = 300/.test(pt), "100 ms / 300 ms");
console.log("test-pending-core: ok");
