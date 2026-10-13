// Reads the PE "Subsystem" of a Windows executable. A release app must be a GUI program (2): with the console subsystem (3) Windows opens
// a black console window next to the app. Debug builds are console programs by Tauri's design.
//   node check-pe-subsystem.cjs <exe> [--expect gui|console]     exit 0 = as expected (or just printed), 1 = other, 2 = not a PE file
//   node check-pe-subsystem.cjs --selftest                        checks the reader on synthetic headers
const fs = require("fs");

const NAMES = { 1: "native", 2: "gui", 3: "console", 9: "windows-ce-gui" };

/** The subsystem number of a PE image, or null when the buffer is not one. */
function subsystemOf(buf) {
  if (buf.length < 0x40 || buf.toString("latin1", 0, 2) !== "MZ") return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 + 70 > buf.length || buf.toString("latin1", pe, pe + 4) !== "PE\0\0") return null;
  const optional = pe + 24; // after the 4-byte signature and the 20-byte file header
  const magic = buf.readUInt16LE(optional); // 0x10b = PE32, 0x20b = PE32+
  if (magic !== 0x10b && magic !== 0x20b) return null;
  return buf.readUInt16LE(optional + 68); // Subsystem sits at the same offset in both
}

function fakePe(subsystem, magic = 0x20b) {
  const buf = Buffer.alloc(0x200);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(magic, 0x80 + 24);
  buf.writeUInt16LE(subsystem, 0x80 + 24 + 68);
  return buf;
}

function selftest() {
  let bad = 0;
  const is = (name, got, want) => {
    if (got === want) console.log(`ok    ${name}`);
    else {
      console.log(`FAIL  ${name}: got ${got}, wanted ${want}`);
      bad++;
    }
  };
  is("PE32+ GUI", subsystemOf(fakePe(2)), 2);
  is("PE32+ console", subsystemOf(fakePe(3)), 3);
  is("PE32 GUI", subsystemOf(fakePe(2, 0x10b)), 2);
  is("not a PE file", subsystemOf(Buffer.from("hello world, this is not an executable at all, just text")), null);
  is("truncated", subsystemOf(fakePe(2).subarray(0, 0x90)), null);
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) selftest();
const file = args.find((a) => !a.startsWith("--"));
const expectIdx = args.indexOf("--expect");
const expect = expectIdx >= 0 ? args[expectIdx + 1] : null;
if (!file) {
  console.error("usage: check-pe-subsystem.cjs <exe> [--expect gui|console] | --selftest");
  process.exit(2);
}
const sub = subsystemOf(fs.readFileSync(file));
if (sub === null) {
  console.error(`${file} is not a Windows executable`);
  process.exit(2);
}
const name = NAMES[sub] || `unknown(${sub})`;
console.log(`${file}: subsystem ${sub} (${name})`);
if (expect && name !== expect) {
  console.error(`::error::${file} has the ${name} subsystem, expected ${expect}${expect === "gui" ? ": a console window would open next to the app" : ""}`);
  process.exit(1);
}
