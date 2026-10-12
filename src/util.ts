import DOMPurify from "dompurify";
import { format, isThisYear, isToday, isYesterday } from "date-fns";

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "Yesterday";
  if (isThisYear(d)) return format(d, "MMM d");
  return format(d, "dd/MM/yyyy");
}

export function fmtFull(ts: number): string {
  return format(new Date(ts * 1000), "EEE, MMM d yyyy · HH:mm");
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

export function snoozePresets(): { label: string; ts: number }[] {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return Math.floor(x.getTime() / 1000);
  };
  const now = new Date();
  const out: { label: string; ts: number }[] = [];
  out.push({ label: "In 1 hour", ts: Math.floor(Date.now() / 1000) + 3600 });
  if (now.getHours() < 18) out.push({ label: "This evening (18:00)", ts: at(now, 18) });
  const tm = new Date(now);
  tm.setDate(tm.getDate() + 1);
  out.push({ label: "Tomorrow (08:00)", ts: at(tm, 8) });
  const mon = new Date(now);
  mon.setDate(mon.getDate() + ((8 - mon.getDay()) % 7 || 7));
  out.push({ label: "Next Monday (08:00)", ts: at(mon, 8) });
  const nm = new Date(now);
  nm.setMonth(nm.getMonth() + 1);
  out.push({ label: "Next month", ts: at(nm, 8) });
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
