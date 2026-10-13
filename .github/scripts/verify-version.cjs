// Fails unless package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml ([package] version)
// all equal the given version. Usage: node verify-version.cjs 1.0.0 [repoRoot]
const fs = require("fs");
const path = require("path");

const want = process.argv[2];
const root = process.argv[3] || ".";
if (!want) {
  console.error("usage: verify-version.cjs <version> [repoRoot]");
  process.exit(2);
}

const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// version = "x" inside the [package] table only (not a dependency's version).
const cargoPackageVersion = (toml) => {
  let inPackage = false;
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) inPackage = t === "[package]";
    else if (inPackage) {
      const m = /^version\s*=\s*"([^"]*)"/.exec(t);
      if (m) return m[1];
    }
  }
  return "(not found)";
};

const found = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": cargoPackageVersion(read("src-tauri/Cargo.toml")),
};

let bad = 0;
for (const [file, v] of Object.entries(found)) {
  if (v !== want) {
    console.error(`::error file=${file}::${file} says ${v}, the tag says ${want}`);
    bad++;
  } else {
    console.log(`ok  ${file} = ${v}`);
  }
}
process.exit(bad ? 1 : 0);
