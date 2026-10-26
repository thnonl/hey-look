// Shared code of the Microsoft Store package (WP14 option A): the identity and version rules, the manifest template, the checks of a manifest,
// the list of package images, and the lookup of the Windows SDK tools. Pure functions first (tested by scripts/test-msix-build.mjs on every
// system), tool lookups last. Used by scripts/msix-build.mjs, scripts/msix-verify.mjs and scripts/msix-assets.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEMPLATE = path.join(ROOT, "src-tauri", "msix", "AppxManifest.xml.in");
export const READINESS = path.join(ROOT, "src-tauri", "msix", "readiness.json");

/** The name the Store shows (DEC-006): the only name that was reserved for the product. */
export const STORE_DISPLAY_NAME = "Hey Look! Mail Client";
export const DESCRIPTION = "Fast, private desktop mail client";
/** The languages of the package (spec A-20). */
export const LANGUAGES = ["en-US", "vi", "fr", "zh-Hans", "es", "ja", "de", "ru"];
export const EXE_NAME = "hey-look.exe";
/** Placeholder identity of a dry run without the repository variables (never submitted to the Store). */
export const DEV_IDENTITY = { name: "HeyLook.Dev", publisher: "CN=HeyLook-Dev", publisherDisplayName: "HeyLook Dev", dev: true };

export const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** 1.0.7 -> 1.0.7.0 (the 4th part belongs to the Store and must be 0; the 1st cannot be 0: spec A-4). */
export function msixVersion(v) {
  const m = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(String(v ?? "").trim());
  if (!m) throw new Error(`version '${v}' is not X.Y.Z (numbers only)`);
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 65535)) throw new Error(`version '${v}': a part is above 65535`);
  if (parts[0] === 0) throw new Error(`version '${v}': the first part of an MSIX version cannot be 0`);
  return `${parts.join(".")}.0`;
}

/**
 * The identity of the package from three optional values (the repository variables MSIX_IDENTITY_NAME, MSIX_PUBLISHER,
 * MSIX_PUBLISHER_DISPLAY_NAME). None set = the placeholder identity; a tag run (`requireIdentity`) refuses that; one or two set is always an error.
 */
