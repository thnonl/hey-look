// Synthetic PDFs for the tests of the PDF viewer (W5.1): written by hand, no personal data, a few kilobytes each. `node scripts/lib/pdf-fixtures.mjs [dir]` writes the four fixtures of the CDP test
// (scripts/fixtures/pdf/{one-page,thirty-pages,locked,damaged}.pdf, plus mixed-sizes.pdf, scripting.pdf and cjk.pdf); the QA kit builds its samples S1 to S10 from the same functions.
// Every function returns a Buffer. The files are byte-for-byte the same on every run (no dates, no random ids).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const latin = (s) => Buffer.from(s, "latin1");

/** A PDF written object by object. `obj` returns the object's number; `build` writes the header, the objects, the cross-reference table and the trailer. */
export class PdfWriter {
  constructor(version = "1.7") {
    this.version = version;
    this.objects = []; // Buffers, index = number - 1
  }
  /** Reserves an object number (so that objects can refer to each other). */
  reserve() {
    this.objects.push(null);
    return this.objects.length;
  }
  /** Sets the object `n`: `dict` without the surrounding << >>, and optionally a stream (a Buffer; /Length is added). */
  set(n, dict, stream) {
    const body = stream
      ? Buffer.concat([latin(`<< ${dict} /Length ${stream.length} >>\nstream\n`), stream, latin("\nendstream")])
      : latin(`<< ${dict} >>`);
    this.objects[n - 1] = body;
    return n;
  }
  /** Adds an object whose whole body is `text` (an array, a number, a string...). */
  raw(n, text) {
    this.objects[n - 1] = latin(text);
    return n;
  }
  obj(dict, stream) {
    return this.set(this.reserve(), dict, stream);
  }
  build({ root, extraTrailer = "" }) {
    const parts = [latin(`%PDF-${this.version}\n%\xe2\xe3\xcf\xd3\n`)];
    let pos = parts[0].length;
    const offsets = [];
    this.objects.forEach((body, i) => {
      if (!body) throw new Error(`object ${i + 1} was reserved and never set`);
      offsets.push(pos);
      const chunk = Buffer.concat([latin(`${i + 1} 0 obj\n`), body, latin("\nendobj\n")]);
      parts.push(chunk);
      pos += chunk.length;
    });
    const xref = [`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`];
    for (const o of offsets) xref.push(`${String(o).padStart(10, "0")} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R ${extraTrailer} >>\nstartxref\n${pos}\n%%EOF\n`);
    parts.push(latin(xref.join("")));
    return Buffer.concat(parts);
  }
}

const esc = (s) => s.replace(/[\\()]/g, "\\$&");

/** The content stream of a text page: a headline, a few lines, a coloured box (so that a page is never blank even when a font is missing). */
function pageContent({ title, lines = [], w, h, box = [0.1, 0.45, 0.8] }) {
  const out = [`${box[0]} ${box[1]} ${box[2]} rg 40 ${h - 80} ${Math.max(40, w - 80)} 24 re f`, "0 g", `BT /F1 20 Tf 44 ${h - 130} Td (${esc(title)}) Tj ET`];
  lines.forEach((l, i) => out.push(`BT /F1 12 Tf 44 ${h - 160 - i * 18} Td (${esc(l)}) Tj ET`));
  return Buffer.from(out.join("\n"), "latin1");
}

/** A document of `sizes.length` pages with the given sizes (in points), text on each, optionally with the links of sample S1. */
export function textDocument({ sizes, title = "Hey Look test page", links = false, version = "1.7" }) {
  const w = new PdfWriter(version);
  const catalog = w.reserve();
  const pagesRef = w.reserve();
  const font = w.obj("/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding");
  const kids = [];
  sizes.forEach(([pw, ph], i) => {
    const content = w.obj("", pageContent({ title: `${title} ${i + 1} of ${sizes.length}`, lines: ["The quick brown fox jumps over the lazy dog.", "0123456789 ÀÉÎÕÜ"], w: pw, h: ph }));
    let annots = "";
    if (links && i === 0) {
      const http = w.obj(`/Type /Annot /Subtype /Link /Rect [40 ${ph - 250} 300 ${ph - 230}] /Border [0 0 1] /C [0 0 1] /A << /S /URI /URI (https://example.com/inert-link) >>`);
      const mail = w.obj(`/Type /Annot /Subtype /Link /Rect [40 ${ph - 290} 300 ${ph - 270}] /Border [0 0 1] /C [0 0 1] /A << /S /URI /URI (mailto:inert@example.com) >>`);
      annots = `/Annots [${http} 0 R ${mail} 0 R]`;
    }
    const page = w.obj(`/Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> ${annots}`);
    kids.push(`${page} 0 R`);
  });
  w.set(pagesRef, `/Type /Pages /Count ${sizes.length} /Kids [${kids.join(" ")}]`);
  w.set(catalog, `/Type /Catalog /Pages ${pagesRef} 0 R`);
  return w.build({ root: catalog });
}

export const onePage = () => textDocument({ sizes: [[595, 842]], title: "Hey Look one page", links: true });
export const thirtyPages = () => textDocument({ sizes: Array.from({ length: 30 }, () => [595, 842]), title: "Hey Look page" });
/** Portrait A4, landscape A4, a small card, a tall strip: every page at its own size (S10). */
export const mixedSizes = () => textDocument({ sizes: [[595, 842], [842, 595], [300, 200], [200, 700]], title: "Hey Look sizes" });

/** The padding string of the standard security handler (ISO 32000-1, algorithm 2). */
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]) & 255;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 255];
  }
  return out;
}
const md5 = (b) => createHash("md5").update(b).digest();
const padded = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

