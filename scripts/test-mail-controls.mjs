// Checks the "no account" rules of src/mailControls.ts. Run: node --experimental-strip-types scripts/test-mail-controls.mjs
import assert from "node:assert/strict";
import { NO_ACCOUNT_COMMANDS, commandsFor, hasMailAccounts, shortcutWorks } from "../src/mailControls.ts";

assert.equal(hasMailAccounts(0), false);
assert.equal(hasMailAccounts(1), true);
assert.equal(hasMailAccounts(3), true);

// shortcuts: with no account only the window control and the (reduced) command bar work
for (const s of ["sync", "mail-keys"]) {
  assert.equal(shortcutWorks(0, s), false, `${s} must not work without an account`);
  assert.equal(shortcutWorks(1, s), true, `${s} must work with an account`);
}
for (const s of ["fullscreen", "command-bar"]) {
  assert.equal(shortcutWorks(0, s), true);
  assert.equal(shortcutWorks(1, s), true);
}

// command bar
const all = ["Add account", "New mail", "Sync now", "New event", "Go to Calendar", "Open settings", "Check for updates", "Theme: dark", "Toggle Focused Inbox", "Switch to a@b.c", "Go to Inbox"].map((label) => ({ label }));
assert.equal(commandsFor(2, all).length, all.length - 1, "with an account only `Add account` is dropped");
assert.ok(!commandsFor(2, all).some((c) => c.label === "Add account"));
const bare = commandsFor(0, all).map((c) => c.label);
assert.deepEqual(bare, ["Add account", "Open settings", "Check for updates", "Theme: dark"]);
assert.deepEqual(NO_ACCOUNT_COMMANDS, ["Add account", "Open settings", "Check for updates", "Theme: light", "Theme: dark", "Theme: system"], "exactly the 6, in this order");
for (const l of bare) assert.ok(NO_ACCOUNT_COMMANDS.includes(l));
for (const bad of ["New mail", "Sync now", "New event", "Go to Calendar", "Go to Inbox"]) assert.ok(!bare.includes(bad), bad);

// the command ids that exist in CommandBar.tsx (its labels are translated): every kept name is really there, no mail command is kept
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/components/CommandBar.tsx", import.meta.url), "utf8");
for (const l of NO_ACCOUNT_COMMANDS) assert.ok(src.includes(`id: "${l}"`), `${l} is a command of the bar`); // the bar matches by id (the English name), its label follows the language
console.log("mail-controls: all checks passed");
