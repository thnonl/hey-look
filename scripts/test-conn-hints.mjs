#!/usr/bin/env node
// 1.0.10 "Test connection" (Settings > Add account > iCloud, Yahoo, other): the rules that need no page (src/connHints.ts).
//   - when the button is enabled and which reason shows first (AC-2, AC-3), what is a host name and what is not (AC-4)
//   - the hints before a test, their one-click fixes (AC-13, AC-14), what a fix changes
//   - for each of the 21 kinds: the sentence, the hints, the field and the fixes (§5 of the BA spec), also for a provider preset that hides the server fields
//   - the provider hints (app password, Google / Microsoft sign-in, AC-16, AC-17), the lines a screen reader hears
//   - stale lines after an edit, the summary line, the pause after three failed sign-ins (AC-9, AC-20), the coded error of a refused Add account (AC-19), the details text
//   - every text of the feature exists in the 8 languages with its values filled in and no raw key (AC-11)
//   node --experimental-strip-types scripts/test-conn-hints.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  accountCheckText, addBlocked, applyFix, badHosts, changedWhileChecking, COOLDOWN_AFTER, describe, detailsText, fieldFor, fixMsg, hostProblem, hostsLookSwapped, KINDS, needReason, nextStreak,
  NO_STREAK, okMsg, parseAccountCheck, preHints, providerOf, say, sigsOf, smtpSharedNote, staleParts, streakKey, summaryOf,
} from '../src/connHints.ts';
import { LANGUAGES, loadAllLanguages, setLangPref, t } from '../src/i18n/index.ts';

const form = (over = {}) => ({
  provider: 'custom', showAdv: true, email: 'sam@example.com', pw: 'secret', username: '', imapHost: 'imap.example.com', imapPort: 993, imapSsl: true,
  smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecurity: 'ssl', sepSmtp: false, smtpUser: '', smtpPw: '', insecure: false, ...over,
});
const rep = (over = {}) => ({ status: 'error', kind: 'auth', host: 'imap.example.com', port: 993, security: 'ssl', certNames: [], detail: '', ms: 10, ...over });
const fixIds = (l) => l.fixes.map((f) => f.id + ('port' in f ? `:${f.part}:${f.port}` : ''));

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

// ---- AC-2 / AC-3: the reason, in field order
eq(needReason(form({ email: '' })), 'need.email');
eq(needReason(form({ email: 'sam' })), 'need.email');
eq(needReason(form({ email: '@example.com' })), 'need.email');
eq(needReason(form({ email: 'sam@' })), 'need.email');
eq(needReason(form({ email: ' sam@example.com ' })), null, 'the address is trimmed');
eq(needReason(form({ pw: '' })), 'need.password');
eq(needReason(form({ imapHost: '' })), 'need.imapHost');
eq(needReason(form({ smtpHost: '' })), 'need.smtpHost');
eq(needReason(form({ imapHost: '', smtpHost: '' })), 'need.imapHost');
eq(needReason(form({ imapPort: 0 })), 'need.port');
eq(needReason(form({ smtpPort: 70000 })), 'need.port');
eq(needReason(form({ imapHost: 'https://imap.example.com/' })), 'need.hostFormat');
eq(needReason(form({ email: '', pw: '', imapHost: '' })), 'need.email', 'the first one that applies');
eq(needReason(form({})), null);
eq(needReason(form({ provider: 'gmail', showAdv: false, imapHost: '', smtpHost: '', imapPort: 0 })), null, 'a preset needs the address and the password only (AC-3)');

