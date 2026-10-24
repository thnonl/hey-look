#!/usr/bin/env node
// 1.0.7 D-104 (Mac QA 5174e88: "Unhandled rejection: notification.is_permission_granted not allowed" in the main page): every plugin command that a page of the app sends, or that a plugin sends for it,
// is allowed by the capabilities of the windows that run it. Sources of such commands:
//   (1) the page's own calls: `plugin:<name>|<command>` strings and the plugin packages the page imports (`@tauri-apps/plugin-<name>`): every window kind runs the same bundle, so each window
//       must be granted the plugin (`<name>:default` or `<name>:allow-<command>`), here `opener`;
//   (2) plugins that put a script into every web view (the notification plugin asks `plugin:notification|is_permission_granted` as soon as a page loads, on every system that loads the plugin):
//       the command is granted to every window kind. The plugin is not a dependency on Windows (Cargo.toml), so the grant sits in a capability that is for macOS and Linux only (a permission of
//       an absent plugin would fail the Windows build).
// Also: no capability names a plugin the app does not register.
//   node scripts/test-plugin-capabilities.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const check = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

const capDir = 'src-tauri/capabilities';
const caps = fs.readdirSync(path.join(root, capDir)).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, ...JSON.parse(read(`${capDir}/${f}`)) }));
const kebab = (s) => s.replace(/_/g, '-');
/** Is `plugin|cmd` granted by this capability? */
const grants = (cap, plugin, cmd) => (cap.permissions ?? []).some((p) => typeof p === 'string' && (p === `${plugin}:default` || p === `${plugin}:allow-${kebab(cmd)}`));

