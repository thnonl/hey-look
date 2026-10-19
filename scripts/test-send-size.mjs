// The size of a message on the wire (G-07 / CF-21): base64 + line breaks + part headers, against the server's SIZE or the usual 25 MB.
// Run: node --experimental-strip-types scripts/test-send-size.mjs
import assert from "node:assert/strict";
import { askFreshBeforeSend, showSizeToast, ARMOR, USUAL_LIMIT, attachmentWire, base64Chars, base64Wire, isSizeRefusal, partHeaders, DRAFT_LIMIT, draftSize, draftTooLargeError, pictureWire, sendLimit, wireSize } from "../src/sendSize.ts";

const MiB = 1024 * 1024;
const b64 = (raw) => base64Chars(raw); // base64 text length of a raw size

// the QA case: one 24.9 MiB file is 34.07 MiB on the wire (round 17 measured 34.07)
const raw249 = Math.round(24.9 * MiB);
const w = wireSize({ attachments: [{ filename: "big-249mib.bin", base64Length: b64(raw249) }] });
assert.ok(Math.abs(w / MiB - 34.07) < 0.02, `24.9 MiB file -> ${(w / MiB).toFixed(2)} MiB`);
assert.ok(w > USUAL_LIMIT, "it does not fit the 25 MB limit, whatever the label said");
// 26 MiB is over, 18 MiB of files is under (18 * 1.368 = 24.6), 18.3 MiB is over (25.03)
const files = (mib) => wireSize({ attachments: [{ filename: "a.bin", base64Length: b64(Math.round(mib * MiB)) }] });
assert.ok(files(26) > USUAL_LIMIT && files(18) < USUAL_LIMIT && files(18.3) > USUAL_LIMIT);

// the arithmetic
assert.equal(base64Chars(0), 0);
assert.equal(base64Chars(1), 4);
assert.equal(base64Chars(3), 4);
assert.equal(base64Chars(4), 8);
assert.equal(base64Wire(0), 0);
assert.equal(base64Wire(76), 78, "one full line + CRLF");
assert.equal(base64Wire(77), 77 + 4, "a second, short line + CRLF");
assert.equal(attachmentWire("a.txt", 0), partHeaders("a.txt"), "an empty file is only its headers");

// names: ASCII twice, other scripts %-encoded (3 bytes per UTF-8 byte), twice
assert.equal(partHeaders("abc"), 220 + 6);
assert.equal(partHeaders("東京"), 220 + 2 * 6 * 3);
assert.ok(partHeaders("x".repeat(500)) > partHeaders("x"));

// pictures in the body travel as related parts
assert.equal(pictureWire(3), base64Wire(4) + partHeaders("picture.png"));
const withPics = wireSize({ attachments: [], pictures: [MiB, MiB] });
assert.ok(Math.abs(withPics / MiB - 2 * 1.368) < 0.01);

// body text and encryption
assert.equal(wireSize({ attachments: [] }), 0, "nothing counted for an empty composer");
assert.ok(wireSize({ attachments: [], htmlLength: 10_000, textLength: 5_000 }) > 15_000);
const plain = wireSize({ attachments: [{ filename: "a", base64Length: b64(10 * MiB) }] });
const enc = wireSize({ attachments: [{ filename: "a", base64Length: b64(10 * MiB) }], encrypted: true });
assert.ok(Math.abs(enc / plain - ARMOR) < 0.001, "an encrypted message is armored again");

// the limit
assert.deepEqual(sendLimit(null), { bytes: USUAL_LIMIT, fromServer: false });
assert.deepEqual(sendLimit(undefined), { bytes: USUAL_LIMIT, fromServer: false });
assert.deepEqual(sendLimit(0), { bytes: USUAL_LIMIT, fromServer: false }, "SIZE 0 = no declared limit");
assert.deepEqual(sendLimit(10_485_760), { bytes: 10_485_760, fromServer: true }, "the stub of the plan: SIZE 10485760");
assert.deepEqual(sendLimit(35_882_577), { bytes: USUAL_LIMIT, fromServer: false }, "a server that takes more than 25 MB still gets the usual 25 MB: min(25 MB, SIZE)");
assert.deepEqual(sendLimit(USUAL_LIMIT), { bytes: USUAL_LIMIT, fromServer: false });
assert.deepEqual(sendLimit(USUAL_LIMIT - 1), { bytes: USUAL_LIMIT - 1, fromServer: true });
// a 24.9 MiB file (34 MiB on the wire) is over a 10 MiB server and over the usual limit whatever a bigger server says; 8 MiB of files (10.9 on the wire) fits 25 MB but not a 10 MiB server
assert.ok(w > sendLimit(10_485_760).bytes && w > sendLimit(50 * MiB).bytes);
const w8 = wireSize({ attachments: [{ filename: "a.bin", base64Length: b64(8 * MiB) }] });
assert.ok(w8 < sendLimit(50 * MiB).bytes && w8 > sendLimit(10 * MiB).bytes);

