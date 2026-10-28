#!/usr/bin/env node
// The Rust half of the local gate: CI (release.yml, jobs "Rust tests" on Linux and Windows) compiles and tests src-tauri with RUSTFLAGS="-D warnings", so a warning of this crate (an unused
// function, an unused import) fails the dry run although `cargo test` passes on a developer's machine. This runs the same compile locally, for the default features and for the QA feature
// sets of the kits, in a target folder of its own (a changed RUSTFLAGS makes cargo build everything again, so it never shares the normal one).
//   node scripts/check-rust-warnings.mjs [--test]     --test also runs `cargo test --locked` (what CI runs) for the default features
// Set CARGO_TARGET_DIR to choose the folder (default: src-tauri/target/warnings, ignored by git).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './cdp-harness.mjs';

const dir = path.join(ROOT, 'src-tauri');
const env = { ...process.env, RUSTFLAGS: '-D warnings', CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(ROOT, 'src-tauri', 'target', 'warnings') };
const run = (args) => {
  console.log(`> cargo ${args.join(' ')}   (RUSTFLAGS="-D warnings")`);
  const r = spawnSync('cargo', args, { cwd: dir, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`check-rust-warnings: FAILED: cargo ${args.join(' ')}`); process.exit(r.status || 1); }
};
run(['check', '--locked', '--lib', '--tests']);
run(['check', '--locked', '--lib', '--tests', '--features', 'gui-subsystem,qa-secrets']);
run(['check', '--locked', '--lib', '--tests', '--features', 'qa-secrets']);
if (process.argv.includes('--test')) run(['test', '--locked']);
console.log('check-rust-warnings: ok');
