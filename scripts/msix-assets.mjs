#!/usr/bin/env node
// Draws the images of the Microsoft Store package and of the Store listing from docs/assets/favicon.svg with a headless Chrome/Edge (no
// dependencies, Node 22+), like scripts/make-site-images.mjs. The PNGs are NOT committed: CI makes them (job msix of release.yml).
//   node scripts/msix-assets.mjs --out <folder> [--only package|store|listing]
//   <folder>/Assets/   the package images (spec A-21): StoreLogo, Square44x44Logo (+ targetsize-16/24/32/48/256 and _altform-unplated),
//                      Square150x150Logo, each at the scales 100, 125, 150, 200, 400; resources.pri (makepri) makes the scales findable
//   <folder>/store/    the Store listing images (W14.7): box art 2160x2160 and 1080x1080, poster 1440x2160 and 720x1080, app tile 300x300
//                      (--only listing: the optional extras of the import, scripts/store-listing-csv.mjs: hero art 1920x1080, tiles 150x150 and 71x71)
// The mark keeps its transparent corners in the package images and in the tile; the box art and the poster are opaque (brand blue behind the
// mark, no text, so no font decides how they look). CHROME_PATH overrides the browser lookup. Exit 1 when no browser is found.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listingExtras, packageImages, pngInfo, ROOT, storeLogos } from "./lib/msix.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome(env = process.env) {
  if (env.CHROME_PATH && fs.existsSync(env.CHROME_PATH)) return env.CHROME_PATH;
  const win = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
  const list = [
    ...win.map((b) => path.join(b, "Google/Chrome/Application/chrome.exe")),
    ...win.map((b) => path.join(b, "Microsoft/Edge/Application/msedge.exe")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return list.find((p) => fs.existsSync(p)) || null;
}

const freePort = (from) =>
  new Promise((ok) => {
    const s = net.createServer();
    s.once("error", () => ok(freePort(from + 1)));
    s.listen(from, "127.0.0.1", () => s.close(() => ok(from)));
  });

/** The page of one image: `kind` "mark" = the mark filling the image, "box" / "poster" = the mark on the brand background. */
export function pageFor({ kind, w, h }, markUri) {
  const img = (css) => `<img src="${markUri}" alt="" style="position:absolute;${css}">`;
  const bg = "background:linear-gradient(135deg,#0c4a86 0%,#082f57 55%,#06223f 100%)";
  if (kind === "box") {
    const s = Math.round(w * 0.6);
    return { style: bg, html: img(`left:${Math.round((w - s) / 2)}px;top:${Math.round((h - s) / 2)}px;width:${s}px;height:${s}px`) };
  }
  if (kind === "hero") {
    // 16:9 hero art of the Store listing: the mark centred on the brand background, no text, nothing in the bottom third
    const s = Math.round(h * 0.46);
    return { style: bg, html: img(`left:${Math.round((w - s) / 2)}px;top:${Math.round(h * 0.4 - s / 2)}px;width:${s}px;height:${s}px`) };
  }
  if (kind === "poster") {
    const s = Math.round(w * 0.74);
    return { style: bg, html: img(`left:${Math.round((w - s) / 2)}px;top:${Math.round(h * 0.4 - s / 2)}px;width:${s}px;height:${s}px`) };
  }
  return { style: "background:transparent", html: img(`left:0;top:0;width:${w}px;height:${h}px`) };
}

/** Renders [{ file, w, h, kind? }] into outDir (created). Returns the list of written files. */
export async function renderImages(list, outDir, { chrome = findChrome() } = {}) {
  if (!chrome) throw new Error("no Chrome/Chromium/Edge found (set CHROME_PATH)");
  const svg = fs.readFileSync(path.join(ROOT, "docs/assets/favicon.svg"), "utf8");
  const markUri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort(9640);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hl-msix-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-allow-origins=*", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
  const written = [];
  try {
    let wsUrl = null;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      } catch {
        await sleep(150);
      }
    }
    if (!wsUrl) throw new Error("the browser did not start");
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    let nextId = 1;
    const waiting = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const { ok, bad } = waiting.get(m.id);
        waiting.delete(m.id);
        m.error ? bad(new Error(m.error.message)) : ok(m.result);
      }
    };
    const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
      const id = nextId++;
      waiting.set(id, { ok, bad });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (m, p) => send(m, p, sessionId);
    await cdp("Page.enable");
    await cdp("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const item of list) {
      const { w, h } = item;
      const { style, html } = pageFor({ kind: item.kind ?? "mark", w, h }, markUri);
      await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      const r = await cdp("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          document.documentElement.style.cssText = 'margin:0;overflow:hidden;background:transparent';
          document.body.style.cssText = 'margin:0;position:relative;overflow:hidden;width:${w}px;height:${h}px;${style}';
          document.body.innerHTML = ${JSON.stringify(html)};
          await Promise.all([...document.images].map((i) => i.decode()));
          return [innerWidth, innerHeight];
        })()`,
      });
      if (r.exceptionDetails) throw new Error(`${item.file}: ${r.exceptionDetails.text}`);
      const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, fromSurface: true });
      const file = path.join(outDir, item.file);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      const info = pngInfo(fs.readFileSync(file));
      if (!info || info.w !== w || info.h !== h) throw new Error(`${item.file}: expected ${w}x${h}, got ${info ? `${info.w}x${info.h}` : "no PNG"}`);
      written.push(file);
    }
    ws.close();
  } finally {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    await sleep(400);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* a temp folder anyway */
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const out = val("--out");
  const only = val("--only");
  if (!out || (only && !["package", "store", "listing"].includes(only))) {
    console.error("usage: node scripts/msix-assets.mjs --out <folder> [--only package|store|listing]");
    process.exit(2);
  }
  try {
    let n = 0;
    if (!only || only === "package") n += (await renderImages(packageImages(), path.join(out, "Assets"))).length;
    if (!only || only === "store") n += (await renderImages(storeLogos(), path.join(out, "store"))).length;
    if (only === "listing") n += (await renderImages(listingExtras(), path.join(out, "store"))).length;
    console.log(`msix-assets: ${n} images in ${out}`);
  } catch (e) {
    console.error(`msix-assets: ${e.message}`);
    process.exit(1);
  }
}
