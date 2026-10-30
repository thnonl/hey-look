#!/usr/bin/env node
// CI compiles the Rust crate with RUSTFLAGS="-D warnings" (release.yml, "Rust tests" on Linux and Windows); a dead function that `cargo test` only warns about on a developer's machine failed the
// dry run of 1.0.10. The local gate has the same compile: scripts/check-rust-warnings.mjs (the default features and the QA feature sets). This test keeps the three in step: the workflow still
// denies warnings in both jobs, the script uses the same flag and the feature sets of the QA kits, and CONTRIBUTING names the script in the release steps.
//   node scripts/test-rust-warnings-gate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './cdp-harness.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const wf = read('.github/workflows/release.yml');
assert.equal((wf.match(/RUSTFLAGS:\s*"-D warnings"/g) || []).length, 2, 'both Rust test jobs of the workflow deny warnings');
const sc = read('scripts/check-rust-warnings.mjs');
assert.ok(/RUSTFLAGS: '-D warnings'/.test(sc), 'the local script uses the same flag');
for (const f of ["'--features', 'gui-subsystem,qa-secrets'", "'--features', 'qa-secrets'"]) assert.ok(sc.includes(f), `the local script also checks ${f}`);
assert.ok(/'check', '--locked', '--lib'\]/.test(sc), 'the library is also compiled without the tests (what only the tests or one OS use is dead there)');
assert.ok(/'test', '--locked'/.test(sc), 'and can run the tests the way CI does');
assert.ok(/check-rust-warnings\.mjs/.test(read('CONTRIBUTING.md')), 'CONTRIBUTING names the script in the release steps');
console.log('test-rust-warnings-gate: ok');
