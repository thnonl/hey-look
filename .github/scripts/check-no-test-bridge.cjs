// A release app must not contain the test bridge (debug builds only, src-tauri/src/testbridge/). Searches files, or every file under the
// folders given (a macOS .app), for the name of its environment variable and for the text it logs and the global of its page side.
// Binaries are read as bytes: Rust strings are UTF-8, and the UTF-16 spelling is searched too.
//   node check-no-test-bridge.cjs <file-or-folder>...     exit 0 = none of them has it, 1 = found (or nothing to search), 2 = usage
//   node check-no-test-bridge.cjs --selftest              checks the search on synthetic files
const fs = require("fs");
const os = require("os");
const path = require("path");

// assembled so that this script does not carry the name itself
const NAME = ["HEYLOOK", "TEST", "BRIDGE"].join("_");
// (the fourth is the debug-only switch that pretends a copy is managed by apt or a store, src-tauri/src/update.rs `test_managed`, WP15)
const NEEDLES = [NAME, ["test bridge", " listening"].join(":"), ["__", "hlb"].join(""), ["HEYLOOK", "TEST", "MANAGED"].join("_")];

function variants(s) {
  return [Buffer.from(s, "utf8"), Buffer.from(s, "utf16le")];
}

/** The needles found in a buffer. */
function scan(buf) {
  const found = [];
  for (const n of NEEDLES) if (variants(n).some((v) => buf.includes(v))) found.push(n);
  return found;
}

/** Every regular file under `p` (a file itself, or a folder, followed recursively; links are not followed). */
function* files(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) yield* files(path.join(p, e));
  } else if (st.isFile()) {
    yield p;
  }
}

function check(paths) {
  let searched = 0;
  const hits = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.error(`${p}: does not exist`);
      return { searched: 0, hits: [["", ["missing"]]] };
    }
    for (const f of files(p)) {
      searched++;
      const found = scan(fs.readFileSync(f));
      if (found.length) hits.push([f, found]);
    }
  }
  return { searched, hits };
}

function selftest() {
  let bad = 0;
  const is = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`ok    ${name}`);
    else {
      console.log(`FAIL  ${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
      bad++;
    }
  };
  is("clean bytes", scan(Buffer.from("MZ plain release binary with tauri and mail strings")), []);
  is("the variable name", scan(Buffer.concat([Buffer.from("xx\0"), Buffer.from(NAME), Buffer.from("\0yy")])), [NAME]);
  is("the variable name, UTF-16", scan(Buffer.from("a" + NAME + "b", "utf16le")), [NAME]);
  is("the log text", scan(Buffer.from("..." + NEEDLES[1] + "...")), [NEEDLES[1]]);
  is("the page global", scan(Buffer.from("window." + NEEDLES[2] + ".take")), [NEEDLES[2]]);
  is("the debug-only managed switch", scan(Buffer.from("x" + NEEDLES[3] + "y")), [NEEDLES[3]]);
  is("a prefix is not enough", scan(Buffer.from("HEYLOOK_TEST_QUIT_PAGE HEYLOOK_TEST_START_FAIL")), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nobridge-"));
  try {
    fs.mkdirSync(path.join(dir, "app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "Contents", "MacOS", "hey-look"), "clean");
    fs.writeFileSync(path.join(dir, "clean.exe"), "clean");
    is("a clean folder and file", check([path.join(dir, "app"), path.join(dir, "clean.exe")]).hits, []);
    fs.writeFileSync(path.join(dir, "app", "Contents", "MacOS", "other"), "x" + NAME);
    const r = check([path.join(dir, "app")]);
    is("a folder with a dirty file", r.hits.map(([f, n]) => [path.basename(f), n]), [["other", [NAME]]]);
    is("both files were searched", r.searched, 2);
    is("a missing path fails", check([path.join(dir, "nope")]).hits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) selftest();
if (!args.length) {
  console.error("usage: check-no-test-bridge.cjs <file-or-folder>... | --selftest");
  process.exit(2);
}
const { searched, hits } = check(args);
if (hits.length) {
  for (const [f, found] of hits) console.error(`FOUND in ${f}: ${found.join(", ")}`);
  console.error("a release build contains debug-only test code (the test bridge or HEYLOOK_TEST_MANAGED)");
  process.exit(1);
}
if (!searched) {
  console.error("nothing was searched: no file under the given paths");
  process.exit(1);
}
console.log(`no test bridge in ${searched} file(s): ${args.join(" ")}`);
