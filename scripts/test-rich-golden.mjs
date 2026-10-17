// Golden files of the rich-text compose editor (spec-rich-text.md REQ-8, AC-9, AC-15): every fixture in scripts/fixtures/rich/<name>.json is an
// editor document (what `editor.getJSON()` returns) with the message's default font and, optionally, a signature. It goes through the same
// steps as Compose.buildDraft (src/editor/messageBody.ts: serializer, signature, pictures as cid parts, default font wrapper) and through the
// plain-text generator (src/htmlText.ts); the result must equal <name>.html and <name>.txt byte for byte.
// The same .html files are fed to the outgoing sanitiser by `cargo test --lib outgoing` (it must not change a byte of them), so what the
// serializer writes is what the sanitiser lets through.
//
//   node --experimental-strip-types scripts/test-rich-golden.mjs           check
//   node --experimental-strip-types scripts/test-rich-golden.mjs --update  write the expected files (then read the diff before you commit it)
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docToHtml, unwrapBase, wrapBase } from "../src/editor/emailHtml.ts";
import { fillSignatureStr, messageHtml, swapPictures } from "../src/editor/messageBody.ts";
import { FONTS, SIZES, familyName, fontOf, normFamily, normSize, sizePt, stackFor, stepSize } from "../src/editor/fonts.ts";
import { HIGHLIGHTS, STANDARD, normColor, pushRecent, shadeOf, themeGrid } from "../src/editor/colors.ts";
import { htmlToText } from "../src/htmlText.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rich");
const update = process.argv.includes("--update");

// ---- the fixtures
const names = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
assert.ok(names.length >= 10, "the fixtures are there");
for (const name of names) {
  const fx = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  let n = 0;
  const { html, inline } = messageHtml(fx.doc, { sig: fx.sig ?? null, base: fx.base, pictures: "cid", newCid: () => `cid-${++n}@heylook`, fileName: (mime, i) => `picture-${i}.${mime.split("/")[1]}` });
  const text = htmlToText(html) + "\n";
  for (const [ext, got] of [["html", html + "\n"], ["txt", text]]) {
    const file = join(dir, `${name}.${ext}`);
    if (update) writeFileSync(file, got);
    else {
      assert.ok(existsSync(file), `${name}.${ext} is missing (run with --update)`);
      assert.equal(got, readFileSync(file, "utf8").replace(/\r\n/g, "\n"), `${name}.${ext} differs from the golden file`);
    }
  }
  // the message is a single box with the default font, and nothing the sanitiser would have to take away
  const w = unwrapBase(html);
  assert.ok(w.base && Math.abs(w.base.size - fx.base.size) < 1e-9 && w.base.family === fx.base.family, `${name}: the default font is in the wrapper`);
  assert.equal(wrapBase(w.html, w.base), html, `${name}: wrap(unwrap(x)) is x`);
  for (const bad of ["<script", "<style", "javascript:", "file:", "url(", ";position", "<img src=x", "class=\"ProseMirror", " data-", "<iframe"]) {
    if (name !== "security") continue;
    assert.ok(!html.toLowerCase().includes(bad), `${name}: ${bad} in ${html}`);
  }
  assert.ok(!/\sclass="(?!sig")/.test(html) && !/<style|\sid=|\sdata-/.test(html), `${name}: no class (except sig), id, data- or <style>`);
  if (name === "kitchen-sink") assert.equal(inline.length, 1, "the picture is an inline part");
}

// ---- the serializer on its own
const P = (t) => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const base = { family: "Calibri,Carlito,Arial,sans-serif", size: 11 };
assert.equal(docToHtml({ type: "doc", content: [P("a")] }), '<p style="margin:0">a</p>');
assert.equal(docToHtml({ type: "doc", content: [{ type: "paragraph" }] }), '<p style="margin:0"><br></p>', "an empty paragraph keeps its height");
assert.equal(wrapBase("<p>x</p>", { family: "'Segoe UI',Arial,sans-serif", size: 10.5 }), '<div style="font-family:\'Segoe UI\',Arial,sans-serif;font-size:10.5pt"><p>x</p></div>');
// unwrapBase: only a box that holds the whole message and has exactly family + size
assert.deepEqual(unwrapBase('<div style="font-family:Arial,sans-serif;font-size:12pt"><p>x</p></div>').base, { family: "Arial,sans-serif", size: 12 });
assert.equal(unwrapBase('<div style="font-family:Arial;font-size:12pt"><div>in</div></div>').html, "<div>in</div>", "an inner div does not end the wrapper");
assert.equal(unwrapBase('<div style="font-family:Arial;font-size:12pt"><p>x</p></div><p>after</p>').base, null, "something after the box: not a wrapper");
assert.equal(unwrapBase('<div style="font-family:Arial;font-size:12pt;color:red"><p>x</p></div>').base, null, "other declarations: not our wrapper");
assert.equal(unwrapBase("<p>An old draft</p>").base, null);
assert.equal(unwrapBase("").base, null);

