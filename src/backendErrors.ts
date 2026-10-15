// Errors from the Rust side: `CODE: English text` or `CODE|name=value|…: English text` (src-tauri/src/i18n.rs `coded`).
// The UI shows the dictionary entry `backend.<CODE>` in the language in use; a code it does not know keeps the backend's English text.
import { hasKey, t } from "./i18n/index.ts";

const CODED = /^([A-Z][A-Z0-9_]+)((?:\|[A-Za-z]\w*=[^|:]*)*):\s*(.*)$/s;

const unescape = (v: string): string => v.replace(/%0A/g, "\n").replace(/%3A/g, ":").replace(/%7C/g, "|").replace(/%25/g, "%");

/** The parts of a coded backend error, or null for any other text. */
export function parseCoded(raw: string): { code: string; params: Record<string, string>; text: string } | null {
  const m = CODED.exec(raw.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2].split("|").filter(Boolean)) {
    const eq = p.indexOf("=");
    params[p.slice(0, eq)] = unescape(p.slice(eq + 1));
  }
  return { code: m[1], params, text: m[3] };
}

/** The translated sentence of a coded error, or null when the text is not coded or the code has no dictionary entry. */
export function backendText(raw: string): string | null {
  const c = parseCoded(raw);
  if (!c) return null;
  // a code with several sentences names the one in the parameter `v` ("CAL_SEND_FAILED|v=saved|…"): key backend.CAL_SEND_FAILED.saved
  const key = c.params.v ? `backend.${c.code}.${c.params.v}` : `backend.${c.code}`;
  return hasKey(key) ? t(key, c.params) : null;
}

/** The code of a coded error ("OUTBOX_SENDING"), also for the older `PGP_MISSING_KEYS:data` shape; null otherwise. */
export function backendCode(raw: string): string | null {
  return /^([A-Z][A-Z0-9_]+)(?:\|[A-Za-z]\w*=[^|:]*)*:/.exec(raw.trim())?.[1] ?? null;
}
