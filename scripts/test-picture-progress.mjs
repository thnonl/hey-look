// The progress of the pictures of one message (1.0.17): the rules of src/pictureProgress.ts that the thin bar over the message body is drawn from.
// Run: node --experimental-strip-types scripts/test-picture-progress.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PIC_IDLE, progressValue, stepProgress } from "../src/pictureProgress.ts";

// 1. nothing loads: nothing to show, the state does not change
assert.equal(stepProgress(PIC_IDLE, 0), PIC_IDLE);
assert.equal(progressValue(PIC_IDLE), 0);
// 2. ten pictures start together, they arrive one by one: 0, 0.3, ... then full
let p = stepProgress(PIC_IDLE, 10);
assert.deepEqual(p, { peak: 10, pending: 10, cycle: 1 });
assert.equal(progressValue(p), 0);
p = stepProgress(p, 7);
assert.equal(progressValue(p), 0.3);
p = stepProgress(p, 7);
assert.equal(p.cycle, 1, "the same count changes nothing");
p = stepProgress(p, 0);
assert.equal(progressValue(p), 1, "all done: the bar is full");
assert.equal(p.peak, 10, "the peak stays for the full bar");
// 3. a failed picture counts as done: it just leaves the pending count
assert.equal(progressValue(stepProgress(stepProgress(PIC_IDLE, 2), 1)), 0.5);
// 4. more pictures join in the same round (a second batch): the bar never goes backwards past the new peak, it re-measures
p = stepProgress(stepProgress(stepProgress(PIC_IDLE, 4), 2), 5);
assert.deepEqual(p, { peak: 5, pending: 5, cycle: 1 });
// 5. a new round after the old one is over (a picture shown by hand): own start, own peak
p = stepProgress(stepProgress(stepProgress(PIC_IDLE, 3), 0), 1);
assert.deepEqual(p, { peak: 1, pending: 1, cycle: 2 });
// 6. odd input
assert.equal(stepProgress(PIC_IDLE, -3), PIC_IDLE);
assert.equal(stepProgress(PIC_IDLE, 2.9).pending, 2);

// 7. the bar's words and rules: no new text, the existing "Showing picture" key; the screen-only loading look; reduced motion switches both animations off
const bar = readFileSync(new URL("../src/components/PictureBar.tsx", import.meta.url), "utf8");
assert.ok(bar.includes('t("reading.pic.showing")') && bar.includes('role="progressbar"') && bar.includes("aria-valuenow"), "progressbar with the existing label");
const css = readFileSync(new URL("../src/mailFrameCss.ts", import.meta.url), "utf8");
assert.ok(!css.includes("hl-spin"), "no spinner left in the frame CSS");
assert.ok(css.includes("prefers-reduced-motion:reduce){.hl-bpx[data-state=loading]") && css.includes("img[data-hl-new]{animation:none}"), "no animation under reduced motion");
const app = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
assert.ok(/prefers-reduced-motion: reduce\) \{ \.pic-bar, \.pic-bar > i \{ transition: none/.test(app), "the bar does not animate under reduced motion");
console.log("picture progress: ok");