/** A document that asks for a password (RC4, 128 bit, revision 3; the user password is `password`, the empty password does not open it). The contents are not encrypted: nothing reads them. */
export function lockedDocument(password = "secret") {
  const id = Buffer.from("48657920 4c6f6f6b 21207465 73742069".replace(/ /g, ""), "hex"); // "Hey Look! test i"
  const ownerPad = padded("owner-secret");
  let h = md5(ownerPad);
  for (let i = 0; i < 50; i++) h = md5(h);
  const ownerKey = h.subarray(0, 16);
  let O = rc4(ownerKey, padded(password));
  for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(ownerKey.map((b) => b ^ i)), O);
  const P = -44;
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  let key = md5(Buffer.concat([padded(password), O, pBytes, id]));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let U = rc4(key, md5(Buffer.concat([PAD, id])));
  for (let i = 1; i <= 19; i++) U = rc4(Buffer.from(key.map((b) => b ^ i)), U);
  U = Buffer.concat([U, Buffer.alloc(16)]);
  const w = new PdfWriter("1.6");
  const catalog = w.reserve();
  const pagesRef = w.reserve();
  const enc = w.reserve();
  const content = w.obj("", Buffer.from("BT /F1 12 Tf 40 700 Td (secret) Tj ET", "latin1"));
  const font = w.obj("/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding");
  const page = w.obj(`/Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >>`);
  w.set(pagesRef, `/Type /Pages /Count 1 /Kids [${page} 0 R]`);
  w.set(catalog, `/Type /Catalog /Pages ${pagesRef} 0 R`);
  w.set(enc, `/Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${O.toString("hex")}> /U <${U.toString("hex")}>`);
  const hex = id.toString("hex");
  return w.build({ root: catalog, extraTrailer: `/Encrypt ${enc} 0 R /ID [<${hex}> <${hex}>]` });
}

/** The header of a PDF, a catalog without pages, and nothing more (the file was cut off): it cannot be drawn. */
export const damaged = () => latin("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 8");

/** A page whose open action and a form field carry JavaScript (`app.alert`): the viewer must not run it (S9). */
export function scriptingDocument() {
  const w = new PdfWriter("1.7");
  const catalog = w.reserve();
  const pagesRef = w.reserve();
  const font = w.obj("/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding");
  const content = w.obj("", pageContent({ title: "Hey Look scripting", lines: ["This page has JavaScript that must not run."], w: 595, h: 842 }));
  const field = w.obj(`/Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (typed text) /Rect [40 500 300 530] /DA (/Helv 12 Tf 0 g) /AA << /Fo << /S /JavaScript /JS (app.alert('field focus script ran')) >> >>`);
  const page = w.obj(`/Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /Annots [${field} 0 R] /AA << /O << /S /JavaScript /JS (app.alert('page open script ran')) >> >>`);
  w.set(pagesRef, `/Type /Pages /Count 1 /Kids [${page} 0 R]`);
  w.set(catalog, `/Type /Catalog /Pages ${pagesRef} 0 R /AcroForm << /Fields [${field} 0 R] /DA (/Helv 0 Tf 0 g) >> /OpenAction << /S /JavaScript /JS (app.alert('open action script ran')) >> /Names << /JavaScript << /Names [(init) << /S /JavaScript /JS (app.alert('document script ran')) >>] >> >>`);
  return w.build({ root: catalog });
}

/** Chinese and Japanese text in fonts that are NOT embedded: the characters come from the cMaps (UniGB-UCS2-H, UniJIS-UCS2-H) and a system or fallback font (S3). */
export function cjkDocument() {
  const w = new PdfWriter("1.7");
  const catalog = w.reserve();
  const pagesRef = w.reserve();
  const zhDesc = w.obj("/Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93");
  const zhCid = w.obj(`/Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor ${zhDesc} 0 R /DW 1000`);
  const zh = w.obj(`/Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [${zhCid} 0 R]`);
  const jaDesc = w.obj("/Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [-123 -257 1001 910] /ItalicAngle 0 /Ascent 723 /Descent -241 /CapHeight 709 /StemV 69");
  const jaCid = w.obj(`/Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${jaDesc} 0 R /DW 1000`);
  const ja = w.obj(`/Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3-UniJIS-UCS2-H /Encoding /UniJIS-UCS2-H /DescendantFonts [${jaCid} 0 R]`);
  const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const content = w.obj("", Buffer.from(`0.1 0.45 0.8 rg 40 760 515 24 re f 0 g\nBT /F2 28 Tf 44 700 Td <${hex("你好，世界")}> Tj ET\nBT /F3 28 Tf 44 640 Td <${hex("こんにちは世界")}> Tj ET`, "latin1"));
  const page = w.obj(`/Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F2 ${zh} 0 R /F3 ${ja} 0 R >> >>`);
  w.set(pagesRef, `/Type /Pages /Count 1 /Kids [${page} 0 R]`);
  w.set(catalog, `/Type /Catalog /Pages ${pagesRef} 0 R`);
  return w.build({ root: catalog });
}

/** The fixtures of the CDP test. */
export const FIXTURES = { "one-page.pdf": onePage, "thirty-pages.pdf": thirtyPages, "locked.pdf": () => lockedDocument(), "damaged.pdf": damaged, "mixed-sizes.pdf": mixedSizes, "scripting.pdf": scriptingDocument, "cjk.pdf": cjkDocument };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pdf"));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, make] of Object.entries(FIXTURES)) {
    const bytes = make();
    fs.writeFileSync(path.join(dir, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}

