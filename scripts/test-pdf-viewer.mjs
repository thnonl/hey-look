// 1.0.7 W5.1 (REQ-5.1.1 to 5.1.11; AC-5.1.12, AC-5.1.13, AC-5.1.15), no browser. Run: node --experimental-strip-types scripts/test-pdf-viewer.mjs
//   - the pure rules of the viewer (src/pdfViewLogic.ts): zoom steps, scales, the canvas resolution, the layout of the pages, the page in the middle, the pages that are drawn and dropped,
//     the state machine (loading, ready, locked, damaged, unavailable) and what a failed load means
//   - the files of PDF.js that ship (scripts/vite-pdfjs-assets.mjs): the worker, cMaps, fonts, the JavaScript decoders, the icc profile and every licence; not web/, legacy/, the sandbox, quickjs, the .wasm
//     files or the source maps
//   - the wiring: the library is a lazy chunk (nothing of it in the first chunk, in the budget's mustBeLazy), the bytes pass isPdfBytes before PDF.js sees them, no blob URL / frame / object / embed in
//     the PDF.js mode, no annotation layer, no XFA, no scripting, no WebAssembly, the shipped policy is not changed, the decision per system
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canDrop, classifyLoadError, CSS_UNITS, cssScale, KEEP_PAGES, layoutPages, MAX_CANVAS_PIXELS, messageFor, nextViewState, outputScale, pageAtMiddle, PAGE_GAP, pagesToDraw, PRELOAD_PAGES,
  SIDE_ROOM, visiblePages, zoomIn, zoomLabel, zoomOut, ZOOM_STEPS,
} from "../src/pdfViewLogic.ts";
import { assetList, PDFJS_DIR } from "./vite-pdfjs-assets.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
let n = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (e) {
    e.message = `${label}: ${e.message}`;
    throw e;
  }
  n++;
};

// ---- zoom
check("the zoom steps are Fit, 100, 150, 200 and the buttons stop at the ends", () => {
  assert.deepEqual([...ZOOM_STEPS], ["fit", 1, 1.5, 2]);
  assert.equal(zoomIn("fit"), 1);
  assert.equal(zoomIn(1), 1.5);
  assert.equal(zoomIn(1.5), 2);
  assert.equal(zoomIn(2), 2, "no step above 200 %");
  assert.equal(zoomOut(2), 1.5);
  assert.equal(zoomOut(1.5), 1);
  assert.equal(zoomOut(1), "fit");
  assert.equal(zoomOut("fit"), "fit", "no step below Fit");
  assert.equal(zoomLabel("fit"), null, "Fit is a word of the language, not a number");
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(1.5), "150%");
  assert.equal(zoomLabel(2), "200%");
});

check("the scale: Fit fills the stage between the side rooms, a number is the real size at 96 dpi", () => {
  assert.equal(SIDE_ROOM, 48);
  assert.ok(Math.abs(cssScale("fit", 595, 1100) - (1100 - 96) / 595) < 1e-9);
  assert.ok(Math.abs(cssScale(1, 595, 1100) - CSS_UNITS) < 1e-9, "100 % = 96 / 72");
  assert.ok(Math.abs(cssScale(2, 595, 300) - 2 * CSS_UNITS) < 1e-9, "a number does not depend on the stage");
  assert.equal(cssScale("fit", 595, 0), 0.1, "an empty stage does not give 0 or a negative scale");
  assert.equal(cssScale("fit", 0, 800), 8, "a page of width 0 is bounded");
  assert.equal(cssScale("fit", 10, 5000), 8);
});

check("the canvas resolution: the device pixel ratio, at most 2, less for a poster", () => {
  assert.equal(outputScale(1, 800, 1000), 1);
  assert.equal(outputScale(2, 800, 1000), 2);
  assert.equal(outputScale(3, 800, 1000), 2, "a 3x display still gets 2");
  assert.equal(outputScale(0.5, 800, 1000), 1, "never below 1 for an ordinary page");
  assert.equal(outputScale(Number.NaN, 800, 1000), 1);
  const big = outputScale(2, 4000, 6000); // 24 million CSS pixels already
  assert.ok(big < 1 && big >= 0.25 && 4000 * 6000 * big * big <= MAX_CANVAS_PIXELS * 1.001, `a poster is drawn at ${big}`);
  const mid = outputScale(2, 2000, 3000); // 6 M css px: 24 M at 2x, too many
  assert.ok(2000 * 3000 * mid * mid <= MAX_CANVAS_PIXELS * 1.001 && mid > 1, `${mid}`);
});

