// The toolbar under a picture in the compose body (F-26: "Alt text" and "As attachment" were drawn on top of each other). Cause: the
// "no alt text yet" marker was the generic `.dot` class (width 9px, flex: none), so the Alt text button was 9 px wide and its label ran
// over the next button. Now: a scoped `no-alt` marker, a wrapping toolbar that is never wider than the pane, a placement that is measured
// (pictureToolsLayout.ts) and keeps all of it inside the pane, Tab order sizes -> alt text -> as attachment -> delete, Esc back to the editor.
// Source check of src/components/Compose.tsx and src/App.css plus the pure placement rules (the real layout was checked in the dev mock
// at 960x560, 1280x720, 1740x900 in all 8 languages, light and dark). Run: node --experimental-strip-types scripts/test-picture-tools.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { placePictureTools } from "../src/pictureToolsLayout.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tsx = read("../src/components/Compose.tsx");
const css = read("../src/App.css");

// 1. the markup: one toolbar, items in the Tab order sizes, alt text, as attachment, delete; no generic `.dot` on a button
const bar = tsx.slice(tsx.indexOf('<div className="img-tools" role="toolbar"'), tsx.indexOf('{altOpen && ('));
const order = ['role="radiogroup"', 'compose.pic.altText', 'compose.pic.asAttachment', 'compose.pic.remove'].map((k) => bar.indexOf(k));
assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `toolbar order ${order}`);
assert.doesNotMatch(bar, /\bdot\b/, "the generic .dot class (9 px wide, flex: none) must not be on a toolbar button");
assert.match(bar, /"no-alt"/);
assert.ok(!bar.includes("tabIndex"), "every toolbar item stays a Tab stop");
assert.match(tsx, /aria-label=\{t\("compose\.pic\.options"\)\}/, "the toolbar keeps its aria label");
assert.match(tsx, /aria-label=\{t\("compose\.pic\.remove"\)\}/, "the icon button keeps its aria label");
// Esc leaves the toolbar / the alt text popover and returns to the editor
const esc = tsx.slice(tsx.indexOf('className="img-tools-anchor"'), tsx.indexOf('<div className="img-tools-box">'));
assert.match(esc, /e\.key !== "Escape"/);
assert.match(esc, /setAltOpen\(false\);\s*editor\?\.commands\.focus\(\)/);

// 2. the CSS: the toolbar wraps, its items do not shrink, it is never wider than the pane, the alt popover hangs under it
assert.match(css, /\.img-tools \{[^}]*flex-wrap: wrap;/, "the toolbar wraps to a second row");
assert.match(css, /\.img-tools > \* \{[^}]*flex: none;[^}]*white-space: nowrap;/, "items keep their width and their label on one line");
assert.match(css, /\.img-tools-box \{[^}]*max-width: calc\(100% - 16px\);/, "never wider than the pane");
assert.match(css, /\.alt-pop \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 4px\);/, "the alt text popover opens under the toolbar, not at a fixed offset");
assert.match(css, /\.img-tools \.tool-btn\.no-alt::after \{/, "the marker is scoped to the toolbar");
assert.doesNotMatch(css, /\.img-tools \{[^}]*position: absolute;/, "the toolbar itself is not positioned by a fixed top/left any more");

// 3. placement (pane 600 x 400; the toolbar is 420 x 34, or 280 x 66 when it wraps)
const base = { imgLeft: 20, imgWidth: 300, imgTop: 100, imgBottom: 300, scrollTop: 0, paneWidth: 600, paneHeight: 400, width: 420, height: 34 };
const at = (o) => placePictureTools({ ...base, ...o });
// above the picture, centred on it
assert.deepEqual(at({}), { left: 8, top: 100 - 6 - 34 }, "centre would be at -40: back inside the pane");
assert.deepEqual(at({ imgLeft: 200 }), { left: 200 + 150 - 210, top: 60 });
// no room above: below
assert.equal(at({ imgTop: 20, imgBottom: 120 }).top, 126);
// a taller (wrapped) toolbar needs more room above than a single row
assert.equal(at({ imgTop: 60, height: 66 }).top, 300 + 6, "66 px toolbar does not fit above a picture 60 px from the top: goes below");
assert.equal(at({ imgTop: 60, height: 34 }).top, 20, "a single row still fits above it");
// neither above nor below fits (a picture taller than the pane): over its visible part
assert.equal(at({ imgTop: 20, imgBottom: 900, scrollTop: 150 }).top, 156);
// a pane shorter than the toolbar: under the picture (scrolling reaches it), never pinned where half of it is cut off
assert.equal(at({ imgTop: 0, imgBottom: 500, paneHeight: 40, height: 66 }).top, 506);
// sideways: always inside the pane with 8 px to spare
for (const imgLeft of [-300, 0, 20, 300, 450, 590, 900]) for (const width of [280, 420, 556, 700]) {
  const { left } = at({ imgLeft, width });
  assert.ok(left >= 8, `left edge (${imgLeft}, ${width}): ${left}`);
  assert.ok(left + width <= 600 - 8 || left === 8, `right edge (${imgLeft}, ${width}): ${left}`);
}
// picture on the right side of the pane: moved back from the edge
assert.equal(at({ imgLeft: 500, imgWidth: 300 }).left, 600 - 8 - 420);
// a wide picture: centred on its first 360 px, not on the whole width
assert.equal(at({ imgLeft: 100, imgWidth: 2000, paneWidth: 1200 }).left, 100 + 180 - 210);
console.log("ok - test-picture-tools");
