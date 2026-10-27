// The box of a blocked remote picture (W1.13 b, 1.0.7): its size rule (src/blockedPicture.ts) and the wiring (sanitizeHtml marks the picture, the reading pane replaces the mark
// with the box and the frame draws it). The look is checked in the dev preview by hand and by the QA fixture (a newsletter with a 600 x 200 picture, one without size, one pixel).
// Run: node --experimental-strip-types scripts/test-blocked-picture.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BLOCKED_PICTURE_SIDE, TRACKING_PIXEL_MAX, blockedPictureBox, hiddenPictureBox } from "../src/blockedPicture.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const box = blockedPictureBox;
assert.equal(BLOCKED_PICTURE_SIDE, 48);
assert.equal(TRACKING_PIXEL_MAX, 2);

// 1. the size the mail gave
assert.deepEqual(box({ width: "600", height: "200" }), { hidden: false, width: "600px", height: "200px" }, "attributes");
assert.deepEqual(box({ width: "600px", height: "200px" }), { hidden: false, width: "600px", height: "200px" }, "with px");
assert.deepEqual(box({ width: " 120 ", height: "80.5" }), { hidden: false, width: "120px", height: "80.5px" });
assert.deepEqual(box({ style: "width:300px;height:100px" }), { hidden: false, width: "300px", height: "100px" }, "inline style");
assert.deepEqual(box({ style: "border:0; WIDTH : 300PX !important" }), { hidden: false, width: "300px", height: "48px" }, "style: case, spaces, !important; a side that is not given is 48");
assert.deepEqual(box({ width: "600", height: "200", style: "width:300px" }), { hidden: false, width: "300px", height: "200px" }, "the style wins over the attribute, a side at a time");
assert.deepEqual(box({ style: "width:10px;width:50px" }), { hidden: false, width: "50px", height: "48px" }, "the last declaration wins");
assert.deepEqual(box({ width: "100%", height: "50%" }), { hidden: false, width: "100%", height: "48px" }, "a width in percent stays, a height in percent has no reference");

// 2. no size: 48 x 48
assert.deepEqual(box({}), { hidden: false, width: "48px", height: "48px" });
assert.deepEqual(box({ width: "auto", height: "" }), { hidden: false, width: "48px", height: "48px" }, "words are no size");
assert.deepEqual(box({ width: "2em", height: "calc(1px + 1px)" }), { hidden: false, width: "48px", height: "48px" });
assert.deepEqual(box({ width: null, height: null, style: null }), { hidden: false, width: "48px", height: "48px" });

// 3. tracking pixels are not drawn
assert.deepEqual(box({ width: "1", height: "1" }), { hidden: true });
assert.deepEqual(box({ width: "2", height: "2" }), { hidden: true });
assert.deepEqual(box({ width: "0", height: "0" }), { hidden: true });
assert.deepEqual(box({ width: "1", height: "400" }), { hidden: true }, "one side is enough");
assert.deepEqual(box({ width: "400", height: "2" }), { hidden: true });
assert.deepEqual(box({ style: "width:1px;height:1px" }), { hidden: true });
assert.deepEqual(box({ width: "600", height: "200", style: "width:1px" }), { hidden: true }, "the style makes it a pixel");
assert.deepEqual(box({ width: "1", style: "width:300px" }), { hidden: false, width: "300px", height: "48px" }, "the style makes it a picture");
assert.deepEqual(box({ width: "3", height: "3" }), { hidden: false, width: "3px", height: "3px" }, "3 px is drawn");
assert.deepEqual(box({ width: "2%" }), { hidden: false, width: "2%", height: "48px" }, "2 % is no pixel");