// QA 19A BUG-16: the stub advertised SIZE 5000000 and the file was 4 MB (5,474,674 bytes on the wire): the old code asked only above 8 MiB
const raw4mb = 4 * 1000 * 1000;
const w4 = wireSize({ attachments: [{ filename: "four-mb.bin", base64Length: b64(raw4mb) }] });
assert.ok(w4 > 5_000_000 && w4 < 5_600_000, `4 MB file -> ${w4} bytes on the wire`);
assert.ok(w4 < USUAL_LIMIT, "it fits the usual limit, so only the server's SIZE can block it");
assert.ok(w4 > sendLimit(5_000_000).bytes, "and the server's SIZE 5000000 blocks it");
assert.equal(sendLimit(5_000_000).fromServer, true, "the message names the account's server");

// QA round 20 BUG-01: right before Send a message with files asks the server afresh (the cache must not hide a limit that just changed)
assert.ok(askFreshBeforeSend(1, 0) && askFreshBeforeSend(0, 2) && !askFreshBeforeSend(0, 0));

// a refused send: the backend's coded error
assert.ok(isSizeRefusal("SMTP_TOO_LARGE|reply=552 5.3.4 Message size exceeds fixed limit: The message is larger than this server accepts."));
assert.ok(isSizeRefusal(new Error("Error: SMTP_TOO_LARGE|reply=552: x")));
assert.ok(!isSizeRefusal("SMTP_ATTACHMENT_BLOCKED|reply=552: x"));
assert.ok(!isSizeRefusal("SMTP send failed: 552"));
assert.ok(!isSizeRefusal(undefined));

// QA round 20 BUG-02: a blocked Send leaves exactly ONE size toast, whatever came before (files added, Send pressed once or twice)
{
  let seq = 0;
  let toasts = [];
  const host = {
    showToast: (text) => { toasts = [...toasts, { id: ++seq, text }]; },
    dismissToast: (id) => { toasts = toasts.filter((t) => t.id !== id); },
    lastToastId: () => (toasts.length ? toasts[toasts.length - 1].id : null),
  };
  const last = { id: null };
  showSizeToast(host, last, "Attachments total 35.6 MB when sent; the limit is 25.0 MB"); // files were added
  assert.equal(toasts.length, 1);
  host.showToast("Saved"); // another toast in between stays
  showSizeToast(host, last, "Attachments total 35.7 MB when sent; the limit is 25.0 MB"); // Send pressed: not the same size to the byte
  assert.deepEqual(toasts.map((t) => t.text), ["Saved", "Attachments total 35.7 MB when sent; the limit is 25.0 MB"]);
  showSizeToast(host, last, "Attachments total 35.7 MB when sent; the limit is 25.0 MB"); // Send pressed again
  assert.equal(toasts.filter((t) => /^Attachments total/.test(t.text)).length, 1, "exactly one size message");
  // the toast timed out meanwhile: the next one is shown normally
  toasts = [];
  showSizeToast(host, last, "Attachments total 36 MB when sent; the limit is 25.0 MB");
  assert.equal(toasts.length, 1);
}

// D-025: a draft has its own, much bigger bound (a draft of 20 MB of pictures froze the app); the page does not ask the backend for a bigger one
{
  assert.equal(DRAFT_LIMIT, 100 * MiB);
  assert.ok(DRAFT_LIMIT >= 4 * USUAL_LIMIT, "bigger than what can be sent, so a message that is being split can still be saved");
  const pic = (chars) => ({ dataBase64: "A".repeat(chars) });
  assert.equal(draftSize({ html: "<p>x</p>", text: "x", attachments: [pic(10)], inline: [pic(100), pic(1000)] }), 8 + 1 + 10 + 1100);
  assert.equal(draftSize({ attachments: [], inline: undefined }), 0);
  assert.ok(draftSize({ attachments: [pic(DRAFT_LIMIT)], inline: [pic(1)] }) > DRAFT_LIMIT);
  // the same coded error as the backend (lib.rs ensure_draft_size), so the same translated sentence is shown
  assert.equal(
    draftTooLargeError(101 * MiB - 5),
    "DRAFT_TOO_LARGE|size=101 MB|limit=100 MB: This message is too large to keep as a draft (101 MB; the limit is 100 MB). Remove attachments or shrink pictures.",
  );
}

console.log("test-send-size: ok");
