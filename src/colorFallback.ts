// W9.7 (1.0.7): the theme tokens on an engine without `color-mix()` (WebKit before Safari 16.2: macOS 11 and 12 without a newer Safari). The app still runs on macOS 11 (minimumSystemVersion),
// and App.css builds a few CUSTOM PROPERTIES of the theme with color-mix(): an engine that does not know the function keeps the custom property but makes every var() of it invalid, so in the
// dark theme the accent colour (primary buttons, links, the focus ring) is lost, and the hover and soft tints with it. The other 50-odd uses of color-mix() in App.css are single
// declarations: an old engine drops each one and keeps the plain look (no hover tint, no tinted notice background), which is accepted.
// Here: when `CSS.supports("color", "color-mix(...)")` is false, the tokens below are computed with the same formulas in sRGB (the helpers of topBarLight.ts) and set as plain colours on the root
// (and on the Appearance preview, which has tokens of its own). Called where the theme is applied (store.ts applyPrefs, which also runs when the OS theme changes) and by the preview. Nothing happens
// on an engine that has color-mix().
// scripts/test-color-fallback.mjs lists every custom property of App.css that uses color-mix() and fails when one is added that this file does not compute.
import { blend } from "./topBarLight";

const PROBE = "color-mix(in srgb, red 50%, blue)";
const FORCE_KEY = "heylook.forceColorFallback";

/** Whether the tokens are computed here: the engine has no color-mix(), or (dev preview only, for the test) `localStorage["heylook.forceColorFallback"] = "1"`. */
function needsColorFallback(): boolean {
  try {
    if (import.meta.env.DEV && localStorage.getItem(FORCE_KEY) === "1") return true;
  } catch { /* storage unavailable: no seam */ }
  try {
    return typeof CSS === "undefined" || typeof CSS.supports !== "function" || !CSS.supports("color", PROBE);
  } catch {
    return false;
  }
}

const WHITE = "#ffffff";
const BLACK = "#000000";
const DARK_BG = "#1b1c20"; // --bg of the dark theme

/** The tokens of one theme from the accent (a #rrggbb): the custom properties of App.css that use color-mix(), with the same maths. `bg` is the page behind the tint. */
function themeTokens(accentBase: string, dark: boolean, bg: string = dark ? DARK_BG : WHITE): Record<string, string> {
  if (dark) {
    // :root[data-theme="dark"]: --accent = base + 40% white; --accent-hover = accent + 16% white; --accent-soft = 14% accent over --bg
    const accent = blend(accentBase, WHITE, 0.4);
    return { "--accent": accent, "--accent-hover": blend(accent, WHITE, 0.16), "--accent-soft": blend(bg, accent, 0.14) };
  }
  // :root: --accent-hover = accent + 16% black; --accent-soft = 12% accent over --bg; --top-ring = base + 22% black. (--top has a color-mix() gradient only as the fallback of var(--top-lt), which applyPrefs always sets: not needed)
  const ring = blend(accentBase, BLACK, 0.22);
  return {
    "--accent-hover": blend(accentBase, BLACK, 0.16),
    "--accent-soft": blend(bg, accentBase, 0.12),
    "--top-ring": ring,
  };
}

/** The Appearance preview has tokens of its own (App.css `.ap-preview[data-theme=...]`). */
function previewTokens(accentBase: string, dark: boolean): Record<string, string> {
  if (dark) {
    const accent = blend(accentBase, WHITE, 0.4);
    return { "--accent": accent, "--accent-soft": blend(DARK_BG, accent, 0.14) };
  }
  return { "--accent-soft": blend(WHITE, accentBase, 0.12), "--top": `linear-gradient(135deg, ${blend(accentBase, BLACK, 0.22)}, ${accentBase})` };
}

const hexOnly = /^#[0-9a-f]{6}$/i;

/** Sets the tokens for the theme that is in force now. A no-op on an engine that has color-mix() (and for an accent that is not a #rrggbb). */
export function applyColorFallback(): void {
  if (typeof document === "undefined" || !needsColorFallback()) return;
  const root = document.documentElement;
  const base = root.style.getPropertyValue("--accent-base").trim();
  if (!hexOnly.test(base)) return;
  const attr = root.getAttribute("data-theme");
  const dark = attr === "dark" || (attr !== "light" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  // the tokens of the other theme must not stay on the root (a theme switch)
  for (const name of ["--accent", "--accent-hover", "--accent-soft", "--top-ring"]) root.style.removeProperty(name);
  for (const [k, v] of Object.entries(themeTokens(base, dark))) root.style.setProperty(k, v);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".ap-preview"))) {
    const pdark = el.getAttribute("data-theme") === "dark";
    for (const name of ["--accent", "--accent-soft", "--top"]) el.style.removeProperty(name);
    for (const [k, v] of Object.entries(previewTokens(base, pdark))) el.style.setProperty(k, v);
  }
}