// 3b. 1.0.10 (T-U2, AC-15..18): the reading pane's box of a hidden picture: the size the mail gave, 240 x (at least 96) without one, at most 480 high, the tier says how much text fits;
// a picture the mail hides itself is not drawn
const hbox = hiddenPictureBox;
const same = (a, b, m) => assert.deepEqual(a, b, m);
same(hbox({ width: "600", height: "200" }), { hidden: false, width: "600px", height: "200px", minHeight: "0", maxHeight: "480px", tier: "full" }, "600 x 200: the whole text");
same(hbox({}), { hidden: false, width: "240px", height: "auto", minHeight: "96px", maxHeight: "480px", tier: "full" }, "no size: 240 wide, at least 96 high");
same(hbox({ width: "300" }), { hidden: false, width: "300px", height: "auto", minHeight: "96px", maxHeight: "480px", tier: "full" }, "no height: the minimum");
same(hbox({ width: "600", height: "900" }), { hidden: false, width: "600px", height: "480px", minHeight: "0", maxHeight: "480px", tier: "full" }, "capped at 480 high");
same(hbox({ width: "100%" }), { hidden: false, width: "100%", height: "auto", minHeight: "96px", maxHeight: "480px", tier: "full" }, "a width in percent: a wide box");
assert.equal(hbox({ width: "139", height: "200" }).tier, "mid", "139 wide: the main line only");
assert.equal(hbox({ width: "140", height: "64" }).tier, "full", "140 x 64: the whole text");
assert.equal(hbox({ width: "140", height: "63" }).tier, "mid");
assert.equal(hbox({ width: "96", height: "40" }).tier, "mid");
assert.equal(hbox({ width: "95", height: "40" }).tier, "small");
assert.equal(hbox({ width: "96", height: "39" }).tier, "small");
assert.equal(hbox({ width: "80", height: "30" }).tier, "small", "80 x 30: only the icon");
for (const hidden of [{ width: "1", height: "1" }, { width: "2", height: "300" }, { width: "300", height: "2" }, { hidden: true }, { style: "display:none" }, { style: "color:red; DISPLAY : NONE !important" }, { style: "visibility:hidden" }, { style: "opacity:0" }, { style: "opacity: 0.0;" }]) {
  assert.deepEqual(hbox(hidden), { hidden: true }, JSON.stringify(hidden));
  assert.deepEqual(blockedPictureBox(hidden), { hidden: true }, "the quote's box follows: " + JSON.stringify(hidden));
}
for (const shown of [{ style: "opacity:0.5" }, { style: "display:block" }, { style: "visibility:visible" }, { style: "margin-opacity:0" }]) assert.equal(hbox(shown).hidden, false, JSON.stringify(shown));

// 4. the wiring
const util = read("src/util.ts");
assert.match(util, /node\.tagName === "IMG"[\s\S]{0,120}data-hl-blocked/, "sanitizeHtml marks a picture whose address it removed");
assert.match(util, /data-hl-src/, "and keeps its address in an attribute nothing loads (the frame's CSP stays img-src data:)");
const pane = read("src/components/ReadingPane.tsx");
assert.match(pane, /img\[data-hl-blocked\]/, "the reading pane looks for the mark");
assert.match(pane, /hiddenPictureBox\(\{ width: img\.getAttribute\("width"\)/, "and sizes the box from the picture's own attributes");
assert.match(pane, /setAttribute\("role", "button"\)/, "the box is a button for the keyboard and screen readers (1.0.10: it is announced and shows the picture)");
// (the frame's style sheet lives in mailFrameCss.ts since the newsletter colour scheme work)
const frameCss = read("src/mailFrameCss.ts");
for (const rule of [".hl-bp{", "border:1px dashed #9aa3af", "border-radius:6px", "background:#f6f7f9", "color:#5b6470", "font:12px", "text-overflow:ellipsis", ".hl-bp-ico{", "data:image/svg+xml"]) {
  assert.ok(frameCss.includes(rule), `the frame's style sheet has ${rule}`);
}
// the quote of a reply keeps the plain box (editor/quoteNode.ts): not clickable; the reading pane's box (hl-bpx, 1.0.10) is
assert.ok(!/\.hl-bp\{[^}]*cursor:\s*pointer/.test(frameCss.slice(frameCss.indexOf("BLOCKED_PICTURE_CSS"), frameCss.indexOf("HIDDEN_PICTURE_CSS"))), "the quote's box is not clickable");
assert.ok(/\.hl-bpx\{cursor:pointer/.test(frameCss), "the reading pane's box is");
assert.match(read("src/i18n/ns/reading.ts"), /"reading\.body\.blocked"/, "the banner with its 'Load content' action stays the way to load them");
console.log("ok - test-blocked-picture");