// ---- AC-4: a server name
for (const bad of ['https://imap.example.com/', 'imap.example.com/x', 'me@imap.example.com', 'imap example.com', 'imap.example.com:993', 'http://x']) eq(hostProblem(bad), true, bad);
for (const good of ['imap.example.com', '  imap.example.com  ', '127.0.0.1', 'localhost', 'mail.bücher.de', '[::1]']) eq(hostProblem(good), false, good);
eq(badHosts(form({ imapHost: 'https://x/', smtpHost: 'smtp.example.com' })), ['imapHost']);
eq(badHosts(form({ provider: 'gmail', showAdv: false, imapHost: 'https://x/' })), [], 'a preset hides the fields');
eq(addBlocked(form({ imapHost: 'https://x/' })), true);
eq(addBlocked(form({ email: 'x', pw: 'y' })), false, 'Add keeps its own rule: something typed in both');
eq(addBlocked(form({ pw: '' })), true);

// ---- AC-13 / AC-14: hints before a test
{
  const p = preHints(form({ imapPort: 993, imapSsl: false }));
  eq(p.map((h) => h.id), ['imapPortSecurity']);
  eq(p[0].msg.params, { port: 993, security: 'SSL/TLS' });
  eq(p[0].fixes.map((f) => `${f.id}:${f.port}`), ['useSsl:993', 'useStarttls:143'], 'both buttons');
  const q = preHints(form({ imapPort: 143, imapSsl: true }));
  eq(q[0].msg.params, { port: 143, security: 'STARTTLS' });
  const s = preHints(form({ smtpPort: 465, smtpSecurity: 'starttls' }));
  eq([s[0].id, s[0].msg.params.security, s[0].fixes.map((f) => `${f.id}:${f.port}`)], ['smtpPortSecurity', 'SSL/TLS', ['useSsl:465', 'useStarttls:587']]);
  eq(preHints(form({ smtpPort: 587, smtpSecurity: 'ssl' }))[0].msg.params, { port: 587, security: 'STARTTLS' });
  eq(preHints(form({ smtpPort: 25 })).map((h) => h.id), ['smtp25']);
  eq(preHints(form({ imapPort: 1143, imapSsl: false, smtpPort: 1025, smtpSecurity: 'starttls' })), [], 'Bridge ports get no hint');
  eq(preHints(form({})), [], 'a good combination: nothing');
  eq(preHints(form({ imapHost: 'smtp.example.com', smtpHost: 'imap.example.com' })).map((h) => [h.id, h.part]), [['swapped', 'imap']], 'one hint for the pair, under the IMAP row');
  eq(hostsLookSwapped(form({ imapHost: 'mail-out.example.com' })), true);
  eq(hostsLookSwapped(form({ smtpHost: 'imap.example.com' })), true);
  eq(hostsLookSwapped(form({})), false);
  eq(preHints(form({ provider: 'gmail', showAdv: false, imapPort: 143 })), [], 'no hints while the server fields are hidden');
  // the fixes change the form only
  eq(applyFix(form(), { id: 'useSsl', part: 'imap', port: 993 }), { imapSsl: true, imapPort: 993 });
  eq(applyFix(form(), { id: 'useStarttls', part: 'imap', port: 143 }), { imapSsl: false, imapPort: 143 });
  eq(applyFix(form(), { id: 'useStarttls', part: 'smtp', port: 587 }), { smtpSecurity: 'starttls', smtpPort: 587 });
  eq(applyFix(form(), { id: 'useSsl', part: 'smtp', port: 465 }), { smtpSecurity: 'ssl', smtpPort: 465 });
  eq(applyFix(form({ imapHost: 'smtp.example.com', smtpHost: 'imap.example.com' }), { id: 'swapHosts' }), { imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' });
  eq(applyFix(form(), { id: 'trust' }), { insecure: true });
}

// ---- §5: every kind -> sentence, hints, field, fixes
const msgKeys = (l) => [l.msg.key, ...l.hints.map((h) => h.key)].map((k) => k.replace('settings.test.', ''));
{
  const custom = form();
  const cases = [
    // [kind, part, report over, form over, message + hints, field, fixes]
    ['dns', 'imap', {}, {}, ['err.dns', 'hint.dns.imap'], 'imapHost', []],
    ['dns', 'smtp', { host: 'smtp.example.com', port: 465 }, {}, ['err.dns', 'hint.dns.smtp'], 'smtpHost', []],
    ['dns', 'imap', {}, { provider: 'gmail', showAdv: false }, ['err.dns', 'hint.dns.preset'], null, []],
    ['refused', 'imap', {}, {}, ['err.refused', 'hint.refused'], 'imapPort', []],
    ['refused', 'imap', {}, { imapPort: 993, imapSsl: false }, ['err.refused', 'hint.refused'], 'imapPort', ['useSsl:imap:993', 'useStarttls:imap:143']],
    ['unreachable', 'smtp', {}, {}, ['err.unreachable', 'hint.unreachable'], 'smtpHost', []],
    ['timeout', 'imap', {}, {}, ['err.timeout', 'hint.timeout.imap'], 'imapHost', []],
    ['timeout', 'smtp', {}, {}, ['err.timeout', 'hint.timeout.smtp'], 'smtpHost', []],
    ['secure', 'imap', {}, { imapPort: 143, imapSsl: true }, ['err.secure', 'hint.secure'], 'imapSecurity', ['useSsl:imap:993', 'useStarttls:imap:143']],
    ['secure', 'imap', {}, { imapPort: 993, imapSsl: true }, ['err.secure', 'hint.secure'], 'imapSecurity', ['useStarttls:imap:143']],
    ['secure', 'smtp', {}, { smtpPort: 25, smtpSecurity: 'ssl' }, ['err.secure', 'hint.secure'], 'smtpSecurity', []],
    ['secure', 'smtp', {}, { smtpPort: 465, smtpSecurity: 'starttls' }, ['err.secure', 'hint.secure'], 'smtpSecurity', ['useSsl:smtp:465', 'useStarttls:smtp:587']],
    ['certUntrusted', 'imap', {}, {}, ['err.certUntrusted', 'hint.certUntrusted.custom'], 'imapHost', ['trust']],
    ['certUntrusted', 'imap', {}, { insecure: true }, ['err.certUntrusted', 'hint.certUntrusted.custom'], 'imapHost', []],
    ['certUntrusted', 'imap', {}, { provider: 'gmail', showAdv: false }, ['err.certUntrusted', 'hint.certUntrusted.preset'], null, []],
    ['certName', 'imap', {}, {}, ['err.certName', 'hint.certName'], 'imapHost', ['trust']],
    ['certName', 'imap', { certNames: ['imap.example.org', 'example.org'] }, {}, ['err.certName', 'hint.certName', 'hint.certNameSeen'], 'imapHost', ['trust']],
    ['certExpired', 'imap', {}, {}, ['err.certExpired', 'hint.certExpired'], null, ['trust']],
    ['notImap', 'imap', { sees: 'smtp' }, {}, ['err.notImap', 'hint.notImap.isSmtp'], 'imapPort', []],
    ['notImap', 'imap', { sees: 'smtp' }, { imapHost: 'smtp.example.com', smtpHost: 'imap.example.com' }, ['err.notImap', 'hint.notImap.isSmtp'], 'imapPort', ['swapHosts']],
    ['notImap', 'imap', {}, {}, ['err.notImap', 'hint.notImap.other'], 'imapPort', []],
    ['notSmtp', 'smtp', { sees: 'imap' }, {}, ['err.notSmtp', 'hint.notSmtp.isImap'], 'smtpPort', []],
    ['notSmtp', 'smtp', {}, {}, ['err.notSmtp', 'hint.notSmtp.other'], 'smtpPort', []],
    ['busy', 'imap', {}, {}, ['err.busy', 'hint.busy'], null, []],
    ['auth', 'imap', {}, {}, ['err.auth', 'hint.auth'], 'password', []],
    ['auth', 'imap', {}, { username: 'sam@example.com' }, ['err.auth', 'hint.auth'], 'password', []],
    ['auth', 'imap', {}, { username: 'sam' }, ['err.auth', 'hint.auth', 'hint.auth.fullAddress'], 'username', []],
    ['auth', 'imap', {}, { pw: ' secret ' }, ['err.auth', 'hint.auth', 'hint.auth.spaces'], 'password', []],
    ['auth', 'smtp', {}, { sepSmtp: true, smtpUser: 'u', smtpPw: 'p ' }, ['err.auth', 'hint.auth.smtpSep', 'hint.auth.spaces'], 'smtpPassword', []],
    ['auth', 'imap', { host: 'imap.gmail.com' }, { provider: 'gmail', showAdv: false }, ['err.auth', 'hint.auth', 'hint.auth.provider'], 'password', ['appPassword', 'google']],
    ['auth', 'imap', { host: 'imap.mail.me.com' }, { provider: 'icloud', showAdv: false }, ['err.auth', 'hint.auth', 'hint.auth.provider'], 'password', ['appPassword']],
    ['auth', 'smtp', { host: 'smtp.mail.yahoo.com' }, { provider: 'yahoo', showAdv: false }, ['err.auth', 'hint.auth', 'hint.auth.provider'], 'password', ['appPassword']],
    ['appPassword', 'imap', { host: 'imap.gmail.com' }, { provider: 'gmail', showAdv: false }, ['err.appPassword', 'hint.appPassword'], 'password', ['appPassword', 'google']],
    ['microsoftPassword', 'imap', { host: 'outlook.office365.com' }, { provider: 'outlook', showAdv: false }, ['err.microsoftPassword', 'hint.microsoftPassword'], null, ['microsoft']],
    ['smtpAuthOff', 'smtp', { host: 'smtp.office365.com' }, {}, ['err.smtpAuthOff', 'hint.smtpAuthOff'], null, ['microsoft']],
    ['imapOff', 'imap', {}, {}, ['err.imapOff', 'hint.imapOff'], null, []],
    ['webLogin', 'imap', {}, {}, ['err.webLogin', 'hint.webLogin'], null, []],
    ['tooMany', 'imap', {}, {}, ['err.tooMany', 'hint.tooMany'], null, []],
    ['noAuth', 'smtp', {}, { smtpPort: 25 }, ['err.noAuth', 'hint.noAuth'], 'smtpPort', ['useSsl:smtp:465', 'useStarttls:smtp:587']],
    ['noAuth', 'smtp', {}, { smtpPort: 587, smtpSecurity: 'starttls' }, ['err.noAuth', 'hint.noAuth'], 'smtpPort', ['useSsl:smtp:465']],
    ['listFailed', 'imap', { status: 'warn' }, {}, ['warn.listFailed'], null, []],
    ['unknown', 'smtp', {}, {}, ['err.unknown', 'hint.unknown'], null, []],
    ['something new', 'smtp', {}, {}, ['err.unknown', 'hint.unknown'], null, []],
  ];
  const seen = new Set();
  for (const [kind, part, over, fover, keys, field, fixes] of cases) {
    const f = form(fover);
    const r = rep({ kind, host: part === 'imap' ? 'imap.example.com' : 'smtp.example.com', port: part === 'imap' ? 993 : 465, ...over });
    const l = describe(part, r, f);
    const what = `${kind}/${part}/${JSON.stringify(fover)}`;
    eq(msgKeys(l), keys, `${what}: sentence and hints`);
    eq(l.field, field, `${what}: field`);
    eq(fixIds(l), fixes, `${what}: fixes`);
    seen.add(kind);
  }
  for (const k of KINDS) assert.ok(seen.has(k), `no case for the kind ${k}`);
  eq(KINDS.length, 21);
  eq(describe('imap', rep({ kind: 'unknown' }), custom).openDetails, true, 'unknown opens the details');
  eq(describe('imap', rep({ kind: 'auth' }), custom).openDetails, false);
  eq(describe('imap', rep({ kind: 'wat' }), custom).openDetails, true);
  eq(describe('imap', rep({ kind: 'timeout' }), custom).msg.params, { s: 20 });
  eq(describe('imap', rep({ kind: 'refused', port: 31501 }), custom).msg.params, { port: 31501 });
  eq(describe('imap', rep({ kind: 'certName', host: 'x.test' }), custom).msg.params, { host: 'x.test' });
  eq(describe('imap', rep({ kind: 'appPassword', host: 'imap.gmail.com' }), custom).msg.params, { provider: 'Gmail' });
  eq(describe('imap', rep({ kind: 'appPassword', host: 'imap.example.com' }), custom).msg.params, { provider: 'imap.example.com' }, 'a server of no known provider is named by its host');
  // Show field only for a field the form shows
  eq(fieldFor('imap', 'dns', form({ provider: 'gmail', showAdv: false })), null);
  eq(fieldFor('smtp', 'auth', form({ username: 'sam', sepSmtp: false })), 'username');
  eq(fieldFor('smtp', 'auth', form({ sepSmtp: false })), 'password');
  eq(fieldFor('smtp', 'auth', form({ username: 'sam@example.com', sepSmtp: false })), 'password');
  // the Google link carries the URL of the site's Help page; the others are the provider's own
  eq(describe('imap', rep({ kind: 'auth', host: 'imap.gmail.com' }), form()).fixes[0], { id: 'appPassword', url: 'https://myaccount.google.com/apppasswords' });
  eq(describe('imap', rep({ kind: 'auth', host: 'imap.mail.me.com' }), form()).fixes[0].url, 'https://account.apple.com');
  eq(describe('imap', rep({ kind: 'auth', host: 'imap.mail.yahoo.com' }), form()).fixes[0].url, 'https://login.yahoo.com/account/security');
  eq(providerOf('imap.gmail.com'), 'gmail'); eq(providerOf('SMTP.GMAIL.COM'), 'gmail'); eq(providerOf('imap.mail.me.com'), 'icloud'); eq(providerOf('smtp.mail.yahoo.com'), 'yahoo');
  eq(providerOf('outlook.office365.com'), 'microsoft'); eq(providerOf('imap.example.com'), null); eq(providerOf('notgmail.com'), null);
}

// ---- stale lines, the summary, the shared SMTP note (AC-9, AC-15, AC-18)
{
  const f = form();
  const sigs = sigsOf(f);
  const block = (imap, smtp, over = {}) => ({ source: 'test', imap: { state: 'done', report: imap }, smtp: { state: 'done', report: smtp }, sigs, ...over });
  const ok = (over = {}) => rep({ status: 'ok', kind: 'ok', ...over });
  const stale = (g) => staleParts(g, sigsOf(g.f));
  const at = (g, over) => staleParts(g, sigsOf(form(over)));
  const b = block(ok(), ok());
  eq(at(b, {}), { imap: false, smtp: false });
  eq(at(b, { smtpPort: 587 }), { imap: false, smtp: true }, 'the SMTP port: only the SMTP line');
  eq(at(b, { smtpHost: 'x.example.com' }), { imap: false, smtp: true });
  eq(at(b, { smtpSecurity: 'starttls' }), { imap: false, smtp: true });
  eq(at(b, { imapPort: 143 }), { imap: true, smtp: false });
  eq(at(b, { imapHost: 'x.example.com' }), { imap: true, smtp: false });
  eq(at(b, { imapSsl: false }), { imap: true, smtp: false });
  eq(at(b, { pw: 'other' }), { imap: true, smtp: true }, 'the password: both');
  eq(at(b, { email: 'a@b.c' }), { imap: true, smtp: true });
  eq(at(b, { username: 'u' }), { imap: true, smtp: true });
  eq(at(b, { insecure: true }), { imap: true, smtp: true });
  eq(at(b, { sepSmtp: true }), { imap: true, smtp: true });
  eq(at(b, { provider: 'gmail' }), { imap: true, smtp: true });
  eq(at(b, { smtpUser: 'u' }), { imap: false, smtp: false }, 'the SMTP user matters only with a separate login');
  eq(staleParts(block(ok(), ok(), { sigs: sigsOf(form({ sepSmtp: true, smtpUser: 'a' })) }), sigsOf(form({ sepSmtp: true, smtpUser: 'b' }))), { imap: false, smtp: true });
  void stale;
  const none = { imap: false, smtp: false };
  eq(summaryOf(b, none), { key: 'settings.test.summary.ok', tone: 'good' });
  eq(summaryOf(block(ok(), rep()), none), { key: 'settings.test.summary.failed', tone: 'bad' });
  eq(summaryOf(block(rep({ kind: 'dns' }), rep({ kind: 'dns' })), none), { key: 'settings.test.summary.offline', tone: 'bad' });
  eq(summaryOf(block(rep({ kind: 'unreachable' }), rep({ kind: 'dns' })), none).key, 'settings.test.summary.offline');
  eq(summaryOf(block(rep({ kind: 'dns' }), ok()), none).key, 'settings.test.summary.failed', 'one reachable: not offline');
  eq(summaryOf(block(ok({ status: 'warn', kind: 'listFailed' }), ok()), none), { key: 'settings.test.summary.warn', tone: 'warn' });
  eq(summaryOf(b, { imap: false, smtp: true }), { key: 'settings.test.summary.stale', tone: 'warn' });
  eq(summaryOf({ ...b, imap: { state: 'checking' } }, none), { key: 'settings.test.summary.checking', tone: 'info' });
  eq(summaryOf({ ...b, imap: { state: 'cancelled' }, smtp: { state: 'cancelled' } }, none).key, 'settings.test.cancelled');
  eq(summaryOf({ ...block(rep(), { state: 'x' }), source: 'add', smtp: { state: 'notChecked' } }, none), { key: 'settings.test.summary.addFailed', tone: 'bad' });
  // an edit while a test runs ends it; one after the result only marks lines
  const running = { source: 'test', imap: { state: 'checking' }, smtp: { state: 'done', report: ok() }, sigs };
  eq(changedWhileChecking(running, sigsOf(form({ imapPort: 143 }))), true);
  eq(changedWhileChecking(running, sigs), false);
  eq(changedWhileChecking(b, sigsOf(form({ imapPort: 143 }))), false);
  // the shared SMTP login refused while the incoming server works: Add still adds the account (AC-18)
  eq(smtpSharedNote(block(ok(), rep({ kind: 'auth', host: 'smtp.example.com' })), f), true);
  eq(smtpSharedNote(block(ok(), rep({ kind: 'auth' })), form({ sepSmtp: true })), false, 'a separate login blocks the add');
  eq(smtpSharedNote(block(ok(), rep({ kind: 'secure' })), f), false, 'a server that cannot be secured blocks the add');
  eq(smtpSharedNote(block(rep(), rep()), f), false, 'nothing to add when the incoming server fails');
  eq(smtpSharedNote(block(ok(), ok()), f), false);
}

// ---- AC-20: three failed sign-ins in a row pause; a success resets
{
  const key = streakKey(form());
  eq(key, 'imap.example.com|sam@example.com');
  eq(streakKey(form({ username: 'Sam' })), 'imap.example.com|sam');
  const fail = rep({ kind: 'auth' }), good = rep({ status: 'ok', kind: 'ok' });
  let s = NO_STREAK;
  const step = (reports, k = key) => { const r = nextStreak(s, k, reports); s = r.streak; return r.pause; };
  eq(step([fail, fail]), false, 'two parts failing is one failed test');
  eq(step([fail]), false);
  eq(step([fail]), true, `the ${COOLDOWN_AFTER}rd`);
  eq(s.count, 0, 'the count starts again after the pause');
  step([fail]); step([good, good]);
  eq(s.count, 0, 'a success in between resets');
  step([fail]); step([fail]);
  eq(step([rep({ kind: 'dns' })]), false, 'a failure that is not a sign-in counts for nothing');
  eq(s.count, 2, '... and resets nothing');
  eq(step([fail]), true);
  eq(nextStreak(NO_STREAK, key, [rep({ kind: 'tooMany' })]).pause, true, 'the server said too many: at once');
  eq(nextStreak({ key, count: 2 }, 'other|user', [fail]).streak.count, 1, 'another server or user starts a count of its own');
  for (const kind of ['auth', 'appPassword', 'microsoftPassword']) { let c = NO_STREAK; c = nextStreak(c, key, [rep({ kind })]).streak; c = nextStreak(c, key, [rep({ kind })]).streak; eq(nextStreak(c, key, [rep({ kind })]).pause, true, kind); }
  eq(nextStreak({ key, count: 2 }, key, [null, undefined]).streak.count, 2);
}

// ---- AC-19 / REQ-10: the coded error of a refused Add account (as src-tauri/src/conntest.rs `coded_error` writes it)
{
  const esc = (v) => v.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/:/g, '%3A').replace(/\n/g, '%0A');
  const coded = (p) => `ACCOUNT_CHECK|${Object.entries(p).map(([k, v]) => `${k}=${esc(v)}`).join('|')}: Incoming (IMAP): Sign-in failed. Check the username and password.`;
  const raw = coded({ part: 'imap', kind: 'auth', host: 'imap.example.com', port: '993', sec: 'ssl', sees: '', names: '', detail: 'LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials\nsecond: line | with bar' });
  const p = parseAccountCheck(new Error(raw));
  eq([p.part, p.report.kind, p.report.host, p.report.port, p.report.security, p.report.status, p.report.sees], ['imap', 'auth', 'imap.example.com', 993, 'ssl', 'error', undefined]);
  eq(p.report.detail, 'LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials\nsecond: line | with bar', 'the detail comes back as it was');
  eq(parseAccountCheck(coded({ part: 'smtp', kind: 'certName', host: 'h', port: '465', sec: 'ssl', sees: '', names: 'a.example.org,b.example.org', detail: '' })).report.certNames, ['a.example.org', 'b.example.org']);
  eq(parseAccountCheck(coded({ part: 'smtp', kind: 'notSmtp', host: 'h', port: '25', sec: 'none', sees: 'imap', names: '', detail: '' })).report.sees, 'imap');
  eq(parseAccountCheck('KEYRING_TIMEOUT: Your system keyring is locked'), null);
  eq(parseAccountCheck('plain text'), null);
  eq(parseAccountCheck(coded({ part: 'other', kind: 'auth' })), null);
  setLangPref('en');
  eq(accountCheckText(raw), 'Incoming (IMAP): Sign-in failed. Check the username and password. Some servers need the full email address as the username.');
  eq(accountCheckText('SMTP login failed: x'), null);
}

// ---- the details text: both parts, the reply, the product line; no password
{
  const f = form();
  const sigs = sigsOf(f);
  const b = { source: 'test', sigs, imap: { state: 'done', report: rep({ kind: 'auth', detail: 'LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials', ms: 321 }) }, smtp: { state: 'done', report: rep({ status: 'ok', kind: 'ok', host: 'smtp.example.com', port: 465 }) } };
  setLangPref('en');
  const text = detailsText(b, 'Hey Look! 1.0.10, Windows');
  eq(text, ['Incoming (IMAP): imap.example.com:993 SSL/TLS', '  auth 321 ms', '  LOGIN: NO [AUTHENTICATIONFAILED] Invalid credentials', 'Outgoing (SMTP): smtp.example.com:465 SSL/TLS', '  ok 10 ms', 'Hey Look! 1.0.10, Windows'].join('\n'));
  eq(detailsText({ ...b, imap: { state: 'done', report: rep({ host: '', port: 0, status: 'ok', kind: 'ok' }) } }, 'P').split('\n')[0], 'Outgoing (SMTP): smtp.example.com:465 SSL/TLS', 'a part that was not asked (no host) is left out');
}

// ---- every text, in every language: found, filled in, no raw key, no {placeholder} left (AC-11, REQ-28 rows)
await loadAllLanguages();
{
  const forms = [form(), form({ provider: 'gmail', showAdv: false }), form({ sepSmtp: true, smtpUser: 'u', smtpPw: 'p ', username: 'sam' }), form({ imapHost: 'smtp.example.com', smtpHost: 'imap.example.com', imapPort: 993, imapSsl: false })];
  const hosts = ['imap.example.com', 'imap.gmail.com', 'imap.mail.me.com', 'smtp.mail.yahoo.com', 'outlook.office365.com'];
  const en = {};
  for (const l of LANGUAGES) {
    setLangPref(l.code);
    const texts = [];
    for (const f of forms) for (const kind of [...KINDS, 'zzz']) for (const part of ['imap', 'smtp']) for (const host of hosts) {
      const r = rep({ kind, host, port: 993, sees: kind === 'notImap' ? 'smtp' : kind === 'notSmtp' ? 'imap' : undefined, certNames: ['a.example.org', 'b.example.org'] });
      const line = describe(part, r, f);
      for (const m of [line.msg, ...line.hints]) texts.push(say(m));
      for (const fx of line.fixes) texts.push(say(fixMsg(fx)));
    }
    for (const n of [0, 1, 2, 3, 5, 11, 12, 21, 22, 100]) texts.push(say(okMsg('imap', rep({ status: 'ok', kind: 'ok', folders: n }))));
    texts.push(say(okMsg('smtp', rep({ status: 'ok', kind: 'ok' }))));
    for (const h of preHints(form({ imapPort: 993, imapSsl: false, smtpPort: 25, imapHost: 'smtp.a.b' }))) texts.push(say(h.msg));
    for (const h of preHints(form({ smtpPort: 465, smtpSecurity: 'starttls' }))) texts.push(say(h.msg));
    for (const k of ['summary.checking', 'summary.ok', 'summary.warn', 'summary.failed', 'summary.offline', 'summary.stale', 'summary.addFailed', 'cancelled', 'stale', 'notChecked', 'button', 'testing', 'checking', 'groupLabel', 'smtpSharedNote', 'showField', 'details', 'copied', 'warn.listFailed', 'need.email', 'need.password', 'need.imapHost', 'need.smtpHost', 'need.port', 'need.hostFormat']) texts.push(t(`settings.test.${k}`));
    texts.push(t('settings.test.cooldown', { s: 42 }), t('settings.test.showFieldNamed', { field: t('settings.add.imapHost') }));
    for (const x of texts) {
      assert.ok(!/\{\w+\}/.test(x), `${l.code}: a placeholder is left in "${x}"`);
      assert.ok(!/settings\.test\.|undefined|NaN|\[object/.test(x), `${l.code}: a raw key or a missing value in "${x}"`);
      assert.ok(x.trim().length > 0, `${l.code}: an empty text`);
    }
    if (l.code === 'en') for (const k of ['button']) en[k] = t(`settings.test.${k}`);
    else assert.notEqual(t('settings.test.summary.ok'), 'Both servers work. You can add the account.', `${l.code}: not translated`);
    checks += texts.length;
  }
  setLangPref('en');
  eq(t('settings.test.ok.imap', { n: 12 }), 'Connected and signed in. 12 folders found.');
  eq(t('settings.test.ok.imap', { n: 1 }), 'Connected and signed in. 1 folder found.');
  eq(t('settings.test.cooldown', { s: 60 }), 'Paused for 60 s after several failed sign-ins, so the server does not lock your account.');
}

console.log(`ok - test-conn-hints (${checks} checks, ${fileURLToPath(import.meta.url).split(/[\\/]/).pop()})`);