// ---- layout
const SIZES = [{ w: 595, h: 842 }, { w: 842, h: 595 }, { w: 300, h: 200 }];
check("the layout puts pages one under the other, 16 px apart, and each at its own scale in Fit", () => {
  const l = layoutPages(SIZES, "fit", 1100);
  assert.equal(l.tops[0], PAGE_GAP);
  for (let i = 1; i < 3; i++) assert.equal(l.tops[i], l.tops[i - 1] + l.heights[i - 1] + PAGE_GAP);
  assert.equal(l.total, l.tops[2] + l.heights[2] + PAGE_GAP);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(l.widths[i] - (1100 - 96)) <= 1, `page ${i + 1} fills the width in Fit: ${l.widths[i]}`);
  assert.equal(l.maxWidth, Math.max(...l.widths));
  const z = layoutPages(SIZES, 1.5, 1100);
  const k = 1.5 * CSS_UNITS;
  assert.equal(z.widths[0], Math.round(595 * k));
  assert.equal(z.heights[1], Math.round(595 * k));
  assert.equal(z.scales[0], z.scales[2], "one scale for every page at a number");
  assert.deepEqual(layoutPages([], "fit", 1100).tops, []);
});

check("the page in the middle of the stage; between two pages the one above", () => {
  const l = layoutPages(Array.from({ length: 30 }, () => ({ w: 595, h: 842 })), "fit", 1100);
  const view = 600;
  assert.equal(pageAtMiddle(l.tops, l.heights, 0, view), 0);
  assert.equal(pageAtMiddle(l.tops, l.heights, l.tops[4] - view / 2 + 10, view), 4, "page 5 covers the middle");
  assert.equal(pageAtMiddle(l.tops, l.heights, l.tops[4] - view / 2 - 4, view), 3, "the middle is in the gap above page 5: page 4");
  assert.equal(pageAtMiddle(l.tops, l.heights, l.total, view), 29, "past the end: the last page");
  assert.equal(pageAtMiddle([], [], 0, view), 0);
});

check("the pages that are visible, drawn in advance (one more each side), nearest to the middle first, and dropped when far", () => {
  const l = layoutPages(Array.from({ length: 30 }, () => ({ w: 595, h: 842 })), "fit", 1100);
  const view = 600;
  const top = l.tops[10] - 20;
  const vis = visiblePages(l.tops, l.heights, top, view);
  assert.deepEqual(vis, { from: 9, to: 10 }, "page 10 (index 9) still shows 4 px at the top, page 11 follows");
  const list = pagesToDraw(l.tops, l.heights, top, view, 30);
  assert.deepEqual([...list].sort((a, b) => a - b), [8, 9, 10, 11], "one page in advance on each side");
  assert.equal(PRELOAD_PAGES, 1);
  assert.equal(list[0], pageAtMiddle(l.tops, l.heights, top, view), "the page in the middle first");
  assert.deepEqual(pagesToDraw(l.tops, l.heights, 0, view, 30).sort((a, b) => a - b), [0, 1], "no page above the first");
  assert.deepEqual(pagesToDraw([], [], 0, view, 0), []);
  assert.equal(visiblePages([], [], 0, 100), null);
  assert.equal(canDrop(9, vis), false);
  assert.equal(canDrop(vis.from - KEEP_PAGES, vis), false);
  assert.equal(canDrop(vis.from - KEEP_PAGES - 1, vis), true);
  assert.equal(canDrop(vis.to + KEEP_PAGES + 1, vis), true);
  assert.equal(canDrop(3, null), true);
});

// ---- states
check("the state of the viewer: loading until the first page is drawn; password, damaged, timeout; the engine gone", () => {
  assert.equal(nextViewState("loading", "page1"), "ready");
  assert.equal(nextViewState("loading", "password"), "locked");
  assert.equal(nextViewState("loading", "error"), "damaged");
  assert.equal(nextViewState("loading", "timeout"), "damaged", "page 1 not drawn within the time: the could-not-be-drawn message");
  assert.equal(nextViewState("loading", "unavailable"), "unavailable");
  for (const s of ["ready", "locked", "damaged"]) {
    for (const ev of ["page1", "password", "error", "timeout"]) assert.equal(nextViewState(s, ev), s, `${s} + ${ev} stays`);
    assert.equal(nextViewState(s, "unavailable"), "unavailable", "the engine going away always wins");
  }
  assert.equal(nextViewState("unavailable", "page1"), "unavailable");
});

