// Sets the app version in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml ([package] version).
// Only for test builds (the 0.9.0 updater test build): the result is never committed.
// Usage: node set-version.cjs 0.9.0 [repoRoot]
const fs = require("fs");
const path = require("path");

const version = process.argv[2];
const root = process.argv[3] || ".";
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: set-version.cjs <x.y.z> [repoRoot]");
  process.exit(2);
}
const file = (f) => path.join(root, f);

for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const j = JSON.parse(fs.readFileSync(file(f), "utf8"));
  j.version = version;
  fs.writeFileSync(file(f), JSON.stringify(j, null, 2) + "\n");
}

const cargo = fs.readFileSync(file("src-tauri/Cargo.toml"), "utf8").split("\n");
let inPackage = false;
let done = false;
for (let i = 0; i < cargo.length; i++) {
  const t = cargo[i].trim();
  if (t.startsWith("[")) inPackage = t === "[package]";
  else if (inPackage && !done && /^version\s*=\s*"/.test(t)) {
    cargo[i] = cargo[i].replace(/"[^"]*"/, `"${version}"`);
    done = true;
  }
}
if (!done) {
  console.error("no [package] version found in Cargo.toml");
  process.exit(1);
}
fs.writeFileSync(file("src-tauri/Cargo.toml"), cargo.join("\n"));
console.log(`version set to ${version}`);
