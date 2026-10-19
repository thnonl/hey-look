// The picture of a signature or template (spec-rich-text.md REQ-25, AC-43, AC-44): the 1 MB limit after the picture was made smaller, the first width, and
// the wiring (the signature and the template editors take pictures, the toolbar has the button). Behaviour of src/editor/signaturePicture.ts.
// Run: node --experimental-strip-types scripts/test-signature-picture.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fillSignatureStr } from "../src/editor/messageBody.ts";
import { MESSAGE_PICTURE_SIZES, SIGNATURE_PICTURE_SIZES, sizeForKey } from "../src/editor/pictureSizes.ts";
import { SHRINK_STEPS, SIGNATURE_PICTURE_MAX, SIGNATURE_PICTURE_WIDTH, fitSignaturePicture, initialWidth } from "../src/editor/signaturePicture.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

assert.equal(SIGNATURE_PICTURE_MAX, 1024 * 1024);
assert.equal(SIGNATURE_PICTURE_WIDTH, 240);
assert.equal(initialWidth(100), null, "a small logo keeps its own size");
assert.equal(initialWidth(240), null);
assert.equal(initialWidth(241), 240);
assert.equal(initialWidth(3000), 240);

// a stand-in picture: the "bytes" of a data URL are its length, and a picture of width w weighs k * w (so making it smaller makes it lighter)
const io = (perPx, log) => ({
  bytes: (u) => Number(/^data:x\/(\d+)/.exec(u)[1]),
  resize: async (u, mime, maxW) => {
    log?.push(maxW);
    return { dataUrl: `data:x/${Math.round(maxW * perPx)}`, mime, w: maxW, h: maxW / 2 };
  },
});
const pic = (bytes, w) => ({ dataUrl: `data:x/${bytes}`, mime: "image/png", w, h: w / 2 });

{
  // light enough: as it is, not touched
  const log = [];
  const r = await fitSignaturePicture(pic(900_000, 3000), io(100, log));
  assert.deepEqual([r.ok, r.resized, r.dataUrl], [true, false, "data:x/900000"]);
  assert.deepEqual(log, []);
  // exactly 1 MB still fits
  assert.equal((await fitSignaturePicture(pic(SIGNATURE_PICTURE_MAX, 800), io(100))).ok, true);
  assert.equal((await fitSignaturePicture(pic(SIGNATURE_PICTURE_MAX + 1, 800), io(1))).ok, true, "made smaller it fits");
}
{
  // too heavy: made smaller step by step until it fits, never smaller than needed
  const log = [];
  const r = await fitSignaturePicture(pic(5_000_000, 3000), io(800, log)); // 1600 px -> 1,280,000 (too heavy), 1200 px -> 960,000 (fits)
  assert.deepEqual([r.ok, r.resized, r.w], [true, true, 1200]);
  assert.deepEqual(log, [1600, 1200]);
}
{
  // a step that is not smaller than the picture is skipped
  const log = [];
  const r = await fitSignaturePicture(pic(2_000_000, 1000), io(1400, log)); // 800 px -> 1,120,000, 600 -> 840,000
  assert.deepEqual([r.ok, r.w], [true, 600]);
  assert.deepEqual(log, [800, 600], "1600 and 1200 are wider than the picture");
}
{
  // nothing fits: refused (the person is told to choose a smaller picture)
  const log = [];
  const r = await fitSignaturePicture(pic(9_000_000, 4000), io(5000, log)); // 400 px -> 2,000,000: still too heavy
  assert.equal(r.ok, false);
  assert.deepEqual(log, [...SHRINK_STEPS]);
}

// ---- the wiring
const settings = read("src/components/SettingsDialog.tsx");
assert.match(settings, /<RichEditor pictures key=\{cur\.id\} label=\{t\("settings\.composing\.signature"\)\}/, "the signature editor takes pictures");
assert.match(settings, /<RichEditor pictures key=\{cur\.id\} label=\{t\("settings\.tpl\.message"\)\}/, "the template editor takes pictures");
const rich = read("src/components/RichEditor.tsx");
assert.match(rich, /pictures\?: boolean/);
assert.match(rich, /baseExtensions\(\{[^}]*\bpictures\b/, "the picture node is in the editor");
assert.match(rich, /insertPicture: pictures \?/, "the toolbar has the Picture button");
assert.match(rich, /fitSignaturePicture\(/, "the 1 MB rule is applied");
assert.match(read("src/editor/toolbarLayout.ts"), /picture: \{[^}]*variants: BOTH/, "the compact toolbar has the picture control");
// the sent message makes every data: picture of the signature an inline part (messageBody.ts swaps after the signature is in)
const body = read("src/editor/messageBody.ts");
assert.ok(body.indexOf("fillSignatureStr(docToHtml") < body.indexOf("swapPictures(filled"), "the signature is put in before the pictures become parts");

// ---- W2.15: the picture toolbar of the message body is the one of the signature / template editor, with the sizes of a logo
assert.deepEqual(SIGNATURE_PICTURE_SIZES.map(([, w]) => w), [120, 240, 360, null], "Small 120 / Medium 240 / Large 360 / Original");
assert.deepEqual(SIGNATURE_PICTURE_SIZES.map(([k]) => k), ["compose.pic.small", "compose.pic.medium", "compose.pic.large", "compose.pic.original"], "the existing size texts");
assert.deepEqual(MESSAGE_PICTURE_SIZES.map(([, w]) => w), [240, 480, 720, null], "the message body keeps its sizes");
assert.equal(SIGNATURE_PICTURE_SIZES[1][1], SIGNATURE_PICTURE_WIDTH, "Medium is the width a new signature picture gets");
assert.deepEqual(["1", "2", "3", "0", "4"].map((k) => sizeForKey(SIGNATURE_PICTURE_SIZES, k)), [120, 240, 360, null, undefined], "Ctrl+1/2/3/0");
assert.ok(rich.includes("usePictureTools({ editor, bodyRef, sizes: SIGNATURE_PICTURE_SIZES"), "the toolbar is mounted in the signature / template editor");
assert.ok(!rich.includes("onAttachment"), "no As attachment in a signature or a template");
const tools = read("src/editor/PictureTools.tsx");
assert.ok(tools.includes("{onAttachment && <button"), "As attachment is only there when the editor gives the action");
assert.ok(tools.includes("compose.pic.altText"), "the Alt text button");
// the alt text is part of the signature's HTML and stays when the signature is put into a message
const logo = '<p><img src="data:image/png;base64,AAAA" alt="Company logo" width="120"></p>';
assert.ok(fillSignatureStr('<p>Hi</p><div data-sig-block></div>', logo).includes('alt="Company logo"'), "the alt text survives fillSignatureStr");

console.log("signature-picture: ok");