check("a failed load: a password, a worker that could not be set up, or a damaged file", () => {
  assert.equal(classifyLoadError({ name: "PasswordException", message: "No password given" }), "password");
  assert.equal(classifyLoadError({ name: "InvalidPDFException", message: "Invalid PDF structure." }), "damaged");
  assert.equal(classifyLoadError({ name: "MissingPDFException", message: "Missing PDF" }), "damaged");
  assert.equal(classifyLoadError({ name: "FormatError", message: "bad xref" }), "damaged");
  assert.equal(classifyLoadError(new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module".')), "unavailable");
  assert.equal(classifyLoadError({ name: "Error", message: "Worker was destroyed" }), "damaged", "any other worker message is not a missing engine");
  assert.equal(classifyLoadError("boom"), "damaged");
  assert.equal(classifyLoadError(null), "damaged");
  assert.equal(classifyLoadError(undefined), "damaged");
});

check("the message of a state: locked and damaged have one, the others none", () => {
  assert.equal(messageFor("locked"), "reading.pv.pdfLocked");
  assert.equal(messageFor("damaged"), "reading.pv.pdfNotDrawn");
  for (const s of ["loading", "ready", "unavailable"]) assert.equal(messageFor(s), null);
});

// ---- the files that ship
check("the files of PDF.js that ship, and not the ones that must not", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PDFJS_DIR, "package.json"), "utf8"));
  const list = assetList();
  const urls = list.map((a) => a.url);
  for (const a of list) assert.ok(fs.existsSync(a.file), `${a.file} is missing`);
  assert.ok(urls.includes("pdfjs/pdf.worker.min.mjs"));
  assert.ok(urls.includes("pdfjs/LICENSE"), "the package licence");
  for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    assert.ok(urls.some((u) => u.startsWith(`pdfjs/${dir}/`)), `${dir} ships`);
    assert.ok(urls.some((u) => u.startsWith(`pdfjs/${dir}/`) && /LICENSE/.test(u)), `${dir} carries its licence file`);
  }
  assert.ok(urls.filter((u) => u.startsWith("pdfjs/cmaps/") && u.endsWith(".bcmap")).length > 150, "the packed cMaps");
  assert.ok(urls.includes("pdfjs/cmaps/UniGB-UCS2-H.bcmap") && urls.includes("pdfjs/cmaps/UniJIS-UCS2-H.bcmap"), "Chinese and Japanese text");
  assert.ok(urls.includes("pdfjs/standard_fonts/LiberationSans-Regular.ttf") && urls.includes("pdfjs/standard_fonts/FoxitSerif.pfb"));
  assert.ok(urls.includes("pdfjs/wasm/openjpeg_nowasm_fallback.js") && urls.includes("pdfjs/wasm/jbig2_nowasm_fallback.js"), "JPEG 2000 and JBIG2 in JavaScript");
  assert.ok(urls.includes("pdfjs/iccs/CGATS001Compat-v2-micro.icc"));
  for (const u of urls) {
    assert.ok(!/\.wasm$/.test(u), `${u}: WebAssembly is never used`);
    assert.ok(!/quickjs|sandbox|\.map$|^pdfjs\/(web|legacy|image_decoders)\//.test(u), `${u} must not ship`);
  }
  const size = list.reduce((s, a) => s + fs.statSync(a.file).size, 0);
  assert.ok(size < 5 * 1024 * 1024, `the assets are ${size} bytes`);
  // the version is pinned exactly, in package.json and in the lock file
  const dep = JSON.parse(read("package.json")).dependencies["pdfjs-dist"];
  assert.match(dep, /^\d+\.\d+\.\d+$/, "an exact version, never a range");
  assert.equal(pkg.version, dep, "the installed copy is the pinned one");
  assert.equal(JSON.parse(read("package-lock.json")).packages["node_modules/pdfjs-dist"].version, dep);
  assert.equal(JSON.parse(read("package-lock.json")).packages[""].dependencies["pdfjs-dist"], dep);
});

// ---- the wiring
const view = read("src/pdfView.tsx");
const att = read("src/components/Attachments.tsx");
const lazy = read("src/lazyViews.tsx");

