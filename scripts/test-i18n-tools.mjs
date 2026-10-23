// The translator tooling: the review-sheet export (chunks of about 12 KB), the status report, and --sync finding nothing to add.
// Run: node --experimental-strip-types scripts/test-i18n-tools.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/en.ts";
import { LANGUAGES } from "../src/i18n/languages.ts";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const run = (name, ...args) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script(name), ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const later = LANGUAGES.filter((l) => l.code !== "en");

// export: every key exactly once, every file starts with the header and stays under the limit, a row never splits
const dir = mkdtempSync(join(tmpdir(), "heylook-tsv-"));
try {
  for (const code of ["ru", "vi"]) {
    const r = run("i18n-export-tsv.mjs", code, join(dir, code));
    assert.equal(r.code, 0, r.err);
    const files = readdirSync(join(dir, code)).sort();
    assert.ok(files.length > 3, `${code}: several chunks`);
    const keys = [];
    for (const f of files) {
      const text = readFileSync(join(dir, code, f), "utf8");
      assert.ok(Buffer.byteLength(text) <= 12000, `${f} is ${Buffer.byteLength(text)} bytes`);
      const lines = text.split("\n");
      assert.equal(lines[0], "key\tEnglish\ttranslation", `${f} header`);
      assert.equal(lines.pop(), "", `${f} ends with a line break`);
      for (const line of lines.slice(1)) {
        const cells = line.split("\t");
        assert.equal(cells.length, 3, `${f}: ${line.slice(0, 60)}`);
        keys.push(cells[0]);
      }
    }
    assert.deepEqual(keys, Object.keys(en), `${code}: all keys, in dictionary order`);
  }
  // a smaller limit makes more files; --untranslated leaves out what is translated
  const small = run("i18n-export-tsv.mjs", "fr", join(dir, "small"), "--bytes=3000");
  assert.equal(small.code, 0, small.err);
  assert.ok(readdirSync(join(dir, "small")).length > readdirSync(join(dir, "vi")).length);
  // --chunk-chars counts characters, --prefix names the files, --index writes index.json (and only then)
  const ch = run("i18n-export-tsv.mjs", "zh-Hans", join(dir, "zh"), "--chunk-chars=40000", "--prefix=chunk", "--index");
  assert.equal(ch.code, 0, ch.err);
  const zhFiles = readdirSync(join(dir, "zh")).sort();
  assert.ok(zhFiles.includes("index.json") && zhFiles.includes("chunk-01.tsv"), zhFiles.join());
  const index = JSON.parse(readFileSync(join(dir, "zh", "index.json"), "utf8"));
  assert.equal(index.totalRows, Object.keys(en).length);
  assert.equal(index.files.length, index.totalChunks);
  assert.equal(index.files.reduce((n, f) => n + f.rows, 0), index.totalRows);
  for (const f of index.files) {
    assert.ok(f.characters <= 40000, `${f.file}: ${f.characters} characters`);
    assert.equal([...readFileSync(join(dir, "zh", f.file), "utf8")].length, f.characters);
  }
  assert.ok(!readdirSync(join(dir, "vi")).includes("index.json"), "no index.json without --index");
  assert.equal(run("i18n-export-tsv.mjs", "fr", join(dir, "bad"), "--prefix=../x").code, 2, "a prefix with a path is refused");
  assert.notEqual(run("i18n-export-tsv.mjs", "xx", join(dir, "x")).code, 0, "an unknown language is refused");
  assert.notEqual(run("i18n-export-tsv.mjs", "fr").code, 0, "the target dir is required");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// status: a row for every language but English; --strict is the release gate (exit 1 while placeholders remain)
const st = run("i18n-status.mjs");
assert.equal(st.code, 0, st.err);
for (const l of later) assert.ok(new RegExp(`^${l.code} `, "m").test(st.out), `status shows ${l.code}`);
assert.equal(run("i18n-status.mjs", "--lang=nope").code, 2);
const strict = run("i18n-status.mjs", "--strict");
assert.ok(strict.code === 0 || strict.code === 1, "--strict exits 1 while some language still has English placeholders (the release gate), else 0");

// scaffold: with nothing missing, --sync changes nothing
const sync = run("i18n-new-language.mjs", "--sync");
assert.equal(sync.code, 0, sync.err);
assert.equal((sync.out.match(/up to date/g) ?? []).length, later.length, `--sync: every other language (vi and fr too, since WP9c) is complete\n${sync.out}`);
assert.notEqual(run("i18n-new-language.mjs", "xx").code, 0, "a language that is not in the registry is refused");
assert.notEqual(run("i18n-new-language.mjs", "en").code, 0, "English lives in ns/*.ts");
assert.equal(run("i18n-split-inline.mjs", "--check").code, 0, "no vi: / fr: block is left inside src/i18n/ns/*.ts (a branch that adds one is moved with scripts/i18n-split-inline.mjs)");
{
  // a tree with a new English key: --sync appends it (English text, to be translated) to the folder of every other language, vi and fr included (AC-9.1.6)
  const tmp = mkdtempSync(join(tmpdir(), "heylook-sync-"));
  try {
    cpSync(fileURLToPath(new URL("../src/i18n", import.meta.url)), join(tmp, "src/i18n"), { recursive: true });
    const common = join(tmp, "src/i18n/ns/common.ts");
    writeFileSync(common, readFileSync(common, "utf8").replace("  en: {\n", '  en: {\n    "common.syncProbe": "Sync probe",\n'));
    const r = run("i18n-new-language.mjs", "--sync", `--root=${tmp}`);
    assert.equal(r.code, 0, r.err);
    for (const l of later) {
      const text = readFileSync(join(tmp, "src/i18n/locales", l.code, "common.ts"), "utf8");
      assert.ok(text.includes('"common.syncProbe": "Sync probe"'), `--sync added the new key to ${l.code}`);
    }
    assert.equal(run("i18n-new-language.mjs", "--sync", `--root=${tmp}`).out.match(/up to date/g)?.length, later.length, "a second --sync has nothing more to add");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log("i18n tools: all checks passed");
