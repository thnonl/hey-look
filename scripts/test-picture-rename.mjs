// A picture that was re-encoded goes out under a name that says what it is (v1.0.6 QA round 3, BUG-R3-3: a resized animated GIF was sent as image/png
// under the name e09-anim.gif). Behaviour of nameForMime / swapPictures in src/editor/messageBody.ts; the picture's real bytes and part headers are
// checked on the sent message (scripts of the QA kit: mimecheck MA-18) and in the dev preview (scripts/test-compose-pictures.mjs).
// Run: node --experimental-strip-types scripts/test-picture-rename.mjs
import assert from "node:assert/strict";
import { keepSmaller, largePictureOffer, nameForMime, reencodeToastKey, swapPictures } from "../src/editor/messageBody.ts";

// 1. the name follows the type of the bytes
for (const [name, mime, want] of [
  ["e09-anim.gif", "image/png", "e09-anim.png"], // the resized GIF
  ["E09-ANIM.GIF", "image/png", "E09-ANIM.png"],
  ["photo.webp", "image/jpeg", "photo.jpg"], // webp is re-encoded as JPEG
  ["scan.png", "image/jpeg", "scan.jpg"],
  ["a.b.c.gif", "image/png", "a.b.c.png"],
  ["holiday", "image/png", "holiday.png"], // no extension: the type's own
  ["my.photo", "image/jpeg", "my.photo.jpg"], // an extension that is not a picture one stays part of the name
  ["x.JPEG", "image/jpeg", "x.JPEG"], // already says so (any spelling of it)
  ["x.jpg", "image/jpeg", "x.jpg"],
  ["x.jpe", "image/jpeg", "x.jpe"],
  ["x.gif", "image/gif", "x.gif"], // not re-encoded: a GIF stays a GIF
  ["x.png", "image/png", "x.png"],
  ["x.bmp", "image/png", "x.png"],
  ["a b (1).tiff", "image/jpeg", "a b (1).jpg"],
  ["dir.d/noext", "image/png", "dir.d/noext.png"], // (a dot in a folder is not an extension)
  ["x.gif", "application/octet-stream", "x.gif"], // not a picture type: left alone
  ["x.gif", "IMAGE/GIF", "x.gif"],
]) assert.equal(nameForMime(name, mime), want, `${name} as ${mime}`);

// 2. the sent / saved part: type, name and Content-ID name agree, whatever the name in the editor was
const b64 = Buffer.from("not really a picture").toString("base64");
const html = (name, mime) => `<p><img data-name="${name}" src="data:${mime};base64,${b64}" alt=""></p>`;
let n = 0;
const swap = (h) => swapPictures(h, () => `cid${++n}@heylook`, (mime, i) => `picture-${i}.${mime.split("/")[1]?.replace("jpeg", "jpg")}`);
{
  const r = swap(html("e09-anim.gif", "image/png")); // a name that was never updated (a draft saved by an earlier version)
  assert.equal(r.inline.length, 1);
  assert.deepEqual([r.inline[0].mime, r.inline[0].name], ["image/png", "e09-anim.png"]);
  assert.ok(!r.html.includes("data-name") && !r.html.includes("e09-anim"), "the editor's name never reaches the message HTML");
  // the GIF that was not re-encoded stays a GIF, type and name
  const g = swap(html("anim.gif", "image/gif"));
  assert.deepEqual([g.inline[0].mime, g.inline[0].name], ["image/gif", "anim.gif"]);
  // no name: the generated one has the right extension already
  const u = swap(`<img src="data:image/gif;base64,${b64}">`);
  assert.deepEqual([u.inline[0].mime, u.inline[0].name], ["image/gif", "picture-1.gif"]);
  // a name with HTML escapes keeps them readable
  const e = swap(html("a &amp; b.gif", "image/png"));
  assert.equal(e.inline[0].name, "a & b.png");
}

// 3. the toast after a big picture was re-encoded does not claim a resize that did not happen (v1.0.6 Mac QA: a 900 px wide GIF "resized to 1600 px")
for (const [mime, width, want] of [
  ["image/gif", 900, "compose.pic.convertedGif"],
  ["image/gif", 1600, "compose.pic.convertedGif"],
  ["image/gif", 1601, "compose.pic.resizedGif"],
  ["image/gif", 4000, "compose.pic.resizedGif"],
  ["image/png", 900, "compose.pic.recompressed"],
  ["image/jpeg", 1600, "compose.pic.recompressed"],
  ["image/jpeg", 3000, "compose.pic.resized"],
  ["image/webp", 1601, "compose.pic.resized"],
]) assert.equal(reencodeToastKey(mime, width), want, `${mime} ${width} px`);

// 4. 1.0.7 W2.1: the prompt for a picture over 1 MB (auto-resize off) offers only an action that is true and useful
for (const [mime, width, want] of [
  ["image/jpeg", 4000, "resize"], // wider than 1600 px: any type is scaled
  ["image/png", 1601, "resize"],
  ["image/gif", 5000, "resize"],
  ["image/webp", 1601, "resize"],
  ["image/jpeg", 1600, "compress"], // not wider: JPEG and WebP are compressed
  ["image/jpeg", 1200, "compress"],
  ["IMAGE/JPEG", 800, "compress"],
  ["image/webp", 900, "compress"],
  ["image/gif", 1600, "convert"], // a GIF is converted to PNG
  ["image/gif", 800, "convert"],
  ["image/png", 1600, null], // a PNG that is not wider gets no prompt
  ["image/png", 1000, null],
  ["image/bmp", 1000, null],
]) assert.equal(largePictureOffer(mime, width), want, `${mime} ${width} px`);
// ... and a re-encode that is not smaller in bytes is not used
assert.equal(keepSmaller(1_500_000, 900_000), true);
assert.equal(keepSmaller(1_500_000, 1_500_000), false, "equal is not smaller");
assert.equal(keepSmaller(1_500_000, 1_900_000), false, "bigger");
assert.equal(keepSmaller(1_100_000, 1), true);

console.log("test-picture-rename: ok");
