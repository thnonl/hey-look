import DOMPurify from "dompurify";
import { format, isThisYear, isThisWeek, isToday, isYesterday, subWeeks, isSameWeek } from "date-fns";
import blockedExt from "./blockedExt.json";
import type { Prefs } from "./prefs";

let timePat = "HH:mm";
let relative = true;
export function configureDates(p: Pick<Prefs, "timeFormat" | "dateFormat">) {
  timePat = p.timeFormat === "12" ? "h:mm a" : "HH:mm";
  relative = p.dateFormat === "relative";
}

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (relative) {
    if (isToday(d)) return format(d, timePat);
    if (isYesterday(d)) return "Yesterday";
    if (isThisWeek(d)) return format(d, "EEE");
    if (isThisYear(d)) return format(d, "d MMM");
    return format(d, "dd/MM/yyyy");
  }
  return format(d, isThisYear(d) ? `d MMM ${timePat}` : `dd/MM/yyyy ${timePat}`);
}

export function fmtFull(ts: number): string {
  return format(new Date(ts * 1000), `EEE, d MMM yyyy ${timePat}`);
}

export function dateGroup(ts: number): string {
  const d = new Date(ts * 1000);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  if (isThisWeek(d)) return "Earlier this week";
  if (isSameWeek(d, subWeeks(new Date(), 1))) return "Last week";
  if (isThisYear(d)) return format(d, "MMMM");
  return format(d, "yyyy");
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(s: string): string {
  const parts = s.replace(/<.*>/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Sanitize message HTML. Remote images are blocked unless allowRemote. */
export function sanitizeHtml(html: string, allowRemote: boolean): { html: string; blocked: number } {
  let blocked = 0;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (!allowRemote) {
      for (const attr of ["src", "background", "srcset"]) {
        const v = node.getAttribute?.(attr);
        if (v && /^(https?:)?\/\//i.test(v)) {
          node.removeAttribute(attr);
          blocked++;
        }
      }
      const st = node.getAttribute?.("style");
      if (st && /url\(/i.test(st)) {
        node.setAttribute("style", st.replace(/url\([^)]*\)/gi, "none"));
        blocked++;
      }
    }
  });
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "meta", "link", "base"],
    FORBID_ATTR: ["srcdoc"],
  });
  DOMPurify.removeHook("afterSanitizeAttributes");
  return { html: clean, blocked };
}

export function plainToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="white-space:pre-wrap">${esc}</div>`;
}

export function htmlToText(html: string): string {
  const d = document.createElement("div");
  d.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li)>/gi, "\n");
  return (d.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function quoteHtml(m: { fromName: string; fromEmail: string; date: number; html: string | null; text: string | null }): string {
  const body = m.html ? sanitizeHtml(m.html, false).html : plainToHtml(m.text ?? "");
  const who = m.fromName ? `${m.fromName} &lt;${m.fromEmail}&gt;` : m.fromEmail;
  return `<br><br><div>On ${fmtFull(m.date)}, ${who} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body}</blockquote>`;
}

export function snoozePresets(t: Prefs["snoozeTimes"]): { label: string; ts: number }[] {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return Math.floor(x.getTime() / 1000);
  };
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const now = new Date();
  const out: { label: string; ts: number }[] = [];
  out.push({ label: "In 1 hour", ts: Math.floor(Date.now() / 1000) + 3600 });
  if (now.getHours() < t.evening) out.push({ label: `Later today (${hh(t.evening)})`, ts: at(now, t.evening) });
  const tm = new Date(now);
  tm.setDate(tm.getDate() + 1);
  out.push({ label: `Tomorrow (${hh(t.tomorrow)})`, ts: at(tm, t.tomorrow) });
  const sat = new Date(now);
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7));
  out.push({ label: `This weekend (${hh(t.weekend)})`, ts: at(sat, t.weekend) });
  const mon = new Date(now);
  mon.setDate(mon.getDate() + ((8 - mon.getDay()) % 7 || 7));
  out.push({ label: `Next week (${hh(t.nextWeek)})`, ts: at(mon, t.nextWeek) });
  return out;
}

export function splitAddrs(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/** Short "message sent" whoosh (Web Audio, no asset needed). */
export function playSent() {
  try {
    const ctx = new AudioContext();
    const t0 = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * 0.09);
      o.stop(t0 + i * 0.09 + 0.18);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* audio unavailable */
  }
}

// ---------- scheduled sends ----------

/** The zone a scheduled time is interpreted in, e.g. "Asia/Ho_Chi_Minh (UTC+7)". */
export function zoneLabel(d = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const off = -d.getTimezoneOffset();
  const h = Math.trunc(off / 60);
  const m = Math.abs(off % 60);
  return `${tz} (UTC${off >= 0 ? "+" : "-"}${Math.abs(h)}${m ? `:${String(m).padStart(2, "0")}` : ""})`;
}

/** "Tue 13 Oct, 08:00" for a scheduled time (Today / Tomorrow when that is the day). */
export function fmtWhen(ts: number, now = new Date()): string {
  const d = new Date(ts * 1000);
  const time = format(d, timePat);
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  return `${format(d, isThisYear(d) ? "EEE d MMM" : "EEE d MMM yyyy")}, ${time}`;
}

/** "in 1 day 22 h", "in 20 h", "in 5 min", "now" */
export function fmtIn(ts: number, now = Date.now()): string {
  const s = Math.round((ts * 1000 - now) / 1000);
  if (s <= 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const days = Math.floor(h / 24);
  return `in ${days} day${days === 1 ? "" : "s"}${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** Local date + time for a `datetime` pair, or null when the pair is not a real date. */
export function parseLocal(date: string, time: string): number | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{2}):(\d{2})$/);
  if (!m || !t) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]), 0, 0);
  if (d.getMonth() !== Number(m[2]) - 1) return null; // e.g. 31 February
  return Math.floor(d.getTime() / 1000);
}

