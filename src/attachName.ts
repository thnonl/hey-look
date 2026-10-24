// The name an attachment gets in a message that is sent (QA round 17, O-05 / BUG-18). The backend cleans every name again when the MIME is
// built (attach.rs `outgoing_name`, the same vectors: scripts/fixtures/attach-names.json); this copy is what the composer shows and what
// a file gets when it is attached, so the person sees the name the recipient will get.
// Pure (no imports). Run: node --experimental-strip-types scripts/test-attach-name.mjs

export const NAME_MAX_CHARS = 120;
export const NAME_MAX_BYTES = 240;

/** Control characters and the invisible ones that disguise a name (zero-width, line / paragraph separators, bidi overrides). */
const INVISIBLE = /[\p{Cc}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/gu;

/** Windows device names that cannot be file names (CON, PRN, AUX, NUL, CONIN$, CONOUT$, COM0-9, LPT0-9 and the superscript digits). */
function isReserved(stem: string): boolean {
  const s = stem.trimEnd().toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].includes(s)) return true;
  const c = Array.from(s);
  return c.length === 4 && (c.slice(0, 3).join("") === "COM" || c.slice(0, 3).join("") === "LPT") && "0123456789¹²³".includes(c[3]);
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;
const trimEndDots = (s: string): string => s.replace(/[.\s]+$/u, "");

/** The name cut to NAME_MAX_CHARS characters and NAME_MAX_BYTES bytes; a short extension (up to 16 characters) is kept. */
function capName(name: string): string {
  const all = Array.from(name);
  if (all.length <= NAME_MAX_CHARS && utf8Length(name) <= NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && Array.from(name.slice(dot)).length <= 17;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  let chars = Array.from(ext).length;
  let bytes = utf8Length(ext);
  let out = "";
  for (const c of Array.from(stem)) {
    const n = utf8Length(c);
    if (chars + 1 > NAME_MAX_CHARS || bytes + n > NAME_MAX_BYTES) break;
    out += c;
    chars++;
    bytes += n;
  }
  out = trimEndDots(out);
  return out ? out + ext : "attachment";
}

/** Base name only, no control or hidden characters, no trailing dots or spaces, device names get a `_`, at most 120 characters / 240 bytes. */
export function outgoingName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? "";
  const s = trimEndDots(base.replace(INVISIBLE, "").trim());
  if (!s) return "attachment";
  return capName(isReserved(s.split(".")[0]) ? `_${s}` : s);
}

/** `outgoingName` of every attachment; names that only collide because of the cleaning are told apart (`b.txt`, `b (2).txt`), the same name given twice stays twice. */
export function outgoingNames(names: string[]): string[] {
  const out: string[] = [];
  const changed: boolean[] = [];
  for (const n of names) {
    let c = outgoingName(n);
    const was = c !== n;
    if (out.some((o, i) => o === c && (changed[i] || was))) {
      const dot = c.lastIndexOf(".");
      const stem = dot > 0 ? c.slice(0, dot) : c;
      const ext = dot > 0 ? c.slice(dot) : "";
      let k = 2;
      while (out.includes(`${stem} (${k})${ext}`)) k++;
      c = `${stem} (${k})${ext}`;
    }
    out.push(c);
    changed.push(was);
  }
  return out;
}

// ---- the name of a folder, for the texts that say where a file went (W6.8)

/**
 * The name of a folder from its path, for "Save to {folder}" and "Saved {name} to {folder}": the last segment, with `/` and `\` both separating, trailing separators ignored. A drive
 * root `D:\` is `D:`, a network share `\srv\share` is `share`, the root `/` is `/`. Never the whole path.
 */
export function folderNameOf(folder: string): string {
  const p = folder.trim();
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? (p ? "/" : "");
}

/** The folder name for a saved FILE: its parent folder (`D:\a.txt` is `D:`, `/a.txt` is `/`). */
export function savedFolderName(filePath: string): string {
  const p = filePath.trim().replace(/[\\/]+$/, "");
  if (!/[\\/]/.test(p)) return "";
  return folderNameOf(p.replace(/[\\/][^\\/]*$/, "") || (/^[\\/]/.test(p) ? "/" : ""));
}
