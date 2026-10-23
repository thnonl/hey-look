// D-057 probe for any system (Windows, macOS, Linux): is the main window of a debug build with the test bridge on really painted? Prints one JSON line.
//
//   node scripts/lib/paint-probe.mjs <data folder | test-bridge.json | startup.log | port:token> [--snapshot=<file.png>] [--window=main]
//   node scripts/lib/paint-probe.mjs --image=<screenshot of the window.png>     (the same count over a screenshot taken by the QA session: macOS `screencapture -l <window id> w.png`, Linux
//                                                                              `gnome-screenshot -w -f w.png` or `grim -g ... w.png`; 8-bit RGB / RGBA PNG; crop to the window first)
//
// Two reads, which can disagree (that is the point):
//  * page: what the page itself says: `visibilityState`, how many animation frames arrived in 500 ms, whether the document has the focus, the size of the
//    root element and the colour of the body. The white window of D-057 reports visible + frames, so these alone never prove a window is painted.
//  * snapshot: the bridge's picture of the window's web content (WKWebView `takeSnapshot` on macOS, WebView2 `CapturePreview` on Windows; Linux has none),
//    read back and counted: the share of the most common colour and the number of colours (a painted screen of the app: more than 20 colours, the top colour
//    under 0.9; one colour = the web content itself is not drawn). The snapshot asks the web view to render, it does NOT show what the compositor put on
//    the screen: on Windows it still shows the page while the window is white (measured, D-057 fix 10), so on Windows the screen read of
//    scripts/lib/window-pixels.ps1 is the judge. On Linux use a screenshot of the window (the QA session's own tool) and judge it the same way.
// Pass criteria (numbers) are in webkit-checks-107.md, section "Fix batch 10".
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { bridge, connection } from "../test-bridge-client.mjs";

/** Decodes a non-interlaced 8-bit RGB / RGBA PNG to { width, height, channels, data }. Throws for anything else. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (name === "IDAT") idat.push(body);
    else if (name === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const ch = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

/** The share of the most common colour and the number of colours over a 64 x 40 grid (the grid of startup.rs). */
export function gridStats(img, cols = 64, rows = 40) {
  const count = new Map();
  let n = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = 4 + Math.floor(((img.width - 9) * i) / (cols - 1));
      const y = 4 + Math.floor(((img.height - 9) * j) / (rows - 1));
      const o = (y * img.width + x) * img.channels;
      const key = (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2];
      count.set(key, (count.get(key) ?? 0) + 1);
      n++;
    }
  let top = 0, topKey = 0;
  for (const [k, v] of count) if (v > top) [top, topKey] = [v, k];
  return { points: n, colours: count.size, topShare: Math.round((top / n) * 10000) / 10000, topRgb: [topKey >> 16, (topKey >> 8) & 255, topKey & 255].join(",") };
}

const PAGE_PROBE = `return await new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => { frames++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else {
    const r = document.documentElement.getBoundingClientRect();
    resolve({ visibility: document.visibilityState, frames500ms: frames, hasFocus: document.hasFocus(), root: [Math.round(r.width), Math.round(r.height)], bodyBg: getComputedStyle(document.body).backgroundColor, ready: !!document.querySelector('#root > *:not(.boot-splash)'), splash: !!document.querySelector('.boot-splash'), htmlBg: getComputedStyle(document.documentElement).backgroundColor });
  } };
  requestAnimationFrame(tick);
  setTimeout(() => resolve({ visibility: document.visibilityState, frames500ms: frames, note: 'no animation frame callback within 2 s' }), 2000);
});`;

export async function probe(where, { window = "main", snapshot = "" } = {}) {
  const b = bridge(/^\d+:[0-9a-f]{64}$/.test(where) ? { port: Number(where.split(":")[0]), token: where.split(":")[1] } : connection(where));
  const out = { platform: process.platform, window };
  const wins = await b.list();
  const w = wins.find((x) => x.label === window);
  out.windowInfo = w ? { visible: w.visible, focused: w.focused, size: [w.width, w.height], scale: w.scale } : null;
  out.page = await b.evalIn(window, PAGE_PROBE, { timeoutMs: 8000 }).catch((e) => ({ error: e.message }));
  try {
    const png = await b.snapshot(window, snapshot || undefined);
    out.snapshot = { bytes: png.length, ...gridStats(decodePng(png)) };
  } catch (e) {
    out.snapshot = { unavailable: e.message.slice(0, 200) };
  }
  const s = out.snapshot;
  // 1.0.7 (fix12): until the app has mounted, index.html shows its start screen (the app's own ground and a small logo): one colour on more than 95 % of the points is what it
  // looks like and not a blank window. A page that has NOT mounted after the window was shown for a while is a different finding (the ready wait of startup.rs reloads it).
  out.verdict = out.page?.splash ? "START SCREEN (index.html's logo on the theme colour: the app has not mounted yet; one colour is expected)" : s.topShare === undefined ? "page only" : s.topShare >= 0.95 || s.colours <= 3 ? "BLANK (the web content is one colour)" : "painted (the web content has structure)";
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const where = args.find((a) => !a.startsWith("--"));
  const image = args.find((a) => a.startsWith("--image="))?.slice(8);
  if (image) {
    const st = gridStats(decodePng(fs.readFileSync(image)));
    console.log(JSON.stringify({ image, ...st, verdict: st.topShare >= 0.95 || st.colours <= 3 ? "BLANK (one colour)" : "painted" }));
    process.exit(0);
  }
  if (!where) {
    console.error("usage: node scripts/lib/paint-probe.mjs <data folder | test-bridge.json | startup.log | port:token> [--snapshot=<file.png>] [--window=main]");
    process.exit(2);
  }
  const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  console.log(JSON.stringify(await probe(where, { window: opt("window") ?? "main", snapshot: opt("snapshot") ?? "" })));
  if (opt("snapshot") && !fs.existsSync(opt("snapshot"))) process.exit(1);
}
