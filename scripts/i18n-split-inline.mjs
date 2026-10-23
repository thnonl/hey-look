// One-off migration (WP9c, 1.0.7): Vietnamese and French leave src/i18n/ns/<area>.ts and get their own folders, like the other five languages:
//   src/i18n/locales/vi/<area>.ts, src/i18n/locales/fr/<area>.ts   (typed: `defineLocale<typeof ns.en>({...})`, a missing or extra key fails `tsc`)
//   src/i18n/locales/<code>/index.ts, keep.json                    (the vi / fr lists of src/i18n/ns/keep.json)
// and src/i18n/ns/<area>.ts keeps English only. src/i18n/vi.ts and fr.ts are removed.
//
//   node scripts/i18n-split-inline.mjs          do it
//   node scripts/i18n-split-inline.mjs --check  change nothing; exit 1 when a `vi:` / `fr:` block is still inside an ns/ file
//
// Idempotent. On a tree that is already split it changes nothing. After merging a branch that still added `vi` / `fr` text in ns/<area>.ts
// it moves those blocks too: a key the locale file does not have yet is appended to it, a key that has a different text there is reported
// and the locale file wins (the translation in locales/ is the agreed one). Comments next to keys move with them.
// Stays in scripts/ for the 1.0.7 cycle.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const NS = join(root, "src/i18n/ns");
const LOC = join(root, "src/i18n/locales");
const CODES = ["vi", "fr"];
const NAMES = { vi: "Vietnamese", fr: "French" };
const check = process.argv.includes("--check");

const eol = (s) => s.replace(/\r\n/g, "\n");
const lines = (s) => eol(s).replace(/\n$/, "").split("\n");

/** The `  <code>: {` ... `  },` blocks of the namespace file: { code: [start, end] } as line indexes (the opening and the closing line). */
function blocks(ls) {
  const out = {};
  for (const code of ["en", ...CODES]) {
    const start = ls.findIndex((l) => l === `  ${code}: {`);
    if (start < 0) continue;
    let end = start + 1;
    while (end < ls.length && ls[end] !== "  },") end++;
    if (end >= ls.length) throw new Error(`no closing "  }," for ${code}`);
    out[code] = [start, end];
  }
  return out;
}

/** Entries of a block body: [{ key, text }] where text holds the comment lines above the key and the key's own lines (indent 4). */
function entries(body) {
  const out = [];
  let pending = [];
  let cur = null;
  const keyRe = /^ {4}"([^"]+)":/;
  for (const l of body) {
    const m = keyRe.exec(l);
    if (m) {
      cur = { key: m[1], lines: [...pending, l] };
      pending = [];
      out.push(cur);
    } else if (/^ {4}\/\//.test(l) || l.trim() === "") {
      cur = null; // a comment or an empty line belongs to the next key
      pending.push(l);
    } else if (cur) cur.lines.push(l); // a continuation of a multi-line value
    else pending.push(l);
  }
  return { entries: out, tail: pending };
}

const dedent = (ls) => ls.map((l) => (l.startsWith("  ") ? l.slice(2) : l));
const stripEnds = (ls) => {
  let a = 0;
  let b = ls.length;
  while (a < b && ls[a].trim() === "") a++;
  while (b > a && ls[b - 1].trim() === "") b--;
  return ls.slice(a, b);
};

/** The comment lines between the import line and `export default` of a namespace file. */
function headerOf(ls) {
  const exp = ls.findIndex((l) => l.startsWith("export default"));
  const head = ls.slice(0, exp).filter((l) => !l.startsWith("import "));
  return stripEnds(head);
}

function localeFile(area, header, bodyLines) {
  const parts = ['import { defineLocale } from "../../types.ts";', `import type ns from "../../ns/${area}.ts";`, ""];
  if (header.length) parts.push(...header, "");
  parts.push("export default defineLocale<typeof ns.en>({", ...bodyLines, "});", "");
  return parts.join("\n");
}

function indexFile(code, areas) {
  const id = code.replace(/-(\w)/g, (_, x) => x.toUpperCase());
  const imports = areas.map((a) => `import ${a} from "./${a}.ts";`).join("\n");
  const spreads = areas.map((a) => `  ...${a},`).join("\n");
  return `// ${NAMES[code]} (${code}): gathers the files of this folder, one per area. A new area added in src/i18n/ns/ needs a line here.
import type { en } from "../../en.ts";
import type { Msg } from "../../types.ts";
${imports}

export const ${id} = {
${spreads}
} satisfies Record<keyof typeof en, Msg>;
`;
}