// ---- signature and pictures
assert.equal(fillSignatureStr('<p style="margin:0">Hi</p><div data-sig-block></div><p style="margin:0"><br></p>', "Nam"), '<p style="margin:0">Hi</p><br><div class="sig">-- <br>Nam</div>');
assert.equal(fillSignatureStr('<p style="margin:0">Hi</p><div data-sig-block></div><p style="margin:0"><br></p>', null), '<p style="margin:0">Hi</p>', "no signature: marker and trailing empty paragraphs go");
assert.equal(fillSignatureStr('<p style="margin:0">Hi</p><div data-sig-block></div><p style="margin:0">after</p>', "S").endsWith("after</p>"), true, "a paragraph with text after the signature stays");
{
  let k = 0;
  const r = swapPictures('<p><img src="data:image/png;base64,AAAA" alt="a" style="max-width:100%;height:auto" data-name="my &amp; pic.png"><img src="https://x.test/p.gif"><img src=\'data:image/jpeg;base64,BBBB\'></p>', () => `c${++k}`, (m, i) => `picture-${i}`);
  assert.equal(r.html, '<p><img src="cid:c1" alt="a" style="max-width:100%;height:auto"><img src="https://x.test/p.gif"><img src="cid:c2"></p>');
  assert.deepEqual(r.inline.map((x) => [x.cid, x.mime, x.dataBase64, x.name]), [["c1", "image/png", "AAAA", "my & pic.png"], ["c2", "image/jpeg", "BBBB", "picture-2"]]);
}

// ---- fonts and sizes (spec 2.4)
assert.equal(FONTS.length, 16);
assert.equal(normFamily("\"Comic Sans MS\", cursive"), "'Comic Sans MS',cursive");
assert.equal(normFamily("Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif"), "'Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif");
assert.equal(normFamily("x;position:fixed"), "'xposition:fixed'", "no declaration can be smuggled in a family");
assert.equal(familyName("'Segoe UI',Arial"), "Segoe UI");
assert.equal(fontOf("Georgia, serif")?.name, "Georgia");
assert.equal(fontOf("Nonexistent Font"), undefined);
for (const f of FONTS) assert.equal(normFamily(f.stack), f.stack, `${f.name}: the stack is written canonically`);
assert.equal(stackFor("georgia"), "Georgia,serif");
assert.equal(stackFor("My Font"), "'My Font'");
assert.equal(sizePt("14pt"), 14);
assert.equal(sizePt("18.6667px"), 14);
assert.equal(sizePt("1em"), null);
assert.equal(normSize("14.0pt"), "14pt");
assert.equal(normSize("10.50 pt"), "10.5pt");
assert.equal(normSize("9pt;top:0"), "");
assert.equal(stepSize(11, 1), 12);
assert.equal(stepSize(8, -1), 8, "Ctrl+[ on 8 pt stays 8 pt");
assert.equal(stepSize(72, 1), 72, "Ctrl+] on 72 pt stays 72 pt");
assert.equal(stepSize(10, 1), 10.5);
assert.equal(stepSize(10.5, -1), 10);
assert.equal(stepSize(13, 1), 14, "a size that is not listed goes to the next one");
assert.equal(stepSize(13, -1), 12);
assert.deepEqual([...SIZES], [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]);

// ---- colours
assert.equal(normColor("rgb(192, 0, 0)"), "#C00000");
assert.equal(normColor("#0f0"), "#00FF00");
assert.equal(normColor("Blue"), "blue");
assert.equal(normColor("red;background:url(x)"), "", "only a plain colour is written");
assert.equal(normColor("var(--x)"), "");
assert.equal(STANDARD.length, 10);
assert.equal(HIGHLIGHTS.length, 15);
{
  const g = themeGrid();
  assert.equal(g.length, 6);
  assert.ok(g.every((r) => r.length === 10));
  // Word's Accent 1 (4472C4): lighter 80 % = D9E2F3, lighter 40 % = 8FAADC, darker 25 % = 2F5597 (Word rounds its HSL steps, so one unit of a channel is allowed)
  const near = (got, want) => [1, 3, 5].every((i) => Math.abs(parseInt(got.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= 1);
  assert.ok(near(shadeOf("#4472C4", "lighter", 80), "#D9E2F3"), shadeOf("#4472C4", "lighter", 80));
  assert.ok(near(shadeOf("#4472C4", "lighter", 40), "#8FAADC"), shadeOf("#4472C4", "lighter", 40));
  assert.ok(near(shadeOf("#4472C4", "darker", 25), "#2F5597"), shadeOf("#4472C4", "darker", 25));
  assert.ok(near(shadeOf("#4472C4", "darker", 50), "#203864"), shadeOf("#4472C4", "darker", 50));
  assert.deepEqual(g[1].slice(0, 2).map((s) => s.hex), ["#F2F2F2", "#7F7F7F"]);
}
assert.deepEqual(pushRecent(["#111111", "#222222"], "#222222"), ["#222222", "#111111"], "a colour used again moves to the front");
assert.equal(pushRecent(Array.from({ length: 10 }, (_, i) => `#0000${String(i).padStart(2, "0")}`), "#FFFFFF").length, 10, "ten at most");
assert.deepEqual(pushRecent(["#111111"], "not a colour"), ["#111111"]);

console.log(`rich-golden: ${names.length} fixtures and the unit checks passed${update ? " (golden files written)" : ""}`);
