// W9.10: an `export` of src/**/*.ts(x) that no other file of src/ or scripts/ names is dead code (or a public name nobody needs). No dependencies.
// Run: node scripts/test-dead-exports.mjs
//
// The scan reads every .ts/.tsx file of src/ (the language dictionaries under src/i18n/ns and src/i18n/locales are data, not code, and are skipped),
// collects the VALUES it exports (`export const|let|var|function|class|enum NAME`, `export { a, b as c }`; `export default` is not a name). A type or an
// interface is not checked: a type that is exported to document the shape of an API costs nothing at run time and is not dead code.
// and looks for each name as a whole word in every OTHER file of src/ (.ts, .tsx, .css, .html) and in every file of scripts/ (the node tests read the sources
// as text and name many functions), and in src-tauri/ (mock names the backend and the page share are not exports, but a doc may name them). A name that
// appears nowhere else is reported. A use inside the same file does not count (an export that is only used where it is written should not be exported).
// ALLOW holds the names that stay on purpose, one reason each. Adding an unused export makes this test fail; so does an ALLOW entry that is used or gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = [path.join('src', 'i18n', 'ns'), path.join('src', 'i18n', 'locales')];

// "file:name" -> reason. Keep this list short and honest.
export const ALLOW = new Map([
]);

const walk = (dir, out = []) => {
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'target' || ent.name === 'dist' || ent.name === '.git') continue;
      walk(rel, out);
    } else out.push(rel);
  }
  return out;
};

const norm = (p) => p.split(path.sep).join('/');
export function scan(read = (f) => fs.readFileSync(path.join(root, f), 'utf8')) {
  const srcFiles = walk('src').filter((f) => /\.(tsx?|css|html)$/.test(f) && !SKIP_DIRS.some((d) => f.startsWith(d + path.sep)));
  const code = srcFiles.filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f));
  const other = [...walk('scripts').filter((f) => !f.endsWith('test-dead-exports.mjs')), ...walk('src-tauri/src').filter((f) => /\.(rs|json)$/.test(f))];
  const texts = new Map();
  for (const f of [...srcFiles, ...other]) {
    try { texts.set(f, read(f)); } catch { /* unreadable: ignored */ }
  }
  const dead = [];
  const names = [];
  for (const f of code) {
    const t = texts.get(f);
    if (!t) continue;
    const add = (n) => { if (n && n !== 'default') names.push([f, n]); };
    for (const m of t.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
    for (const m of t.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/gm)) for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop().trim());
  }
  const used = (name, file) => {
    const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
    for (const [f, t] of texts) {
      if (f === file) continue;
      if (re.test(t)) return true;
    }
    return false;
  };
  for (const [f, n] of names) if (!used(n, f)) dead.push(`${norm(f)}:${n}`);
  return { dead, count: names.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dead, count } = scan();
  const errors = [];
  const allowed = new Set(ALLOW.keys());
  for (const d of dead) if (!allowed.has(d)) errors.push(`unused export: ${d} (remove the export, or the code, or add it to ALLOW with a reason)`);
  for (const a of allowed) if (!dead.includes(a)) errors.push(`ALLOW entry ${a} is used elsewhere or no longer exists: remove it from ALLOW`);
  for (const [k, why] of ALLOW) if (!why || why.length < 10) errors.push(`ALLOW entry ${k} has no reason`);
  // the test can fail: an unused export added to a copy of src/util.ts (in memory) is found; one that another file names is not
  const real = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const withZzz = scan((f) => (f === path.join('src', 'util.ts') ? real(f) + '\nexport const zzzNobodyUsesThis = 1;\n' : real(f))).dead;
  if (!withZzz.includes('src/util.ts:zzzNobodyUsesThis')) errors.push('the scan did not find an unused export added to a copy of src/util.ts');
  const used = scan((f) => (f === path.join('src', 'util.ts') ? real(f) + '\nexport const zzzUsedNow = 1;\n' : f === path.join('scripts', 'check-shards.mjs') ? real(f) + '\n// zzzUsedNow\n' : real(f))).dead;
  if (used.includes('src/util.ts:zzzUsedNow')) errors.push('an export that a script names was reported as unused');
  if (errors.length) { console.error(errors.map((e) => 'FAIL ' + e).join('\n')); process.exit(1); }
  console.log(`ok - test-dead-exports (${count} exports of src/ checked, ${allowed.size} allowed, scan proven on a scratch export)`);
}
