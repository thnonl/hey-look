#!/usr/bin/env node
// What a message starts with (1.0.7 WP13f-3, DEC-023, REQ-13.13.11-12): src/composeStart.ts (the recipients and the rows that show them, the attachments, the Encrypt / Sign start values)
// and src/composeBody.ts (the first content of the editor) are used by BOTH ways a Compose gets its content - the fresh mount and the in-place fill of a Reply / Forward shell - so
// this is where the two cannot drift: the helpers against the expressions they replaced in components/Compose.tsx, one by one, and the source guards that both paths call them.
//   node --experimental-strip-types scripts/test-compose-start.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { isFreshMessage, startAttachments, startRecipients, startSecurity } from "../src/composeStart.ts";
import { answerBodyHtml } from "../src/composeBody.ts";
import { extractQuote, quoteSentHtml } from "../src/editor/quoteBlock.ts";
import { stripRemotePictures } from "../src/pastedHtml.ts";
import { SIG_MARK } from "../src/signature.ts";

const none = { cc: "", bcc: "" };

// ---- recipients: the expressions of the old useState start values
{
  const old = (init, auto) => {
    const fresh = !init.replaces && !init.isReply && !init.outboxId && !init.restore;
    const clean = (s) => s.replace(/[\r\n]+/g, " ").trim();
    const ac = fresh ? auto.cc.trim() : "";
    const ab = fresh ? auto.bcc.trim() : "";
    const to = (init.to ?? []).map(clean);
    const cc = [...(init.cc ?? []).map(clean), ...(ac ? [ac] : [])];
    const bcc = [...(init.bcc ?? []).map(clean), ...(ab ? [ab] : [])];
    return { to, cc, bcc, showCc: cc.length > 0 || bcc.length > 0 };
  };
  const cases = [
    [{}, none],
    [{}, { cc: " boss@x.test ", bcc: "audit@x.test" }],
    [{ isReply: true, to: ["a@x.test"], cc: ["b@x.test", "c@x.test"] }, { cc: "boss@x.test", bcc: "audit@x.test" }], // (a reply never gets the Auto Cc / Bcc)
    [{ to: [], subject: "Fwd: x" }, { cc: "", bcc: "audit@x.test" }], // (a forward does)
    [{ to: ["a@x.test\r\nBcc: evil@x.test"] }, none], // (never a line break in a header)
    [{ replaces: "m:1", to: ["a@x.test"] }, { cc: "boss@x.test", bcc: "" }],
    [{ outboxId: "o1", cc: ["q@x.test"] }, { cc: "boss@x.test", bcc: "" }],
    [{ restore: { encrypt: "on", sign: false, attachKey: false }, bcc: ["z@x.test"] }, { cc: "boss@x.test", bcc: "" }],
  ];
  for (const [init, auto] of cases) {
    const got = startRecipients(init, auto);
    const want = old(init, auto);
    assert.deepEqual({ ...got, showCc: undefined }, { ...want, showCc: undefined }, `recipients of ${JSON.stringify(init)}`);
    assert.equal(got.showCc, want.showCc, `the Cc rows of ${JSON.stringify(init)}`);
  }
  // REQ-13.13.12: the shell of a Reply all that has Cc recipients shows the rows before the message is there; a plain reply's shell does not
  assert.equal(startRecipients({ isReply: true, preparing: { kind: "reply", id: "s", key: "k", at: 0, rcpt: { to: ["a@x.test"], cc: ["c@x.test"] } } }, none).showCc, true, "Reply all with Cc: the rows are in the shell");
  assert.equal(startRecipients({ isReply: true, preparing: { kind: "reply", id: "s", key: "k", at: 0, rcpt: { to: ["a@x.test"], cc: [] } } }, none).showCc, false, "Reply (no Cc expected): no Cc rows");
  assert.equal(startRecipients({ isReply: true, preparing: { kind: "reply", id: "s", key: "k", at: 0 } }, none).showCc, false, "Reply: no Cc rows");
  assert.equal(startRecipients({ preparing: { kind: "forward", id: "s", key: "k", at: 0 } }, { cc: "", bcc: "audit@x.test" }).showCc, true, "Forward with an Auto Bcc: the Bcc row is in the shell");
  // ... and the finished message (no `preparing`) shows them when it has Cc recipients, which is what the fill adds to the rows the shell had
  assert.equal(startRecipients({ isReply: true, cc: ["c@x.test"] }, none).showCc, true);
  assert.equal(isFreshMessage({}), true);
  assert.equal(isFreshMessage({ isReply: true }), false);
}

// ---- attachments
{
  const atts = [{ filename: "a/b/report.pdf", mime: "application/pdf", dataBase64: "AA==" }, { filename: "con.txt‮", mime: "text/plain", dataBase64: "AA==" }];
  const got = startAttachments({ attachments: atts });
  assert.equal(got.length, 2);
  assert.ok(!got[0].filename.includes("/"), "no folder in the name");
  assert.ok(!got[1].filename.includes("‮"), "no hidden characters in the name");
  assert.equal(got[0].dataBase64, "AA==", "the data stays");
  assert.deepEqual(startAttachments({}), []);
}

