#!/usr/bin/env node
// The cargo feature `qa-secrets` (src-tauri/src/qasecrets.rs) keeps the credentials of a QA kit in a plain JSON file instead of the system store. It must never reach a user:
//   - it is declared in src-tauri/Cargo.toml and is NOT in `default` (nor in any feature that another feature turns on, nor `required-features`);
//   - no workflow, no package.json script, no tauri config, no CI helper script and no packaging document command turns it on (`qa-secrets` appears nowhere in .github/,
//     package.json, src-tauri/tauri*.conf.json, snap/, flatpak/, msix/ ...) except in the words of the QA kit instructions (docs of this repository's own QA kit: README-QA.md / PACKAGING.md "QA kit" section, which must say "never");
//   - the one place that switches the store is identity.rs (the code outside identity.rs / qasecrets.rs never names the feature or the file).
//   node scripts/test-qa-secrets-off.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './cdp-harness.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

// 1. Cargo.toml: declared, not default
const cargo = read('src-tauri/Cargo.toml');
const feat = cargo.slice(cargo.indexOf('[features]'), cargo.indexOf('[profile.release]'));
const lines = feat.split('\n').filter((l) => /^[A-Za-z0-9_-]+\s*=/.test(l));
ok(lines.some((l) => /^qa-secrets\s*=\s*\[\s*\]/.test(l)), 'qa-secrets is declared as a feature with no dependencies');
for (const l of lines) {
  if (/^qa-secrets\s*=/.test(l)) continue;
  ok(!/qa-secrets/.test(l), `no other feature turns qa-secrets on: ${l}`);
}
const def = lines.find((l) => /^default\s*=/.test(l));
ok(!def || !/qa-secrets/.test(def), `qa-secrets is not a default feature: ${def}`);
ok(!/required-features/.test(cargo), 'no target requires features');
ok(!/features\s*=\s*\[[^\]]*qa-secrets/.test(cargo.replace(feat, '')), 'no dependency section or other crate enables it');

// 2. nothing that builds a release names it
const forbidden = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!['node_modules', 'target', '.git'].includes(e.name)) walk(rel); continue; }
    if (/\.(ya?ml|json|toml|cjs|mjs|js|sh|ps1|cmd|bat|rb|py)$/i.test(e.name) || e.name === 'Makefile') {
      if (rel === 'scripts/test-qa-secrets-off.mjs') continue;
      if (/qa-secrets/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) forbidden.push(rel);
    }
  }
};
for (const d of ['.github', 'scripts']) walk(d);
for (const f of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/build.rs']) if (fs.existsSync(path.join(ROOT, f)) && /qa-secrets/.test(read(f))) forbidden.push(f);
for (const f of fs.readdirSync(path.join(ROOT, 'src-tauri'))) if (/^tauri.*\.conf\.json$/.test(f) && /qa-secrets/.test(read(`src-tauri/${f}`))) forbidden.push(`src-tauri/${f}`);
for (const d of ['snap', 'flatpak', 'msix', 'packaging']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
ok(forbidden.length === 0, `these files name qa-secrets, which only a hand-built QA kit may use: ${forbidden.join(', ')}`);

// 3. the workflows' build commands: any `tauri build` / `cargo build` / `--features` has no qa-secrets (the check above already covers the word; this one names the commands for the message)
for (const f of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
  const t = read(`.github/workflows/${f}`);
  for (const m of t.matchAll(/(tauri build|cargo build|cargo tauri build)[^\n]*/g)) ok(!/qa-secrets/.test(m[0]), `${f}: ${m[0]}`);
}

// 4. one switch: only identity.rs and qasecrets.rs (and the module line and the one init call in lib.rs) know about it
for (const f of fs.readdirSync(path.join(ROOT, 'src-tauri/src'), { recursive: true })) {
  if (!String(f).endsWith('.rs')) continue;
  const rel = String(f).replace(/\\/g, '/');
  if (['identity.rs', 'qasecrets.rs', 'lib.rs'].includes(rel)) continue;
  const t = read(`src-tauri/src/${rel}`);
  ok(!/qa-secrets|qasecrets/.test(t), `${rel} must not know which credential store is in use`);
}
const lib = read('src-tauri/src/lib.rs');
ok((lib.match(/qa-secrets/g) || []).length === 1 && (lib.match(/qasecrets/g) || []).length === 1 && (lib.match(/init_qa_store/g) || []).length === 1, 'lib.rs: one cfg line for the module and one init call');
const ident = read('src-tauri/src/identity.rs');
ok(/fn entry_in\(/.test(ident) && /feature = "qa-secrets"/.test(ident), 'identity.rs holds the switch');

console.log(`test-qa-secrets-off: ok (${checks} checks)`);