// the window labels of the app (src/popout/route.ts kinds + main) and which capability file is for which windows
const kindsSrc = /POPOUT_KINDS: readonly PopoutKind\[\] = \[([^\]]*)\]/.exec(read('src/popout/route.ts'))[1];
const kinds = (kindsSrc.match(/"(\w+)"/g) ?? []).map((s) => s.replace(/"/g, ''));
assert.deepEqual([...kinds].sort(), ['compose', 'event', 'reader', 'scheduled', 'search', 'settings']);
const labels = ['main', ...kinds.map((k) => `${k}-1`)];
const globMatch = (pattern, label) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(label);
const capsOf = (label, platform) => caps.filter((c) => (c.windows ?? []).some((w) => globMatch(w, label)) && (!c.platforms || c.platforms.includes(platform)));

// the page's own plugin calls, from the sources (the dev preview's mock is not a page of the app)
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name) && !/^src\/devMock/.test(p)) files.push(p); } };
walk('src');
const pageCalls = new Map(); // "plugin|cmd" -> file
const pagePlugins = new Map(); // plugin -> file
for (const f of files) {
  const s = read(f);
  for (const [, plugin, cmd] of s.matchAll(/["'`]plugin:(\w+)\|(\w+)["'`]/g)) pageCalls.set(`${plugin}|${cmd}`, f);
  for (const [, plugin] of s.matchAll(/from ["']@tauri-apps\/plugin-([\w-]+)["']/g)) pagePlugins.set(plugin.replace(/-/g, '_'), f);
}

check('the page imports only the plugins this test knows (a new plugin must be added here and to every capability)', () => {
  assert.deepEqual([...pagePlugins.keys()].sort(), ['opener'], `plugins the page imports: ${[...pagePlugins.entries()].map(([p, f]) => `${p} (${f})`)}`);
  assert.deepEqual([...pageCalls.keys()].filter((k) => !k.startsWith('opener|')), [], 'plugin calls by name');
});

check('(1) every window kind may use every plugin the page imports (opener: every capability has it)', () => {
  for (const plugin of pagePlugins.keys()) for (const label of labels) {
    for (const platform of ['windows', 'macOS', 'linux']) {
      const list = capsOf(label, platform);
      assert.ok(list.length >= 1, `${label} (${platform}) has no capability at all`);
      assert.ok(list.some((c) => grants(c, plugin, 'open_url')), `${label} (${platform}): no capability grants ${plugin}`);
    }
  }
});

// (2) what a plugin does by itself in every web view
const injected = [
  // the plugin, its crate, the command its init script sends on every page load, the platforms that load the plugin (lib.rs: `#[cfg(not(windows))]` ... `tauri_plugin_notification::init()`)
  { plugin: 'notification', crate: 'tauri_plugin_notification', cmd: 'is_permission_granted', platforms: ['macOS', 'linux'] },
];
check('(2) the plugins with an init script are registered where the list says', () => {
  const lib = read('src-tauri/src/lib.rs');
  for (const p of injected) {
    assert.ok(lib.includes(`${p.crate}::init()`), `${p.crate}::init() is not registered any more: update this list`);
  }
  assert.ok(/#\[cfg\(not\(windows\)\)\]\s*\n\s*let builder = builder\.plugin\(tauri_plugin_notification::init\(\)\);/.test(lib), 'the notification plugin is for macOS and Linux only');
  assert.ok(/\[target\.'cfg\(not\(windows\)\)'\.dependencies\]\s*\n(#[^\n]*\n)*tauri-plugin-notification/.test(read('src-tauri/Cargo.toml')), 'a dependency of macOS and Linux only');
  // the plugin's own init script really asks that command (the copy of the crate that cargo fetched, when it is there)
  const reg = path.join(process.env.CARGO_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo'), 'registry', 'src');
  if (fs.existsSync(reg)) {
    const hit = fs.readdirSync(reg).flatMap((d) => fs.readdirSync(path.join(reg, d)).filter((x) => x.startsWith('tauri-plugin-notification-')).map((x) => path.join(reg, d, x, 'src', 'init-iife.js')));
    for (const f of hit.filter((x) => fs.existsSync(x))) assert.ok(fs.readFileSync(f, 'utf8').includes('plugin:notification|is_permission_granted'), `${f} no longer asks is_permission_granted: update this test`);
  }
});

check('(2) every window kind has the injected command on the platforms that load the plugin, and no capability names the plugin elsewhere', () => {
  for (const p of injected) {
    for (const label of labels) for (const platform of p.platforms) {
      assert.ok(capsOf(label, platform).some((c) => grants(c, p.plugin, p.cmd)), `${label} (${platform}): ${p.plugin}|${p.cmd} is not granted (the page would log an unhandled rejection at every load)`);
    }
    for (const c of caps) {
      const names = (c.permissions ?? []).some((x) => typeof x === 'string' && x.startsWith(`${p.plugin}:`));
      if (!names) continue;
      assert.ok(Array.isArray(c.platforms) && c.platforms.length > 0 && c.platforms.every((x) => p.platforms.includes(x)), `${c.file}: grants ${p.plugin} without "platforms" limited to ${p.platforms}`);
    }
  }
  // only the one command: nothing else of the notification plugin (the notifications are sent from the backend)
  const notif = caps.find((c) => c.identifier === 'notification');
  assert.deepEqual(notif.permissions, ['notification:allow-is-permission-granted']);
  assert.deepEqual(notif.windows, ['*']);
});

check('the capabilities only name plugins the app registers, or core', () => {
  const lib = read('src-tauri/src/lib.rs');
  assert.ok(lib.includes('tauri_plugin_opener::init()'), 'opener registered');
  const known = new Set(['core', 'opener', 'notification']);
  for (const c of caps) for (const p of c.permissions ?? []) {
    if (typeof p !== 'string' || !p.includes(':')) continue;
    assert.ok(known.has(p.split(':')[0]), `${c.file}: ${p} is a permission of a plugin the app does not register`);
  }
});

console.log(`${process.exitCode ? 'FAILED' : 'ok'} - test-plugin-capabilities (${n} checks)`);