export function resolveIdentity({ name = "", publisher = "", publisherDisplayName = "" } = {}, { requireIdentity = false } = {}) {
  const given = [name, publisher, publisherDisplayName].map((s) => String(s ?? "").trim());
  const set = given.filter(Boolean).length;
  if (set === 0) {
    if (requireIdentity) throw new Error("MSIX_IDENTITY_NAME, MSIX_PUBLISHER and MSIX_PUBLISHER_DISPLAY_NAME are not set: copy them from Partner Center > Product management > Product identity into the repository variables (PACKAGING.md > Microsoft Store)");
    return { ...DEV_IDENTITY };
  }
  const missing = ["MSIX_IDENTITY_NAME", "MSIX_PUBLISHER", "MSIX_PUBLISHER_DISPLAY_NAME"].filter((_, i) => !given[i]);
  if (missing.length) throw new Error(`only part of the package identity is set, missing: ${missing.join(", ")}`);
  const [n, p, d] = given;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,48}[A-Za-z0-9]$/.test(n)) throw new Error(`identity name '${n}': 3 to 50 characters, letters, digits, '.' and '-' only`);
  if (!/^CN=[^<>&"\r\n]+$/.test(p)) throw new Error(`publisher '${p}': expected a distinguished name that starts with CN= (as Partner Center shows it)`);
  if (d.length > 256 || /[<>&"\r\n\t]/.test(d)) throw new Error("publisher display name: at most 256 characters, none of < > & \" or a line break");
  return { name: n, publisher: p, publisherDisplayName: d, dev: false };
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The manifest from the template text, an identity and a version X.Y.Z.0. */
export function fillManifest(template, identity, version4) {
  const values = { NAME: identity.name, PUBLISHER: identity.publisher, PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName, VERSION: version4 };
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`the template has an unknown placeholder {{${k}}}`);
    return xmlEscape(values[k]);
  });
  const left = out.match(/\{\{[^}]*\}\}/);
  if (left) throw new Error(`placeholder left in the manifest: ${left[0]}`);
  return out;
}

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const decode = (s) => (s ?? "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * What the acceptance criterion AC-WA.1.1 says a manifest must show. `expect` = { name, publisher, publisherDisplayName, version }.
 * Returns the list of problems (empty = fine). Works on the text of the template result and of an unpacked package alike.
 */
export function checkManifest(xml, expect = {}) {
  const bad = [];
  const identity = /<Identity\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (!identity) bad.push("no <Identity>");
  const get = (n) => decode(attr(identity, n));
  if (expect.name !== undefined && get("Name") !== expect.name) bad.push(`Identity Name is '${get("Name")}', expected '${expect.name}'`);
  if (expect.publisher !== undefined && get("Publisher") !== expect.publisher) bad.push(`Identity Publisher is '${get("Publisher")}', expected '${expect.publisher}'`);
  if (expect.version !== undefined && get("Version") !== expect.version) bad.push(`Identity Version is '${get("Version")}', expected '${expect.version}'`);
  if (!/^\d+\.\d+\.\d+\.0$/.test(get("Version") ?? "")) bad.push(`Identity Version '${get("Version")}' is not X.Y.Z.0`);
  if (get("ProcessorArchitecture") !== "x64") bad.push(`ProcessorArchitecture is '${get("ProcessorArchitecture")}', expected x64`);
  const props = /<Properties>[\s\S]*?<\/Properties>/.exec(xml)?.[0] ?? "";
  const pdn = decode(/<PublisherDisplayName>([^<]*)<\/PublisherDisplayName>/.exec(props)?.[1]);
  if (expect.publisherDisplayName !== undefined && pdn !== expect.publisherDisplayName) bad.push(`PublisherDisplayName is '${pdn}', expected '${expect.publisherDisplayName}'`);
  const propName = /<DisplayName>([^<]*)<\/DisplayName>/.exec(props)?.[1];
  if (propName !== STORE_DISPLAY_NAME) bad.push(`Properties DisplayName is '${propName}', expected '${STORE_DISPLAY_NAME}' (DEC-006)`);
  const visual = /<uap:VisualElements\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (attr(visual, "DisplayName") !== STORE_DISPLAY_NAME) bad.push(`VisualElements DisplayName is '${attr(visual, "DisplayName")}', expected '${STORE_DISPLAY_NAME}' (DEC-006)`);
  if (!/<Description>Fast, private desktop mail client<\/Description>/.test(props)) bad.push("Properties Description is not the agreed one");
  const app = /<Application\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (attr(app, "Executable") !== EXE_NAME) bad.push(`Application Executable is '${attr(app, "Executable")}', expected ${EXE_NAME}`);
  if (attr(app, "EntryPoint") !== "Windows.FullTrustApplication") bad.push("Application EntryPoint is not Windows.FullTrustApplication");
  const caps = [...xml.matchAll(/<(?:rescap:|uap:|)Capability\b[^>]*\bName="([^"]*)"/g)].map((m) => m[1]);
  if (caps.join(",") !== "runFullTrust") bad.push(`capabilities are [${caps.join(", ")}], expected only runFullTrust`);
  if (!/<rescap:Capability\b/.test(xml)) bad.push("runFullTrust is not declared as a restricted capability (rescap:)");
  const task = /<uap5:StartupTask\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (attr(task, "TaskId") !== "HeyLookStartup") bad.push("no startup task HeyLookStartup");
  if (attr(task, "Enabled") !== "false") bad.push("the startup task must be declared Enabled=\"false\"");
  const langs = [...xml.matchAll(/<Resource\b[^>]*\bLanguage="([^"]*)"/g)].map((m) => m[1]);
  if (langs.join(",") !== LANGUAGES.join(",")) bad.push(`languages are [${langs.join(", ")}], expected [${LANGUAGES.join(", ")}]`);
  const tdf = /<TargetDeviceFamily\b[^>]*>/.exec(xml)?.[0] ?? "";
  if (attr(tdf, "Name") !== "Windows.Desktop" || attr(tdf, "MinVersion") !== "10.0.17763.0") bad.push("TargetDeviceFamily is not Windows.Desktop with MinVersion 10.0.17763.0");
  if (!/<uap17:UpdateWhileInUse>defer<\/uap17:UpdateWhileInUse>/.test(props)) bad.push("UpdateWhileInUse=defer is not declared");
  for (const ns of ["uap", "uap5", "uap17", "rescap"]) if (!new RegExp(`IgnorableNamespaces="[^"]*\\b${ns}\\b`).test(xml)) bad.push(`namespace ${ns} is not in IgnorableNamespaces`);
  // nothing that would register the app for mailto:, files or protocols (out of scope, owner decision 1.0.0)
  for (const tag of ["windows.protocol", "windows.fileTypeAssociation", "windows.appExecutionAlias", "windows.toastNotificationActivation"]) {
    if (xml.includes(`Category="${tag}"`)) bad.push(`the manifest declares ${tag}, which is out of scope for this package`);
  }
  // the images the manifest names (base names; the scaled files are checked by the build)
  for (const ref of [/<Logo>([^<]*)<\/Logo>/.exec(props)?.[1], attr(visual, "Square150x150Logo"), attr(visual, "Square44x44Logo")]) {
    if (!ref || !/^Assets\\[\w.]+\.png$/.test(ref)) bad.push(`an image reference is missing or odd: '${ref}'`);
  }
  return bad;
}

/** The package images (spec A-21): [{ file, w, h }] relative to Assets/. Scaled files need resources.pri (makepri). */
export function packageImages() {
  const out = [];
  const scales = [100, 125, 150, 200, 400];
  const add = (base, size) => {
    for (const s of scales) {
      const px = Math.round((size * s) / 100);
      out.push({ file: `${base}.scale-${s}.png`, w: px, h: px });
    }
  };
  add("StoreLogo", 50);
  add("Square44x44Logo", 44);
  add("Square150x150Logo", 150);
  for (const t of [16, 24, 32, 48, 256]) {
    out.push({ file: `Square44x44Logo.targetsize-${t}.png`, w: t, h: t });
    out.push({ file: `Square44x44Logo.targetsize-${t}_altform-unplated.png`, w: t, h: t });
  }
  return out;
}

/** The images of the Store listing (W14.7; spec 5): box art 1:1, poster 2:3, app tile icon. */
export function storeLogos() {
  return [
    { file: "store-box-2160x2160.png", w: 2160, h: 2160, kind: "box" },
    { file: "store-box-1080x1080.png", w: 1080, h: 1080, kind: "box" },
    { file: "store-poster-1440x2160.png", w: 1440, h: 2160, kind: "poster" },
    { file: "store-poster-720x1080.png", w: 720, h: 1080, kind: "poster" },
    { file: "store-tile-300x300.png", w: 300, h: 300, kind: "tile" },
  ];
}

/** The optional images of the Store listing of 1.0.10 (Partner Center rows PromoImage1920x1080 = 16:9 hero art, StoreLogoOverride150x150 and 71x71 = small tiles). Not part of the package. */
export function listingExtras() {
  return [
    { file: "store-hero-1920x1080.png", w: 1920, h: 1080, kind: "hero" },
    { file: "store-tile-150x150.png", w: 150, h: 150, kind: "tile" },
    { file: "store-tile-71x71.png", w: 71, h: 71, kind: "tile" },
  ];
}

/** Width, height and colour type of a PNG, or null when the bytes are not one. */
export function pngInfo(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

/** The OpenSSL subject of the throw-away test certificate: it must equal the package's Publisher (spec REQ-WA.1.5). */
export function publisherToSubject(publisher) {
  const parts = String(publisher).split(/,\s*/);
  const rdn = parts.map((p) => /^([A-Za-z]{1,4})=([^/\\=,"]+)$/.exec(p));
  if (!parts.length || rdn.some((m) => !m) || parts[0].slice(0, 3) !== "CN=") throw new Error(`publisher '${publisher}' cannot be used for a test certificate (only simple CN=..., O=... names)`);
  return rdn.map((m) => `/${m[1]}=${m[2]}`).join("");
}

export function readReadiness() {
  const j = JSON.parse(fs.readFileSync(READINESS, "utf8"));
  if (typeof j.appPackagedMode !== "boolean") throw new Error("readiness.json: appPackagedMode must be true or false");
  return j;
}

// ---- tools of the Windows SDK and OpenSSL ----

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** makeappx.exe, makepri.exe, signtool.exe: the environment variable (MAKEAPPX, ...), else the newest x64 folder of the Windows SDK, else null. */
export function findSdkTool(file, env = process.env) {
  const fromEnv = env[file.replace(/\.exe$/i, "").toUpperCase()];
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const bases = [env["ProgramFiles(x86)"], env.ProgramFiles, "C:\\Program Files (x86)"].filter(Boolean).map((b) => path.join(b, "Windows Kits", "10", "bin"));
  const found = [];
  for (const base of bases) {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const n of names) if (/^10\.\d+\.\d+\.\d+$/.test(n) && exists(path.join(base, n, "x64", file))) found.push({ n, p: path.join(base, n, "x64", file) });
  }
  const cmp = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  found.sort((a, b) => cmp(a.n, b.n));
  return found.length ? found[found.length - 1].p : null;
}

export function findOpenssl(env = process.env) {
  const names = process.platform === "win32" ? ["openssl.exe"] : ["openssl"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) for (const n of names) if (dir && exists(path.join(dir, n))) return path.join(dir, n);
  if (process.platform === "win32") {
    for (const p of ["C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe"]) if (exists(p)) return p;
  }
  return null;
}
