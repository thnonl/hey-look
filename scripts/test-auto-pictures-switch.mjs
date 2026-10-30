#!/usr/bin/env node
// 1.0.11 WP2: the settings of the automatic picture rule are wired end to end (source-level checks, no browser, no build):
//   S1  the backend decides: `reason_for` (autoload.rs) asks the global switch first, so a message read while the switch is off never carries an autoReason
//   S2  the three new commands exist, are registered in the invoke handler, listed in build.rs and allowed for the main, pop-out and Settings windows
//   S3  the page reads the switch with the lists (reloadTrusted), every rule call site passes it, and the pop-out/print/reply quote use the same helper
//   S4  Settings > Reading & sync shows the switch, the list of senders turned off (Remove per row) and the read-only domain list, with the strings in all 8 languages
//   node scripts/test-auto-pictures-switch.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- S1
const auto = read('src-tauri/src/autoload.rs');
const fn = auto.slice(auto.indexOf('pub fn reason_for('), auto.indexOf('mod tests'));
assert.match(fn, /auth_ev\?;\s*if !enabled\(c\) \{\s*return None;\s*\}/, 'reason_for returns nothing while the switch is off, before it reads anything else');
assert.match(auto, /pub const SWITCH_KEY: &str = "auto_pictures";/);
assert.match(auto, /get_setting\(c, SWITCH_KEY\)\.as_deref\(\) != Some\("0"\)/, 'default on; only "0" is off');
const lib = read('src-tauri/src/lib.rs');
assert.match(lib, /autoload::reason_for\(c, /, 'the one place that applies the rule still goes through reason_for');

// ---- S2
const cmds = ['get_auto_pictures', 'set_auto_pictures', 'list_service_domains'];
const build = read('src-tauri/build.rs');
for (const c of cmds) {
  assert.match(lib, new RegExp(`#\\[tauri::command\\]\\s*fn ${c}\\(`), `${c} is a command`);
  assert.match(lib, new RegExp(`^\\s+${c},$`, 'm'), `${c} is in the invoke handler`);
  assert.ok(build.includes(`"${c}"`), `${c} is in build.rs`);
  for (const w of ['default', 'popout', 'settings']) assert.ok(read(`src-tauri/capabilities/${w}.json`).includes(`"allow-${c.replaceAll('_', '-')}"`), `${c} is allowed in ${w}.json`);
}
assert.match(lib, /fn set_auto_pictures[\s\S]{0,300}app\.emit\("remote-ok-changed"/, 'every window is told');
assert.match(lib, /fn list_service_domains\(\) -> Vec<&'static str> \{[\s\S]{0,200}autoload::SERVICE_DOMAINS/, 'the list is the source constant');

// ---- S3
const rule = read('src/trustedRule.ts');
assert.match(rule, /i\.autoOn !== false && !!i\.autoReason/, 'the rule ignores autoReason when the switch is off');
const store = read('src/trustedSenders.ts');
assert.match(store, /api\.getAutoPictures\(\)/, 'the store reads the switch together with the lists');
assert.match(store, /autoOn: useTrusted\.getState\(\)\.autoOn/, 'remoteAllowedFor (quote of a reply, heavy-message wait) passes the switch');
const pane = read('src/components/ReadingPane.tsx');
assert.equal((pane.match(/autoOn,? folder: m\.folder/g) ?? []).length, 2, 'both rule call sites of the reading pane pass the switch');

// ---- S4
const dlg = read('src/components/SettingsDialog.tsx');
const panel = dlg.slice(dlg.indexOf('function ReadingPanel('));
assert.match(panel, /<TrustedSenders[^>]*\/>\s*<AutoPictures global=\{eff\(prefs, scope, "loadRemote"\)\} \/>\s*<NoAutoSenders \/>/, '"Always show pictures" and its list, then the group of the automatic rule');
assert.match(dlg, /<Switch checked=\{on\} disabled=\{global\} onChange=\{change\} \/>/, 'the switch is disabled while "Always show pictures" is on');
assert.match(dlg, /aria-label=\{t\("settings\.reading\.trustedRemoveLabel", \{ email: e \}\)\} onClick=\{\(\) => void removeNoAuto\(e\)/, 'Remove {email} per row of the list of senders turned off');
assert.match(dlg, /aria-expanded=\{open\} aria-controls="service-domains"/, 'the domain list is a disclosure button');
const keys = ['autoPics', 'autoPicsHint', 'autoPicsGlobalOn', 'noauto', 'noautoHint', 'noautoNone', 'domainsShow', 'domainsHide', 'domainsNote', 'domainsCount'].map((k) => `settings.reading.${k}`).concat('settings.kw.autoPics');
const files = ['src/i18n/ns/settings.ts', ...['de', 'es', 'fr', 'ja', 'ru', 'vi', 'zh-Hans'].map((l) => `src/i18n/locales/${l}/settings.ts`)];
for (const f of files) {
  const s = read(f);
  for (const k of keys) assert.ok(s.includes(`"${k}":`), `${f} has ${k}`);
}
assert.ok(read('src/settingsIndex.ts').includes('"settings.reading.autoPics"'), 'Settings search finds the group');
for (const c of ['get_auto_pictures', 'set_auto_pictures', 'list_service_domains']) assert.ok(read('src/devMock.ts').includes(`case "${c}"`), `devMock answers ${c}`);

console.log('test-auto-pictures-switch: ok');
