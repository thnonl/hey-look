import DOMPurify from "dompurify";
import { format, isThisYear, isThisWeek, isToday, isYesterday, subWeeks, isSameWeek } from "date-fns";
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
