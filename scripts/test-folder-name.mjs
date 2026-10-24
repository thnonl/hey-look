// W6.8 (2.6, AC-2.6.1): the texts that say where a file went name the FOLDER, not the whole path, for Windows, POSIX, UNC and root paths.
// Run: node --experimental-strip-types scripts/test-folder-name.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { folderNameOf, savedFolderName } from "../src/attachName.ts";

// the folder of the setting
const folders = [
  ["E:\\QA\\v107 saves", "v107 saves"],
  ["E:\\QA\\v107 saves\\", "v107 saves"],
  ["E:\\QA\\v107 saves\\\\", "v107 saves"],
  ["D:\\", "D:"],
  ["D:", "D:"],
  ["C:\\Users\\Nam Thai\\Downloads", "Downloads"],
  ["\\\\srv\\share\\x", "x"],
  ["\\\\srv\\share", "share"],
  ["/home/nam/Downloads", "Downloads"],
  ["/home/nam/Downloads/", "Downloads"],
  ["/Users/nam/My Files", "My Files"],
  ["/", "/"],
  ["\\", "/"],
  ["  /tmp/a b  ", "a b"],
  ["mixed/slashes\\here", "here"],
  ["", ""],
];
for (const [path, want] of folders) assert.equal(folderNameOf(path), want, JSON.stringify(path));

// the folder a saved FILE went to: its parent
const saved = [
  ["E:\\QA\\v107 saves\\a.pdf", "v107 saves"],
  ["D:\\a.pdf", "D:"],
  ["\\\\srv\\share\\x\\a.pdf", "x"],
  ["\\\\srv\\share\\a.pdf", "share"],
  ["/home/nam/Downloads/a.pdf", "Downloads"],
  ["/a.pdf", "/"],
  ["a.pdf", ""],
];
for (const [path, want] of saved) assert.equal(savedFolderName(path), want, JSON.stringify(path));

// never the whole path
for (const [path] of folders) if (path.trim().length > 3) assert.ok(!/[\\/]/.test(folderNameOf(path)) || folderNameOf(path) === "/", path);

// the wiring: no component splits a path itself any more
for (const f of ["Attachments.tsx", "ReadingPane.tsx"]) {
  const src = readFileSync(new URL("../src/components/" + f, import.meta.url), "utf8");
  assert.ok(!/\.split\(\/\[\\\\\/\]\/\)\.filter\(Boolean\)\.pop\(\)/.test(src), f + " still takes a folder name by hand");
  assert.ok(/folderNameOf|savedFolderName/.test(src), f);
}
console.log("folder-name ok");
