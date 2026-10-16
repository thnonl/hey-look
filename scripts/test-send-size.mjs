// The size of a message on the wire (G-07 / CF-21): base64 + line breaks + part headers, against the server's SIZE or the usual 25 MB.
// Run: node --experimental-strip-types scripts/test-send-size.mjs
import assert from "node:assert/strict";
import { ARMOR, USUAL_LIMIT, attachmentWire, base64Chars, base64Wire, partHeaders, pictureWire, sendLimit, wireSize, worthAsking } from "../src/sendSize.ts";

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
assert.deepEqual(sendLimit(35_882_577), { bytes: 35_882_577, fromServer: true }, "a server that takes more than 25 MB is believed");
// a 24.9 MiB file against a 10 MiB server: over; against a 50 MiB server: fits
assert.ok(w > sendLimit(10_485_760).bytes && w < sendLimit(50 * MiB).bytes);
assert.ok(worthAsking(9 * MiB) && !worthAsking(1 * MiB));

console.log("test-send-size: ok");
