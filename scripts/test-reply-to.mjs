#!/usr/bin/env node
// The own Reply-To of a mailbox (1.0.7 W2.21): what the Settings field accepts (src/replyTo.ts) and that the pieces are wired: the command takes it,
// the settings row saves it, the header is written (the header itself is tested in Rust: smtp.rs a_mailbox_reply_to_is_written_unless_it_is_the_from_address).
//   node --experimental-strip-types scripts/test-reply-to.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplyTo } from '../src/replyTo.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

// empty clears it; one bare address is saved as typed (trimmed)
assert.equal(parseReplyTo(''), '');
assert.equal(parseReplyTo('   '), '');
assert.equal(parseReplyTo(' team@x.test '), 'team@x.test');
assert.equal(parseReplyTo('Team@X.test'), 'Team@X.test');
assert.equal(parseReplyTo('<team@x.test>'), 'team@x.test', 'angle brackets alone are no name');
assert.equal(parseReplyTo('support+billing@mail.x-corp.example'), 'support+billing@mail.x-corp.example');
// a name part, a list, words or half an address are refused
for (const bad of ['not an address', 'Team <team@x.test>', '"Team" <team@x.test>', 'a@x.test, b@x.test', 'a@x.test; b@x.test', 'a@x.test b@x.test', 'team', '@x.test', 'team@', 'team@x', 'team (the team) @x.test']) {
  assert.equal(parseReplyTo(bad), null, bad);
}
// a one-label host counts only when a mailbox of the person is on it (as in the recipient fields)
assert.equal(parseReplyTo('qa@localhost'), 'qa@localhost');
assert.equal(parseReplyTo('qa@intranet'), null);
assert.equal(parseReplyTo('qa@intranet', ['intranet']), 'qa@intranet');

// wiring
const rust = read('src-tauri/src/lib.rs');
assert.match(rust, /fn update_account\([^)]*reply_to: Option<String>/, 'update_account takes the Reply-To (None leaves it)');
assert.match(rust, /smtp::check_reply_to/, 'update_account checks it before it writes');
const smtp = read('src-tauri/src/smtp.rs');
assert.equal((smtp.match(/reply_to_of\(acc\)/g) ?? []).length, 2, 'the header is written by the message builder and by the meeting reply builder');
assert.match(read('src-tauri/src/db.rs'), /ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''/, 'the column is added by the migration');
assert.match(read('src/api.ts'), /updateAccount: \(accountId: string, displayName: string, color: string \| null, replyTo\?: string\)/);
const panel = read('src/components/SettingsDialog.tsx');
assert.match(panel, /parseReplyTo\(text, singleLabelHostsOf\(accounts\)\)/, 'the row checks the text before saving');
assert.match(panel, /settings\.profile\.replyToHint/);
// the "All accounts" page has no Profile section, so no Reply-To row there
assert.match(panel, /\.\.\.\(scope \? \(\[\["profile", "settings\.section\.profile"\]\]/);
assert.match(panel, /active === "profile" && account && <ProfilePanel/);
console.log('test-reply-to: ok');
