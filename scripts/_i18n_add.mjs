// scratch tool of the WP6 coder (not committed): add / replace texts in the 8 dictionaries from a JSON spec.
// node scripts/_i18n_add.mjs <spec.json>
// spec: { area: "backend", after: "backend.FOLDER_NOT_CREATED" | null, add: { key: {en,vi,fr,zh-Hans,es,ja,de,ru} }, replace: { key: {...} } }
import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const LANGS = ["en", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
const file = (lang) => (lang === "en" ? `src/i18n/ns/${spec.area}.ts` : `src/i18n/locales/${lang}/${spec.area}.ts`);
const NB = " ";
const fix = (lang, text) => (lang === "fr" ? text.replace(/ ([:?!;»])/gu, `${NB}$1`).replace(/(«) /gu, `$1${NB}`) : text);
const q = (s) => JSON.stringify(s);
for (const lang of LANGS) {
  const f = file(lang);
  let lines = fs.readFileSync(f, "utf8").split("\n");
  const indent = (lines.find((l) => /^\s+"[a-zA-Z0-9_.]+":/.test(l)) ?? "  \"x\"").match(/^\s*/)[0];
  for (const [key, texts] of Object.entries(spec.replace ?? {})) {
    const i = lines.findIndex((l) => l.trimStart().startsWith(`${q(key)}:`));
    if (i < 0) throw new Error(`${f}: no ${key} to replace`);
    lines[i] = `${indent}${q(key)}: ${q(fix(lang, texts[lang]))},`;
  }
  const add = Object.entries(spec.add ?? {});
  if (add.length) {
    for (const [key] of add) if (lines.some((l) => l.trimStart().startsWith(`${q(key)}:`))) throw new Error(`${f}: ${key} exists`);
    const block = add.map(([key, texts]) => {
      if (!texts[lang]) throw new Error(`${key}: no text for ${lang}`);
      return `${indent}${q(key)}: ${q(fix(lang, texts[lang]))},`;
    });
    let at = spec.after ? lines.findIndex((l) => l.trimStart().startsWith(`${q(spec.after)}:`)) : -1;
    if (spec.after && at < 0) throw new Error(`${f}: anchor ${spec.after} missing`);
    if (at < 0) {
      // before the closing of the (last) block
      at = lines.map((l, i) => [l, i]).filter(([l]) => /^\s+"[a-zA-Z0-9_.]+":/.test(l)).pop()[1];
    }
    lines.splice(at + 1, 0, ...block);
  }
  fs.writeFileSync(f, lines.join("\n"));
}
console.log("done");
