#!/usr/bin/env node
// 1.0.10: the rule of the senders whose remote content always loads (src/trustedRule.ts), without a browser.
//   T-U1  the normal form of an address (case, spaces, NFC, +tag, one @, 320 characters)
//   T-U2  the effective rule: global x trusted x Junk x encrypted x sender check x "Load content" -> allowed, and the state of the notice (spec §5, S0..S7)
//   T-U3  the offer: never for an own address, Junk, encrypted, failed check, or an address the list cannot take
//   node --experimental-strip-types scripts/test-trusted-rule.mjs
import assert from 'node:assert/strict';
import { autoOk, canOffer, MAX_TRUSTED, noticeState, normSender, remoteAllowed } from '../src/trustedRule.ts';

// ---- T-U1
assert.equal(normSender('  A@Example.COM '), 'a@example.com');
assert.equal(normSender('Ann+News@Shop.Example'), 'ann+news@shop.example', '+tag is part of the address');
assert.equal(normSender('é@x.org'), 'é@x.org', 'Unicode normal form C');
assert.equal(normSender(''), null);
assert.equal(normSender('   '), null);
assert.equal(normSender(null), null);
assert.equal(normSender(undefined), null);
assert.equal(normSender('no-at'), null);
assert.equal(normSender('a@b@c'), null, 'two @');
assert.equal(normSender('@x.org'), null);
assert.equal(normSender('a@'), null);
assert.equal(normSender('a b@x.org'), null, 'a space inside');
assert.equal(normSender('a\u0000b@x.org'), null, 'a control character');
assert.equal(normSender(`${'a'.repeat(310)}@x.org`), `${'a'.repeat(310)}@x.org`, '318 characters');
assert.ok(normSender(`${'a'.repeat(314)}@x.org`), 'exactly 320');
assert.equal(normSender(`${'a'.repeat(315)}@x.org`), null, '321 characters');
assert.equal(MAX_TRUSTED, 1000);

// ---- T-U2: every combination
const rows = [];
for (const global of [false, true]) for (const trusted of [false, true]) for (const folder of ['inbox', 'junk']) for (const encrypted of [false, true]) for (const auth of ['pass', 'fail', null]) for (const allow of [false, true]) {
  const i = { global, trusted, folder, encrypted, auth, allow };
  const held = folder === 'junk' || encrypted || auth === 'fail';
  const wantAuto = trusted && !held;
  assert.equal(autoOk(i), wantAuto, `autoOk ${JSON.stringify(i)}`);
  assert.equal(remoteAllowed(i), global || wantAuto || allow, `allowed ${JSON.stringify(i)}`);
  for (const hasRemote of [false, true]) for (const offer of [false, true]) {
    const s = noticeState(i, hasRemote, offer);
    let want;
    if (global || !hasRemote) want = 'none'; // S7 / S0
    else if (wantAuto) want = 'auto'; // S4
    else if (allow) want = 'none'; // S3: "Load content" for this message
    else if (trusted) want = auth === 'fail' ? 'heldFailed' : 'held'; // S6 / S5
    else want = offer ? 'offer' : 'plain'; // S1 / S2
    assert.equal(s, want, `state ${JSON.stringify(i)} hasRemote=${hasRemote} offer=${offer}`);
    rows.push(s);
  }
}
assert.deepEqual([...new Set(rows)].sort(), ['auto', 'held', 'heldFailed', 'none', 'offer', 'plain']);
// a few of the rows spelled out (spec §5)
const base = { global: false, trusted: false, folder: 'inbox', encrypted: false, auth: null, allow: false };
assert.equal(noticeState(base, true, true), 'offer', 'S1');
assert.equal(noticeState({ ...base, trusted: true }, true, true), 'auto', 'S4');
assert.equal(noticeState({ ...base, trusted: true, folder: 'junk' }, true, true), 'held', 'S5: Junk');
assert.equal(noticeState({ ...base, trusted: true, encrypted: true }, true, true), 'held', 'S5: encrypted');
assert.equal(noticeState({ ...base, trusted: true, auth: 'fail' }, true, true), 'heldFailed', 'S6');
assert.equal(noticeState({ ...base, trusted: true, auth: 'pass' }, true, true), 'auto', 'a passed check loads');
assert.equal(noticeState({ ...base, trusted: true, auth: null }, true, true), 'auto', 'no check result loads (spec D3)');
assert.equal(noticeState({ ...base, trusted: true, global: true }, true, true), 'none', 'S7');
assert.equal(noticeState({ ...base, trusted: true }, false, true), 'none', 'S0: nothing remote in the message');

// ---- T-U3
const own = ['nam@example.com', 'Nam@Gmail.com'];
const inbox = { folder: 'inbox', encrypted: false, auth: null };
assert.equal(canOffer('news@shop.example', own, inbox), true);
assert.equal(canOffer('NAM@example.com', own, inbox), false, 'an own address, any case');
assert.equal(canOffer(' nam@gmail.com ', own, inbox), false, 'an own address, spaces');
assert.equal(canOffer('news@shop.example', own, { ...inbox, folder: 'junk' }), false, 'Junk');
assert.equal(canOffer('news@shop.example', own, { ...inbox, encrypted: true }), false, 'encrypted');
assert.equal(canOffer('news@shop.example', own, { ...inbox, auth: 'fail' }), false, 'failed check');
assert.equal(canOffer('news@shop.example', own, { ...inbox, auth: 'pass' }), true, 'passed check');
assert.equal(canOffer('undisclosed-recipients', own, inbox), false, 'not an address');
assert.equal(canOffer('', own, inbox), false);
assert.equal(canOffer(null, own, inbox), false);
assert.equal(canOffer(`${'a'.repeat(330)}@x.org`, own, inbox), false, 'too long');

console.log('test-trusted-rule: ok');