// ---------- pictures ----------

/** Natural size of an image data: URI. */
export function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => rej(new Error("not an image"));
    img.src = dataUrl;
  });
}

/** Downscale to `maxW` pixels wide (JPEG q 0.85, PNG kept when it has transparency). Returns a data: URI. */
export async function resizeImage(dataUrl: string, mime: string, maxW: number): Promise<{ dataUrl: string; mime: string; w: number; h: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const keepPng = mime === "image/png" || mime === "image/gif";
  const out = keepPng ? "image/png" : "image/jpeg";
  return { dataUrl: canvas.toDataURL(out, 0.85), mime: out, w, h };
}

/** Raw base64 length of a data: URI's payload, in bytes. */
export function dataUriBytes(uri: string): number {
  const b64 = uri.slice(uri.indexOf(",") + 1);
  return Math.floor((b64.length * 3) / 4);
}

/** File extensions that mail providers (Gmail, Outlook, Yahoo) refuse as attachments; the list is src/blockedExt.json. */
const BLOCKED = new Set<string>(blockedExt);
/** The extension (".exe") of a file name when providers block it as an attachment, else null. */
export function blockedAttachmentExt(filename: string): string | null {
  const m = /\.([^.\s\/]+)\s*$/.exec(filename.trim());
  const ext = m?.[1].toLowerCase();
  return ext && BLOCKED.has(ext) ? `.${ext}` : null;
}

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Fingerprint in groups of four ("7A3F 9C21 …"). */
export function fmtFpr(fpr: string): string {
  return (fpr.replace(/\s+/g, "").toUpperCase().match(/.{1,4}/g) ?? []).join(" ");
}

/** The usual short form of a key: the last eight hex digits, grouped ("0B44 D1E8"). */
export function shortKey(fprOrId: string): string {
  return fmtFpr(fprOrId.replace(/\s+/g, "").slice(-8));
}

export function fmtDay(ts: number): string {
  return format(new Date(ts * 1000), "d MMM yyyy");
}

/** Name part of "Name <a@b.c>", else the address. */
export function userName(uid: string): string {
  const n = uid.split("<")[0].trim().replace(/^"|"$/g, "");
  return n || uid.replace(/[<>]/g, "");
}

/** 0-4 for the passphrase meter: length first, then variety. */
export function passphraseStrength(p: string): 0 | 1 | 2 | 3 | 4 {
  if (!p) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 8) return 1;
  if (p.length >= 16 && kinds >= 3) return 4;
  if (p.length >= 12 && kinds >= 2) return 3;
  return kinds >= 2 ? 2 : 1;
}