const areas = readdirSync(NS).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).sort();
let moved = 0;
let appended = 0;
const conflicts = [];
const pendingFiles = [];

for (const area of areas) {
  const nsFile = join(NS, `${area}.ts`);
  const ls = lines(readFileSync(nsFile, "utf8"));
  const bl = blocks(ls);
  const inline = CODES.filter((c) => bl[c]);
  if (!inline.length) continue;
  if (check) {
    console.error(`${nsFile}: still has ${inline.join(", ")} inside`);
    moved += inline.length;
    continue;
  }
  const header = headerOf(ls);
  for (const code of inline) {
    const [s, e] = bl[code];
    const body = stripEnds(ls.slice(s + 1, e));
    const target = join(LOC, code, `${area}.ts`);
    if (!existsSync(target)) {
      pendingFiles.push([target, localeFile(area, header, dedent(body))]);
      moved++;
      continue;
    }
    // the locale file exists (a branch merged after the first run): add the keys it does not have, report the ones that differ
    const have = lines(readFileSync(target, "utf8"));
    const haveKeys = new Map();
    const hb = entries(have.map((l) => (l.startsWith("  ") || l === "" ? `  ${l}` : l)));
    for (const en of hb.entries) haveKeys.set(en.key, en.lines.join("\n").replace(/\n {2}/g, "\n"));
    const add = [];
    for (const en of entries(body.map((l) => l)).entries) {
      const mine = dedent(en.lines).join("\n");
      const theirs = haveKeys.get(en.key);
      if (theirs === undefined) add.push(...dedent(en.lines));
      else if (theirs.trim().replace(/^ +/gm, "") !== mine.trim().replace(/^ +/gm, "")) conflicts.push(`${code}/${area}: ${en.key}`);
    }
    if (add.length) {
      const close = have.lastIndexOf("});");
      have.splice(close, 0, ...add);
      pendingFiles.push([target, have.join("\n") + "\n"]);
      appended += add.length;
    }
  }
  // the namespace file keeps English only: cut from the first vi / fr block to the closing of the last one
  const cutFrom = Math.min(...inline.map((c) => bl[c][0]));
  const cutTo = Math.max(...inline.map((c) => bl[c][1]));
  const kept = [...ls.slice(0, cutFrom), ...ls.slice(cutTo + 1)];
  while (kept.length > 1 && kept[cutFrom - 1] === "") kept.splice(cutFrom - 1, 1); // the empty line that separated the blocks
  pendingFiles.push([nsFile, kept.join("\n") + "\n"]);
}

// keep.json: { vi: [...], fr: [...] } in ns/ -> an array in each locale folder
const nsKeep = join(NS, "keep.json");
if (existsSync(nsKeep) && !check) {
  const j = JSON.parse(readFileSync(nsKeep, "utf8"));
  for (const code of CODES) {
    const f = join(LOC, code, "keep.json");
    const old = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    const all = [...new Set([...old, ...(j[code] ?? [])])];
    pendingFiles.push([f, JSON.stringify(all, null, 2) + "\n"]);
  }
}

if (check) {
  if (moved) process.exit(1);
  console.log("i18n-split-inline: nothing left inside src/i18n/ns/*.ts");
  process.exit(0);
}

for (const code of CODES) {
  const dir = join(LOC, code);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const f = join(dir, "index.ts");
  if (!existsSync(f)) pendingFiles.push([f, indexFile(code, areas)]);
}
for (const [f, text] of pendingFiles) writeFileSync(f, text);
for (const f of [join(NS, "keep.json"), join(root, "src/i18n/vi.ts"), join(root, "src/i18n/fr.ts")]) if (existsSync(f)) rmSync(f);

console.log(`i18n-split-inline: ${moved} block(s) moved, ${appended} line(s) appended to existing files, ${pendingFiles.length} file(s) written`);
if (conflicts.length) {
  console.log(`${conflicts.length} key(s) differ between ns/ and locales/ (locales/ kept):`);
  for (const c of conflicts) console.log("  " + c);
}
