// New mail never ends silently (W1.3, 1.0.7): the kept request of src/newMailQueue.ts with a fake clock, and the wiring of the entry points.
// Run: node --experimental-strip-types scripts/test-new-mail-queue.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NEW_MAIL_WAIT_MS, NewMailQueue } from "../src/newMailQueue.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A queue on a fake clock: `ready` is what the app can do now, `served` / `said` are what happened. */
function rig() {
  const r = { clock: 0, ready: "wait", served: [], said: [], timers: [] };
  const io = {
    ready: () => r.ready,
    serve: (o) => r.served.push(o),
    say: (s) => r.said.push(s),
    now: () => r.clock,
    later: (ms, f) => {
      const t = { at: r.clock + ms, f, live: true };
      r.timers.push(t);
      return () => (t.live = false);
    },
  };
  r.q = new NewMailQueue(io);
  /** the clock moves; the timers that fall due run */
  r.advance = (ms) => {
    const end = r.clock + ms;
    for (;;) {
      const next = r.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      r.clock = next.at;
      next.live = false;
      next.f();
    }
    r.clock = end;
  };
  return r;
}
const lastSaid = (r) => r.said[r.said.length - 1];

assert.equal(NEW_MAIL_WAIT_MS, 30_000);

// 1. the app can open one now: it opens at once, nothing is kept, nothing is said
{
  const r = rig();
  r.ready = "ready";
  r.q.request({ shift: false });
  assert.deepEqual(r.served, [{ shift: false }]);
  assert.equal(r.q.waiting, false);
  assert.ok(r.said.every((s) => s === null), "no message");
}

// 2. it cannot yet: the request is kept (one message "waiting"), and served once when the mailboxes are read
{
  const r = rig();
  r.q.request({ shift: false });
  assert.equal(r.served.length, 0);
  assert.equal(r.q.waiting, true);
  assert.equal(lastSaid(r), "waiting");
  r.advance(900);
  r.q.check(); // still reading
  assert.equal(r.served.length, 0);
  r.ready = "ready";
  r.q.check();
  assert.deepEqual(r.served, [{ shift: false }], "served once");
  assert.equal(r.q.waiting, false);
  assert.equal(lastSaid(r), null, "the waiting message goes");
  r.q.check();
  r.advance(60_000);
  assert.equal(r.served.length, 1, "not served again, and the 30 s timer does nothing");
  assert.equal(lastSaid(r), null);
}

// 3. three presses while it waits are one message (the options are those of the first)
{
  const r = rig();
  r.q.request({ shift: true });
  r.q.request({ shift: false });
  r.q.request({ shift: false });
  assert.equal(r.said.filter((s) => s === "waiting").length, 1, "one waiting message");
  r.ready = "ready";
  r.q.check();
  assert.deepEqual(r.served, [{ shift: true }]);
  r.q.check();
  assert.equal(r.served.length, 1);
}

// 3b. a press after the app became ready but before anyone called check() serves the kept request, not a second one
{
  const r = rig();
  r.q.request({ shift: false });
  r.ready = "ready";
  r.q.request({ shift: false });
  assert.equal(r.served.length, 1);
}

// 4. the mailboxes are read and there is none: the kept request is dropped without a message, nothing opens
{
  const r = rig();
  r.q.request({ shift: false });
  r.ready = "none";
  r.q.check();
  assert.equal(r.served.length, 0);
  assert.equal(r.q.waiting, false);
  assert.equal(lastSaid(r), null);
  r.advance(60_000);
  assert.equal(lastSaid(r), null, "no error message after the drop");
  // and a press when it is known that there is none is dropped at once
  r.q.request({ shift: false });
  assert.equal(r.q.waiting, false);
  assert.equal(r.served.length, 0);
}

// 5. 30 s without being served: "failed" replaces "waiting", the request is dropped; Retry is a new request
{
  const r = rig();
  r.q.request({ shift: false });
  r.advance(29_999);
  assert.equal(lastSaid(r), "waiting");
  assert.equal(r.q.waiting, true);
  r.advance(1);
  assert.equal(lastSaid(r), "failed", "after 30 s");
  assert.equal(r.q.waiting, false);
  assert.equal(r.served.length, 0);
  // the mailboxes arrive later: the dropped request is not served (the person has been told)
  r.ready = "ready";
  r.q.check();
  assert.equal(r.served.length, 0);
  // Retry
  assert.deepEqual(r.q.retryOptions(), { shift: false });
  r.q.request(r.q.retryOptions());
  assert.deepEqual(r.served, [{ shift: false }], "Retry opens one");
  assert.equal(lastSaid(r), null, "the error message goes");
}

// 5b. Retry while the mailboxes are still not read: a new wait with a new 30 s
{
  const r = rig();
  r.q.request({ shift: false });
  r.advance(30_000);
  assert.equal(lastSaid(r), "failed");
  r.q.request({ shift: false });
  assert.equal(lastSaid(r), "waiting");
  r.advance(29_000);
  assert.equal(lastSaid(r), "waiting");
  r.advance(1_000);
  assert.equal(lastSaid(r), "failed");
}

// 6. the timer fires in the instant the mailboxes arrive: served, not failed
{
  const r = rig();
  r.q.request({ shift: false });
  r.advance(29_000);
  r.ready = "ready";
  r.advance(1_000); // the timer runs before anyone called check()
  assert.deepEqual(r.served, [{ shift: false }]);
  assert.equal(lastSaid(r), null);
}

// 7. the wiring: every entry point asks the queue, nothing returns silently while the mailboxes are being read
const actions = read("src/actions.ts");
assert.match(actions, /new NewMailQueue/);
assert.match(actions, /ready: \(\) => \{[\s\S]*!s\.loaded \? "wait"/, "wait while the store has not read the mailboxes");
assert.match(actions, /export function newMail\(/);
assert.match(read("src/components/Ribbon.tsx"), /newMail\(\)/);
assert.match(read("src/components/CommandBar.tsx"), /run: \(\) => void newMail\(\)/);
const app = read("src/App.tsx");
assert.match(app, /listen\("tray-compose"[\s\S]{0,200}takeTrayCompose/, "the tray event asks the backend whether the request is still pending");
assert.match(app, /case "c": case "C": e\.preventDefault\(\); void newMail\(\)/);
assert.match(app, /!st\.loaded && \(e\.key === "c" \|\| e\.key === "C"\)/, "key c is kept while the mailboxes are being read");
assert.ok(!/hasMailAccounts\(st\.accounts\.length\)\) return; \/\/ no account: nothing to write with/.test(app), "the tray handler no longer returns silently");
const shell = read("src-tauri/src/shell.rs");
assert.match(shell, /TRAY_COMPOSE_PENDING\.store\(true/, "the tray menu marks the request before it emits the event");
const lib = read("src-tauri/src/lib.rs");
assert.match(lib, /fn take_tray_compose\(\) -> bool/);
assert.match(lib, /^\s+take_tray_compose,$/m, "registered as a command");
assert.match(read("src/api.ts"), /takeTrayCompose: \(\) => invoke<boolean>\("take_tray_compose"\)/);

console.log("new-mail-queue: all checks passed");
