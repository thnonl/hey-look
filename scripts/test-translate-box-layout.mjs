// The "Translating to ..." box in the reading pane: a long translated sentence (German: "Wird in Japanisch übersetzt…") was squeezed to
// three lines beside the ring, the timer and Cancel in a 236 px card. The sentence now sits with the ring in one group that keeps a
// readable width (flex-basis in em) and shrinks only after the timer + Cancel group has dropped to its own line. Source check of
// src/components/ReadingPane.tsx and src/App.css (the real layout was checked in the dev mock at 960x560 and 1280x720: en de ja ru).
// Run: node --experimental-strip-types scripts/test-translate-box-layout.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tsx = read("../src/components/ReadingPane.tsx");
const css = read("../src/App.css");

const running = tsx.slice(tsx.indexOf("if (running)"), tsx.indexOf('if (job.status === "failed")'));
assert.match(running, /<span className="tr-main">[\s\S]*busy-ring[\s\S]*tr-text[\s\S]*<\/span>\s*<span className="tr-side">[\s\S]*tr-time[\s\S]*cancelTranslation[\s\S]*<\/span>/, "ring + sentence in .tr-main, timer + Cancel in .tr-side");
assert.match(css, /\.tr-row \{[^}]*flex-wrap: wrap;/, "the row wraps");
assert.match(css, /\.tr-main \{[^}]*flex: 1 1 \d+(\.\d+)?em;[^}]*min-width: 0;/, "the sentence group keeps a readable basis and may shrink");
assert.match(css, /\.tr-side \{[^}]*margin-left: auto;/, "timer + Cancel stay together, at the end of the row");
assert.doesNotMatch(css, /\.tr-row \.tr-text \{[^}]*flex: 1 1 /, "the sentence alone is not a wrapping item (it would leave the ring on a line of its own)");
console.log("ok - test-translate-box-layout");
