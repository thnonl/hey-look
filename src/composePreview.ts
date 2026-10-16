// "Preview as recipient" in the composer: the body is shown on the background a recipient's mail app may use, light or dark.
// It is a view-layer effect only: the surface colours below and (in dark) the recolouring of the signature region by the reading
// pane's own dark transformation (darkMail.ts, applied by composePreviewDom.ts). Nothing here is read by buildDraft, so what is
// saved or sent is the same HTML with the preview on or off (scripts/test-compose-preview.mjs).
// Imports only mailCanvas.ts, so a plain Node script can test it.
import { DARK_CANVAS, type MailCanvas } from "./mailCanvas.ts";

export type PreviewBg = "light" | "dark";

/** The preview a window starts with when nothing was chosen yet: the reading pane's message background (dark stays dark, the original is light). */
export function previewFromCanvas(c: MailCanvas): PreviewBg {
  return c === "dark" ? "dark" : "light";
}

export function togglePreview(p: PreviewBg): PreviewBg {
  return p === "dark" ? "light" : "dark";
}

// The choice lasts for the session: the next message opened in this run starts the way the last one was left.
let chosen: PreviewBg | null = null;

/** The preview for a new composer: the choice made in this session, else the one the message background preference implies. */
export function startPreview(canvas: MailCanvas): PreviewBg {
  return chosen ?? previewFromCanvas(canvas);
}

export function rememberPreview(p: PreviewBg): void {
  chosen = p;
}

/** Test hook: forget the session's choice. */
export function forgetPreview(): void {
  chosen = null;
}

const [R, G, B] = DARK_CANVAS;

/**
 * The colours of each surface. fg / link / bg are the reading pane's (mailCanvas.ts frameBaseCss: the colours a mail without
 * colours of its own gets there), the rest (muted text, rules, code and selection) are chosen for the same two surfaces.
 */
export const PREVIEW_COLORS: Record<PreviewBg, { bg: string; fg: string; link: string; muted: string; rule: string; code: string; sel: string }> = {
  light: { bg: "#ffffff", fg: "#242424", link: "#0f6cbd", muted: "#5b6470", rule: "#d0d5dd", code: "#eceef2", sel: "#cfe3f7" },
  dark: { bg: `rgb(${R},${G},${B})`, fg: "#e6e6e6", link: "#6cb8f6", muted: "#a2a8b3", rule: "#3a3d46", code: "#2d2f36", sel: "#2f4f78" },
};

/** The custom properties App.css reads on the composer's body surface (`.cp-pv`). */
export function previewVars(p: PreviewBg): Record<string, string> {
  const c = PREVIEW_COLORS[p];
  return { "--pv-bg": c.bg, "--pv-fg": c.fg, "--pv-link": c.link, "--pv-muted": c.muted, "--pv-rule": c.rule, "--pv-code": c.code, "--pv-sel": c.sel };
}
