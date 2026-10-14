// The background HTML mail is read on: the mail's original colours by default in every app theme, a dark one on request, remembered.
// Pure logic of src/mailCanvas.ts plus source checks of the pieces that use it (prefs, reading pane).
// Run: node --experimental-strip-types scripts/test-mail-canvas.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DARK_CANVAS, DEFAULT_MAIL_CANVAS, MAIL_CANVAS_LABEL, frameBaseCss, frameRootClass, resolveMailCanvas, toggleMailCanvas } from "../src/mailCanvas.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// preference resolution: original unless "dark" was stored
assert.equal(DEFAULT_MAIL_CANVAS, "original");
assert.equal(resolveMailCanvas(undefined), "original");
assert.equal(resolveMailCanvas(null), "original");
assert.equal(resolveMailCanvas("dark"), "dark");
for (const bad of ["light", "Dark", "", 1, true, {}, "original"]) assert.equal(resolveMailCanvas(bad), "original", String(bad));
assert.equal(toggleMailCanvas("original"), "dark");
assert.equal(toggleMailCanvas("dark"), "original");
assert.equal(toggleMailCanvas(toggleMailCanvas("original")), "original");

// the frame is built right the first time: original = plain (never hidden, nothing recoloured); dark = created dark and hidden until recoloured
assert.equal(frameRootClass("original"), "");
assert.equal(frameRootClass("dark"), ' class="hm-dark hm-pend"');
const css = frameBaseCss();
assert.match(css, /html\{--hm-fg:#242424;--hm-link:#0f6cbd;--hm-bg:#ffffff\}/, "white base for mails without a background of their own, also for plain text");
const [r, g, b] = DARK_CANVAS;
assert.ok(css.includes(`html.hm-dark{--hm-fg:#e6e6e6;--hm-link:#6cb8f6;--hm-bg:rgb(${r},${g},${b});color-scheme:dark}`), "dark base is a real colour, not the pane behind");
assert.ok(!/transparent/.test(css));
assert.ok(css.startsWith("html{") && css.indexOf("@media screen{") > 0, "the dark rules are screen only: printing keeps the original colours");
assert.ok(css.indexOf("hm-pend") > css.indexOf("@media screen"), "hiding is under the dark class only, so the original is never hidden");
assert.deepEqual(DARK_CANVAS, [27, 28, 32], "the dark theme's own surface");

// the button
assert.equal(MAIL_CANVAS_LABEL, "Message background: original / dark");

// the preference is stored with the other preferences, default original, unknown values fall back
const prefs = read("src/prefs.ts");
assert.match(prefs, /mailCanvas: MailCanvas;/);
assert.match(prefs, /mailCanvas: DEFAULT_MAIL_CANVAS,/);
assert.match(prefs, /mailCanvas: resolveMailCanvas\(p\.mailCanvas\),/);

// the reading pane: the choice comes from the preference (not from the app theme), the button is always there, the frame uses the builders
const rp = read("src/components/ReadingPane.tsx");
assert.match(rp, /const canvas = useStore\(\(s\) => s\.prefs\.mailCanvas\);/);
assert.match(rp, /setPrefs\(\{ mailCanvas: toggleMailCanvas\(canvas\) \}\)/);
assert.ok(!/useAppDark|appSurface/.test(rp), "the app theme does not decide the mail's background");
assert.match(rp, /title=\{MAIL_CANVAS_LABEL\} aria-label=\{MAIL_CANVAS_LABEL\} aria-pressed=\{cv\.dark\}/);
assert.ok(!/\{cv\.appDark && \(/.test(rp), "the button is not limited to the dark theme");
assert.match(rp, /frameRootClass\(darkNow\.current \? "dark" : "original"\)/);
assert.match(rp, /\$\{frameBaseCss\(\)\}/);
assert.equal((rp.match(/setMailDark\(doc, /g) ?? []).length, 2, "recoloured in place on a toggle and once on load (the off switch is the same call)");

console.log("ok - test-mail-canvas");