check("PDF.js is a lazy chunk: only src/lazyViews.tsx imports the viewer, nothing static imports the library", () => {
  const importers = fs.readdirSync(path.join(root, "src"), { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f));
  for (const f of importers) {
    const src = read(`src/${f.replace(/\\/g, "/")}`);
    if (f !== "pdfView.tsx") assert.ok(!/from "pdfjs-dist|import\("pdfjs-dist/.test(src), `${f} imports PDF.js`);
    if (f !== "lazyViews.tsx" && f !== "pdfView.tsx") assert.ok(!/(from|import\()\s*"\.{1,2}\/pdfView"/.test(src.replace(/import type [^;]*;/g, "")), `${f} imports the viewer statically`);
  }
  assert.match(lazy, /const pdfViewModule = \(\) => import\("\.\/pdfView"\);/);
  assert.match(lazy, /export const LazyPdfView = lazyView</);
  assert.match(att, /import \{ LazyPdfView \} from "\.\.\/lazyViews";/);
  const budget = JSON.parse(read("scripts/bundle-budget.json"));
  const lazyMods = budget.mustBeLazy.map((m) => m.module);
  assert.ok(lazyMods.includes("src/pdfView.tsx") && lazyMods.includes("src/pdfViewLogic.ts") === false, "the viewer is in mustBeLazy (its pure rules are small and shared)");
  assert.ok(lazyMods.includes("node_modules/pdfjs-dist/*"), "the library is in mustBeLazy");
  const entry = budget.mustBeLazy.find((m) => m.module === "node_modules/pdfjs-dist/*");
  assert.equal(entry.since, "1.0.7");
});

check("the bytes pass isPdfBytes before PDF.js; no blob URL, frame, object or embed in the PDF.js mode", () => {
  const branch = att.slice(att.indexOf('if (usePlatform.getState().pdfView !== "frame")'), att.indexOf("// only bytes that start with %PDF- get a frame"));
  assert.ok(branch.includes("isPdfBytes(raw) ? { url: \"\", pdfBytes: raw } : { url: \"\", notPdf: true }"), branch);
  assert.ok(!/createObjectURL|<iframe|<object|<embed/.test(branch), "no blob, frame, object or embed in the PDF.js branch");
  assert.ok(!/createObjectURL|<iframe|<object|<embed|new Blob/.test(view.replace(/\/\/[^\n]*/g, "")), "the viewer makes no blob, frame, object or embed");
  assert.equal((att.match(/<iframe\b/g) ?? []).length, 1, "the one frame is the Windows PDF frame");
  assert.ok(!/<object\b/.test(att), "the object element of the 1.0.6 experiment is gone");
  assert.ok(att.includes("<LazyPdfView ") && /pdfBytes/.test(att));
});

check("no annotation layer, no scripting, no XFA, no WebAssembly, no eval in the viewer", () => {
  const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  for (const bad of ["AnnotationLayer", "XfaLayer", "AnnotationEditor", "pdf.sandbox", "scripting", "PDFScriptingManager", "annotationMode: AnnotationMode.ENABLE_FORMS", "eval(", "new Function"]) {
    assert.ok(!code.includes(bad), `the viewer mentions ${bad}`);
  }
  assert.ok(/enableXfa: false/.test(code), "XFA is off");
  assert.ok(/useWasm: false/.test(code), "WebAssembly is off: the policy has no 'wasm-unsafe-eval'");
  assert.ok(/useWorkerFetch: false/.test(code));
  assert.ok(!/\.wasm["'`]/.test(code), "the viewer never asks for a .wasm file");
  assert.ok(/new URL\(`pdfjs\/\$\{path\}`, document\.baseURI\)/.test(code), "assets are resolved against the page");
  assert.ok(/data: this\.bytes\.slice\(\)/.test(code), "the library gets a copy of the bytes");
  assert.ok(/pdfjs\.TextLayer/.test(code), "the text layer is drawn (selection, copy, screen readers)");
  assert.ok(/role", "group"\)/.test(code) && /setAttribute\("aria-hidden", "true"\)/.test(code), "every page is a group, the canvas is hidden from screen readers");
  assert.ok(/tabIndex=\{0\}/.test(code), "the stage is focusable");
  assert.ok(/\.destroy\(\)/.test(code) && /task\?\.cancel\(\)/.test(code), "closing cancels the renders and destroys the document");
});

check("the shipped policy is not touched, and the decision per system is the agreed one", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(
    conf.app.security.csp,
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  const pm = read("src-tauri/src/pdfmode.rs");
  assert.match(pm, /"windows" => PdfView::Frame,\s*"macos" \| "linux" => PdfView::Pdfjs,\s*_ => PdfView::Card,/);
  assert.ok(!/HEYLOOK_PDF_INLINE|apply_csp|csp_for/.test(read("src-tauri/src/lib.rs") + pm.replace(/\/\/[^\n]*/g, "").replace(/assert[^\n]*\n/g, "")), "the experiment of 1.0.6 is gone");
  const platform = read("src/platform.ts");
  assert.match(platform, /i\.pdfView === "frame" \|\| i\.pdfView === "pdfjs" \|\| i\.pdfView === "pdfjs-broken" \|\| i\.pdfView === "card" \? i\.pdfView : os === "windows" \? "frame" : "card"/, "an unknown value from an old backend: the card");
  assert.ok(!/pdfTest|"object"/.test(platform), "the readout of the experiment is gone");
  // the debug seam names, read in debug builds only (pdfmode.rs tests pin that)
  for (const w of ["card", "pdfjs", "pdfjs-broken", "frame"]) assert.ok(pm.includes(`Some("${w}")`), w);
});

console.log(`test-pdf-viewer: ok (${n} checks)`);
