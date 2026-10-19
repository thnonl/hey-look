// Release guards for the repo files.
//   node verify-version.cjs <version|-> [repoRoot] [--pubkey=error|warn|skip]
// <version>: fails unless package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml ([package] version) all equal it
//            ("-" skips this check), and linux/io.github.thnonl.HeyLook.metainfo.xml's FIRST <release> (the snap's version, what the
//            software centres show as the newest) equals it too.
// --pubkey:  src-tauri/tauri.conf.json plugins.updater.pubkey must not be empty (error = fail, warn = warning only, skip = no check).
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const [want, root = "."] = argv.filter((a) => !a.startsWith("--"));
const pubkeyMode = (flags.find((f) => f.startsWith("--pubkey=")) || "--pubkey=skip").split("=")[1];
if (!want) {
  console.error("usage: verify-version.cjs <version|-> [repoRoot] [--pubkey=error|warn|skip]");
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

// The version of the first <release> that is not inside a comment (the newest; adopt-info takes it as the snap's version).
const firstRelease = (xml) => {
  const m = /<release\s+version="([^"]*)"/.exec(xml.replace(/<!--[\s\S]*?-->/g, ""));
  return m ? m[1] : "(no <release>)";
};

let bad = 0;
if (want !== "-") {
  const found = {
    "package.json": JSON.parse(read("package.json")).version,
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
    "src-tauri/Cargo.toml": cargoPackageVersion(read("src-tauri/Cargo.toml")),
    "linux/io.github.thnonl.HeyLook.metainfo.xml": firstRelease(read("linux/io.github.thnonl.HeyLook.metainfo.xml")),
  };
  for (const [file, v] of Object.entries(found)) {
    if (v !== want) {
      console.error(`::error file=${file}::${file} says ${v}, the tag says ${want}`);
      bad++;
    } else {
      console.log(`ok  ${file} = ${v}`);
    }
  }
}

if (pubkeyMode !== "skip") {
  const pub = (JSON.parse(read("src-tauri/tauri.conf.json")).plugins?.updater?.pubkey || "").trim();
  if (!pub) {
    const msg = "src-tauri/tauri.conf.json plugins.updater.pubkey is empty: the app could not verify updates";
    if (pubkeyMode === "error") {
      console.error(`::error file=src-tauri/tauri.conf.json::${msg}`);
      bad++;
    } else {
      console.warn(`::warning file=src-tauri/tauri.conf.json::${msg}`);
    }
  } else {
    console.log("ok  updater pubkey is set");
  }
}
process.exit(bad ? 1 : 0);
