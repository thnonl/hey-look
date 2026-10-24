// The files of PDF.js that the PDF viewer of the attachment preview needs at run time (W5.1, src/pdfView.tsx), served by the dev server and written into dist/pdfjs/ by the build:
//   pdfjs/pdf.worker.min.mjs   the worker (a module worker of the page's own origin: `script-src 'self'` covers it)
//   pdfjs/cmaps/               the predefined character maps (Japanese, Chinese, Korean text in fonts that are not embedded), packed
//   pdfjs/standard_fonts/      the fonts a PDF may name without embedding them (Foxit, Liberation)
//   pdfjs/wasm/                the JavaScript decoders of JPEG 2000 and JBIG2 (`*_nowasm_fallback.js`); the .wasm files are not shipped: the viewer never uses WebAssembly (the policy has no
//                              'wasm-unsafe-eval'), see src/pdfView.tsx
//   pdfjs/iccs/                the CMYK colour profile
//   every LICENSE file of those folders, and the package's own LICENSE (Apache-2.0; OpenJPEG BSD-2, PDFium BSD-3, Foxit, Liberation SIL OFL 1.1, Adobe cMaps BSD-3)
// Not shipped: web/ (the full viewer), legacy/, pdf.sandbox* and quickjs-eval (scripting), the source maps, image_decoders/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PDFJS_DIR = path.join(here, "..", "node_modules", "pdfjs-dist");

const TYPES = { ".mjs": "text/javascript", ".js": "text/javascript", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".icc": "application/octet-stream" };

/** [{ url: "pdfjs/…", file: absolute path }] for the package in `dir`. */
export function assetList(dir = PDFJS_DIR) {
  const out = [];
  const add = (url, file) => out.push({ url: `pdfjs/${url}`, file });
  add("pdf.worker.min.mjs", path.join(dir, "build", "pdf.worker.min.mjs"));
  add("LICENSE", path.join(dir, "LICENSE"));
  const folder = (name, keep) => {
    const d = path.join(dir, name);
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d).sort()) if (keep(f)) add(`${name}/${f}`, path.join(d, f));
  };
  folder("cmaps", () => true);
  folder("standard_fonts", () => true);
  folder("wasm", (f) => f.endsWith("_nowasm_fallback.js") || f.startsWith("LICENSE"));
  folder("iccs", () => true);
  return out;
}

export function pdfjsAssets() {
  let list = null;
  const files = () => (list ??= assetList());
  return {
    name: "hey-look-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/pdfjs/")) return next();
        const hit = files().find((a) => `/${a.url}` === url);
        if (!hit || !fs.existsSync(hit.file)) return next();
        res.setHeader("Content-Type", TYPES[path.extname(hit.file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(hit.file).pipe(res);
      });
    },
    generateBundle() {
      for (const a of files()) {
        if (!fs.existsSync(a.file)) this.error(`pdfjs-dist is not installed or has changed: ${a.file} is missing (npm ci)`);
        this.emitFile({ type: "asset", fileName: a.url, source: fs.readFileSync(a.file) });
      }
    },
  };
}