// ---- Encrypt / Sign start values
{
  const off = { encrypt: "never", sign: false, attachKey: false };
  assert.deepEqual(startSecurity({}, off), { encIntent: "off", sign: false, attachKey: false });
  assert.deepEqual(startSecurity({}, { encrypt: "always", sign: true, attachKey: true }), { encIntent: "on", sign: true, attachKey: true });
  assert.equal(startSecurity({}, { encrypt: "possible", sign: false, attachKey: false }).encIntent, "auto");
  // an answer to encrypted mail is encrypted whatever the settings say
  assert.deepEqual(startSecurity({ security: { encrypt: true, sign: false, attachPublicKey: true } }, off), { encIntent: "on", sign: false, attachKey: true });
  assert.equal(startSecurity({ security: { encrypt: false, sign: true, attachPublicKey: false } }, { encrypt: "always", sign: false, attachKey: false }).encIntent, "off");
  // a message that came back after a failed send or an Undo has them as they were
  assert.deepEqual(startSecurity({ restore: { encrypt: "auto", sign: true, attachKey: false }, security: { encrypt: true, sign: false, attachPublicKey: true } }, off), { encIntent: "auto", sign: true, attachKey: false });
}

// ---- the first content of the editor: the expression it replaced, for a new message and for answers
{
  const old = (bodyHtml) => stripRemotePictures(`<p></p>${SIG_MARK}${extractQuote(bodyHtml ?? "<p></p>").html}`).html;
  const quote = (kind, html) => quoteSentHtml({ kind, head: "On Sat, 24 Oct 2026 14:10, Linh &lt;l@x.test&gt; wrote:", html });
  const bodies = [
    undefined,
    "",
    "<p>typed</p>",
    quote("reply", "<p>Hello <b>team</b></p><table><tr><td>cell</td></tr></table>"),
    quote("forward", '<p>Look: <img src="https://tracker.example.invalid/p.png" width="1" height="1"> <a href="https://x.test">link</a></p>'),
    quote("reply", ""),
    quote("reply", '<div style="font-family:Georgia"><h2>Plan</h2><ul><li>one</li></ul><blockquote>older</blockquote></div>'),
    "<br>" + quote("reply", "<p>x</p>"),
  ];
  for (const b of bodies) assert.equal(answerBodyHtml(b), old(b), `the first content of ${JSON.stringify(b)?.slice(0, 80)}`);
  // what it is: an empty line to type in, then the signature region, then the quote block (once)
  const doc = answerBodyHtml(quote("reply", "<p>Hi</p>"));
  assert.ok(doc.startsWith("<p></p>" + SIG_MARK), "an empty line, then the signature region");
  assert.equal((doc.match(/data-sig-block/g) ?? []).length, 1, "the signature region is there once");
  assert.ok(answerBodyHtml(undefined, "<p>typed</p>").startsWith("<p>typed</p>" + SIG_MARK) && answerBodyHtml(undefined, "").startsWith("<p></p>" + SIG_MARK), "the text of an email link (W8.10) comes above the signature region; none: an empty line");
  assert.ok(!/tracker\.example\.invalid/.test(answerBodyHtml('<p>x <img src="https://tracker.example.invalid/p.png"></p>')), "a remote picture never comes into the editor");
}

// ---- both paths use the helpers (the mount in components/Compose.tsx, the fill in the same file; the frame of the pane for the rows)
{
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const compose = read("src/components/Compose.tsx");
  assert.ok(/startRecipients\(init, /.test(compose) && /useState<string\[\]>\(start\.to\)/.test(compose), "the mount takes its recipients from startRecipients");
  assert.ok(/shellSeen && !init\.preparing/.test(compose) && /setTo\(r\.to\)/.test(compose) && /setShowCc\(\(was\) => was \|\| r\.showCc\)/.test(compose), "the fill sets the same fields from the same helper, in one render");
  assert.ok(/content: \(startContent\.current \?\?= editing \? stripRemotePictures\(startDoc\.current!\.html\)\.html : answerBodyHtml\(init\.bodyHtml, init\.typedHtml\)\)/.test(compose), "the mount builds the editor content with answerBodyHtml");
  assert.ok(/\.setContent\(answerBodyHtml\(full\.bodyHtml\)\)/.test(compose), "the fill builds it with the same helper");
  assert.ok(/\.setMeta\("addToHistory", false\)/.test(compose) && /\.setMeta\("signatureInit", true\)/.test(compose), "the fill is one transaction that is not in the undo history and not an edit");
  assert.ok(/\[reply\] fill: fallback/.test(compose) && /useStore\.getState\(\)\.openCompose\(full\)/.test(compose), "a fill that throws opens the message the way it was opened before");
  assert.ok(/startRecipients\(init, /.test(read("src/components/ComposeFrame.tsx")), "the frame of the pane has the same rows");
}

console.log("test-compose-start: ok");
