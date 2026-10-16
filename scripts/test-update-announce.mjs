// F-20: the "new version available" toast and its reasons. announceBlocker (src/updateRules.ts) decides whether an answer of a check
// is news for a toast and, when it is not, says why in a few words; the page writes that into startup.log after a startup check, so a Mac
// that shows no toast can be told apart: automatic checks off, no request made (throttled), a failed request, a skipped version.
// The decisions must be exactly the old ones (a toast only for a newer version that is not skipped, not announced yet, no download on its
// way, window in front, not a remembered offer), the same on every system. The source of updates.ts is checked for the wiring.
// Run: node --experimental-strip-types scripts/test-update-announce.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { announceBlocker, flowActive, isStaleOffer, pendingVersion, updateKindOf } from "../src/updateRules.ts";

const info = (latest) => ({ latest, notes: "", notesTruncated: false, publishedAt: 1, releaseUrl: "u", asset: null });
const platform = { os: "macos", arch: "arm64", installer: "app", label: "macOS" };
const res = (kind, extra = {}) => ({ kind, current: "1.0.3", platform, checkedAt: 1, message: null, info: null, fromCache: false, cachedKind: null, ...extra });
const block = (update, o = {}) => announceBlocker(update, o.toastFor ?? null, o.flow ?? "idle", o.skipped ?? "", o.focused ?? true);

// 1. a fresh answer "available": the toast appears
assert.equal(block(res("available", { info: info("1.0.4") })), null);
// 2. a throttled / stored answer that says available (a launch within the throttle after a check that found it): the toast appears too
assert.equal(block(res("throttled", { info: info("1.0.4"), cachedKind: "available", fromCache: true })), null);
// 3. the stored answer says up to date (the F-20 case on a Mac that asked a short while ago): no toast, and the reason says so
{
  const why = block(res("throttled", { info: info("1.0.3"), cachedKind: "upToDate", fromCache: true }));
  assert.match(why, /throttled, stored answer upToDate: no newer version known \(no request was made\)/);
}
// 4. throttled without any stored answer
assert.match(block(res("throttled")), /throttled: no newer version known \(no request was made\)/);
// 5. automatic checks off: a remembered offer is no news (REQ-18 r3.4); with nothing stored it says so
assert.match(block(res("disabled", { info: info("1.0.4"), cachedKind: "available", fromCache: true })), /automatic checks are off; 1\.0\.4 is only remembered/);
assert.match(block(res("disabled")), /disabled: no newer version known/);
// 6. the last check failed but the app knows the offer: a quiet note, no toast
assert.match(block(res("offline", { info: info("1.0.4"), cachedKind: "available", fromCache: true })), /the last check failed \(offline\); 1\.0\.4 is only remembered/);
assert.match(block(res("error", { message: "x", info: info("1.0.4"), cachedKind: "available", fromCache: true })), /the last check failed \(error\)/);
assert.match(block(res("error", { message: "x" })), /the answer is error: no newer version known/);
// 7. up to date, no release, nothing yet
assert.match(block(res("upToDate", { info: info("1.0.3") })), /the answer is upToDate/);
assert.match(block(res("noRelease")), /the answer is noRelease/);
assert.equal(block(null), "no answer from a check yet");
// 8. the other gates
assert.equal(block(res("available", { info: info("1.0.4") }), { skipped: "1.0.4" }), "version 1.0.4 was skipped by the user");
assert.equal(block(res("available", { info: info("1.0.4") }), { skipped: "1.0.3" }), null, "another version was skipped");
assert.equal(block(res("available", { info: info("1.0.4") }), { toastFor: "1.0.4" }), "already shown for 1.0.4 in this run");
assert.equal(block(res("available", { info: info("1.0.4") }), { toastFor: "1.0.3" }), null);
for (const flow of ["downloading", "verifying", "ready", "waiting", "installing", "deferred"]) assert.match(block(res("available", { info: info("1.0.4") }), { flow }), /an update is already on its way/);
for (const flow of ["idle", "failed"]) assert.equal(block(res("available", { info: info("1.0.4") }), { flow }), null);
assert.equal(block(res("available", { info: info("1.0.4") }), { focused: false }), "the window is not focused");

// 9. the blocker is exactly the old condition: a toast for (v && info && toastFor !== v && !flowActive && focused && !stale && kind !== disabled)
const kinds = ["available", "upToDate", "noRelease", "offline", "error", "disabled", "throttled"];
let checked = 0;
for (const kind of kinds)
  for (const withInfo of [false, true])
    for (const cachedKind of [null, "available", "upToDate"])
      for (const latest of ["1.0.3", "1.0.4"])
        for (const skipped of ["", "1.0.4"])
          for (const toastFor of [null, "1.0.4"])
            for (const flow of ["idle", "failed", "downloading"])
              for (const focused of [true, false]) {
                const r = res(kind, { info: withInfo ? info(latest) : null, cachedKind });
                const v = pendingVersion(r, skipped);
                const old = !(!v || !r.info || toastFor === v || flowActive({ state: flow }) || !focused || isStaleOffer(r) || r.kind === "disabled");
                assert.equal(block(r, { skipped, toastFor, flow, focused }) === null, old, JSON.stringify({ kind, withInfo, cachedKind, latest, skipped, toastFor, flow, focused }));
                checked++;
              }
assert.ok(checked > 1000);
assert.equal(updateKindOf(res("throttled", { info: info("1.0.4"), cachedKind: "available" })), "available");

// 10. wiring: updates.ts asks the rules, and a startup check always leaves a line (the other triggers only when a toast is shown)
const updates = readFileSync(new URL("../src/updates.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(updates, /from "\.\/updateRules"/);
assert.match(updates, /get\(\)\.announceUpdate\(trigger\);/, "the check passes its trigger");
const announce = updates.slice(updates.indexOf("announceUpdate: (from) => {"));
const body = announce.slice(0, announce.indexOf("\n    },\n"));
assert.match(body, /announceBlocker\(update, toastFor, flow\.state, st\.prefs\.skippedUpdate, windowFocused\(\)\)/);
assert.match(body, /if \(from === "startup"\) note\(`new-version toast: none after the startup check - /, "a startup check without a toast says why");
assert.match(body, /note\(`new-version toast: shown for /, "a toast that appears is logged");
assert.match(updates, /const note = \(text: string\) => void api\.updateNote\(text\)\.catch/, "the line goes to startup.log through update_note");
console.log(`ok (${checked} combinations)`);
