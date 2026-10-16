// Checks src/forwardAttachments.ts: Forward carries the attachments of the message (BUG-08 / CF-3 / A-08). Run:
// node --experimental-strip-types scripts/test-forward-attachments.mjs
import assert from "node:assert/strict";
import { embeddedBytes, forwardFiles, MAX_FORWARD_BYTES } from "../src/forwardAttachments.ts";

const b64 = (n) => Buffer.alloc(n, 1).toString("base64");
const meta = (index, name, size, extra = {}) => ({ index, name, mime: "application/octet-stream", size, inline: false, cid: null, referenced: false, ...extra });
const files = { 0: ["report.pdf", "application/pdf", 1000], 1: ["notes.txt", "text/plain", 20], 2: ["Báo cáo 東京.xlsx", "application/vnd.ms-excel", 3000] };
const fetchLog = [];
const fetchOne = async (i) => {
  fetchLog.push(i);
  const f = files[i];
  if (!f) throw new Error(`attachment ${i} not found`);
  return { name: f[0], mime: f[1], dataBase64: b64(f[2]) };
};

// A-08: two attachments and two pictures; the pictures are in the body, the attachments come along with name, type and bytes
const html = `<p>Hi</p><img src="data:image/png;base64,${b64(300)}"><img src="cid:big@x">`;
const m = {
  html,
  attachments: [
    meta(0, "report.pdf", 1000),
    meta(1, "notes.txt", 20),
    meta(2, "logo.png", 300, { inline: true, cid: "logo@x", referenced: true }), // embedded already: not fetched, not attached
    meta(3, "big.png", 600, { inline: true, cid: "big@x", referenced: true }), // still a cid: fetched into the body
    meta(4, "unused.png", 10, { inline: true, cid: "unused@x", referenced: false }), // has a Content-ID but the body does not show it: an attachment
  ],
};
files[3] = ["big.png", "image/png", 600];
files[4] = ["unused.png", "image/png", 10];
const r = await forwardFiles(m, fetchOne);
assert.deepEqual(r.attachments.map((a) => a.filename), ["report.pdf", "notes.txt", "unused.png"]);
assert.equal(r.attachments[0].mime, "application/pdf");
assert.equal(Buffer.from(r.attachments[0].dataBase64, "base64").length, 1000, "same bytes");
assert.ok(r.html.includes(`data:image/png;base64,${b64(600)}`) && !r.html.includes("cid:big@x"), "a large picture becomes part of the body");
assert.deepEqual(fetchLog, [0, 1, 3, 4], "the embedded picture is not downloaded again");
assert.deepEqual([r.failed, r.skipped], [[], []]);

// no attachments: nothing to fetch, the body as it is
fetchLog.length = 0;
const none = await forwardFiles({ html: "<p>x</p>", attachments: [] }, fetchOne);
assert.deepEqual([none.attachments, none.html, fetchLog], [[], "<p>x</p>", []]);

// a file that cannot be fetched is reported; the others still come (Compose opens anyway)
const flaky = await forwardFiles({ html: null, attachments: [meta(0, "report.pdf", 1000), meta(9, "gone.zip", 5), meta(2, "Báo cáo 東京.xlsx", 3000)] }, fetchOne);
assert.deepEqual(flaky.attachments.map((a) => a.filename), ["report.pdf", "Báo cáo 東京.xlsx"]);
assert.deepEqual(flaky.failed, [{ name: "gone.zip", error: "attachment 9 not found" }]);
const strErr = await forwardFiles({ html: null, attachments: [meta(0, "a.bin", 1)] }, async () => Promise.reject("PGP_LOCKED:ABCD"));
assert.deepEqual(strErr.failed, [{ name: "a.bin", error: "PGP_LOCKED:ABCD" }], "the backend rejects with a string");

// size limit: the message may carry 25 MB in all (attachments and pictures); what does not fit is named, nothing is downloaded for it
fetchLog.length = 0;
const mb = 1024 * 1024;
const big = { html: null, attachments: [meta(0, "a.bin", 20 * mb), meta(1, "b.bin", 6 * mb), meta(2, "c.bin", 4 * mb)] };
const sized = await forwardFiles(big, async (i) => ({ name: big.attachments[i].name, mime: "application/octet-stream", dataBase64: "AA==" }));
assert.deepEqual(sized.attachments.map((a) => a.filename), ["a.bin", "c.bin"]);
assert.deepEqual(sized.skipped, ["b.bin"]);
assert.equal(MAX_FORWARD_BYTES, 25 * mb);
// pictures already in the body count too
const heavy = `<img src="data:image/png;base64,${b64(24 * mb)}">`;
assert.equal(embeddedBytes(heavy), 24 * mb);
const over = await forwardFiles({ html: heavy, attachments: [meta(0, "report.pdf", 2 * mb)] }, fetchOne);
assert.deepEqual([over.attachments.length, over.skipped], [0, ["report.pdf"]]);
console.log("forward-attachments: all checks passed");
