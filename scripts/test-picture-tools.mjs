// The toolbar under a picture in the compose body (F-26: "Alt text" and "As attachment" were drawn on top of each other). Cause: the
// "no alt text yet" marker was the generic `.dot` class (width 9px, flex: none), so the Alt text button was 9 px wide and its label ran
// over the next button. Now: a scoped `no-alt` marker, a wrapping toolbar that is never wider than the pane, a placement that is measured
// (pictureToolsLayout.ts) and keeps all of it inside the pane, the order sizes -> alt text -> as attachment -> delete, Esc back to the editor.
// Since 1.0.7 (W2.15, W2.18) the toolbar is src/editor/PictureTools.tsx, one component for the message and the signature / template editor, and ONE Tab stop with a
// roving tabindex (the keys are checked in the browser: scripts/test-editor-a11y.mjs).
// Source check of src/editor/PictureTools.tsx and src/App.css plus the pure placement rules (the real layout was checked in the dev mock
// at 960x560, 1280x720, 1740x900 in all 8 languages, light and dark). Run: node --experimental-strip-types scripts/test-picture-tools.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HANDLE_ZONE, placePictureTools } from "../src/pictureToolsLayout.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tsx = read("../src/editor/PictureTools.tsx");
const compose = read("../src/components/Compose.tsx");
const css = read("../src/App.css");

// 1. the markup: one toolbar, items in the order sizes, alt text, as attachment, delete; no generic `.dot` on a button
const bar = tsx.slice(tsx.indexOf('<div className="img-tools" role="toolbar"'), tsx.indexOf('{altOpen && ('));
const order = ['role="radiogroup"', 'compose.pic.altText', 'compose.pic.asAttachment', 'compose.pic.remove'].map((k) => bar.indexOf(k));
assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `toolbar order ${order}`);
assert.doesNotMatch(bar, /\bdot\b/, "the generic .dot class (9 px wide, flex: none) must not be on a toolbar button");
assert.match(bar, /"no-alt"/);
assert.ok(!bar.includes("tabIndex") && bar.includes("{...rove("), "every control takes its tabindex from the roving helper (one Tab stop)");
assert.match(tsx, /aria-label=\{t\("compose\.pic\.options"\)\}/, "the toolbar keeps its aria label");
assert.match(tsx, /aria-label=\{t\("compose\.pic\.remove"\)\}/, "the icon button keeps its aria label");
// Esc leaves the toolbar / the alt text popover and returns to the editor
const esc = tsx.slice(tsx.indexOf('className="img-tools-anchor"'), tsx.indexOf('<div className="img-tools-box">'));
assert.match(esc, /e\.key !== "Escape"/);
assert.match(esc, /setAltOpen(false);s*backToEditor(sel.pos)/); // (D-033: the focus goes back and the picture selection is set again, see test-picture-esc.mjs)
// both editors mount it
assert.match(compose, /usePictureTools\(\{ editor, bodyRef, sizes: MESSAGE_PICTURE_SIZES/);
assert.match(read("../src/components/RichEditor.tsx"), /usePictureTools\(\{ editor, bodyRef, sizes: SIGNATURE_PICTURE_SIZES/);

// 2. the CSS: the toolbar wraps, its items do not shrink, it is never wider than the pane, the alt popover hangs under it
assert.match(css, /\.img-tools \{[^}]*flex-wrap: wrap;/, "the toolbar wraps to a second row");
assert.match(css, /\.img-tools > \* \{[^}]*flex: none;[^}]*white-space: nowrap;/, "items keep their width and their label on one line");
assert.match(css, /\.img-tools-box \{[^}]*max-width: calc\(100% - 16px\);/, "never wider than the pane");
assert.match(tsx, /usePinnedBelow\(altPopRef, toolsBoxRef, altOpen && !!sel\)/, "the alt text popover is placed from the toolbar (under it, or above it), inside the window");
assert.match(tsx, /className="popover alt-pop pinned"/, "and is a layer of its own, fixed, not inside the editor's scroll box");
assert.match(css, /\.popover\.pinned:not\(\.alt-pop\)/, "the toolbar steps aside for the other popovers, not for its own alt text popover");
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
// the picture's top edge is in view but there is no room above it (QA round 3, BUG-R3-2): the toolbar is over the picture, below its top handles (HANDLE_ZONE),
// never over its top edge; with the bottom edge in view as well it also ends above the bottom handles
assert.equal(at({ imgTop: 8, imgBottom: 200, paneHeight: 180 }).top, 8 + HANDLE_ZONE, "top edge in view: clear of the top handles");
assert.equal(at({ imgTop: 8, imgBottom: 150, paneHeight: 180, height: 34 }).top, 8 + HANDLE_ZONE, "(picture 142 high: 34 + 2 x 16 = 66 fit)");
// the bottom edge in view too, and the picture is too low for the zones: back to the top of the pane (it is tall enough to show all of the toolbar)
assert.equal(at({ imgTop: 8, imgBottom: 60, paneHeight: 90, height: 34 }).top, 6);
// for every picture height and scroll position where it fits between the handles, the toolbar is inside the picture and clear of both edges
for (const paneHeight of [150, 180, 225, 400]) for (const imgH of [60, 90, 120, 160, 200, 300, 900]) for (const scrollTop of [0, 20, 60, 120, 400]) {
  const imgTop = 8 + 40, imgBottom = imgTop + imgH;
  const r = at({ imgTop, imgBottom, scrollTop, paneHeight, height: 34 });
  const above = imgTop - 6 - 34 >= scrollTop, below = imgBottom + 6 + 34 <= scrollTop + paneHeight;
  if (above || below) continue;
  const topIn = imgTop >= scrollTop, botIn = imgBottom <= scrollTop + paneHeight;
  const roomy = Math.min(imgBottom, scrollTop + paneHeight) - Math.max(imgTop, scrollTop) >= 34 + (topIn ? HANDLE_ZONE : 6) + (botIn ? HANDLE_ZONE : 6);
  if (!roomy) continue;
  if (topIn) assert.ok(r.top >= imgTop + HANDLE_ZONE, `top handles (pane ${paneHeight}, picture ${imgH}, scroll ${scrollTop}): toolbar at ${r.top}, picture top ${imgTop}`);
  if (botIn) assert.ok(r.top + 34 <= imgBottom - HANDLE_ZONE, `bottom handles (pane ${paneHeight}, picture ${imgH}, scroll ${scrollTop}): toolbar bottom ${r.top + 34}, picture bottom ${imgBottom}`);
  assert.ok(r.top >= scrollTop && r.top + 34 <= scrollTop + paneHeight, `inside the pane (pane ${paneHeight}, picture ${imgH}, scroll ${scrollTop})`);
}
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
