// The pure rules of the PDF viewer of the attachment preview on macOS and Linux (W5.1, src/pdfView.tsx draws with them): zoom steps, page sizes, which page is in view and which
// pages are drawn, and the state of the viewer. Imports nothing (no React, no PDF.js), so a plain Node script tests it (scripts/test-pdf-viewer.mjs).

/** The zoom of the viewer: Fit (the page fills the width of the stage) or a share of the page's real size. */
export type PdfZoom = "fit" | 1 | 1.5 | 2;
/** The steps of the zoom buttons, smallest first. */
export const ZOOM_STEPS: readonly PdfZoom[] = ["fit", 1, 1.5, 2];

/** One PDF unit (a point, 1/72 inch) in CSS pixels at 100 %: the page at 100 % is as big as on paper at 96 dpi. */
export const CSS_UNITS = 96 / 72;
/** The room above the first page and between pages, in CSS pixels. */
export const PAGE_GAP = 16;
/** The room left and right of the pages (the arrows of the dialog sit there, as for a picture), in CSS pixels. */
export const SIDE_ROOM = 48;
/** The most pixels one canvas may hold (the 16 million pixels of the smallest Safari canvas limit). */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** How long the first page has to be drawn before the preview counts as failed. */
export const PAGE1_WAIT_MS = 10_000;
/** A resize of the window re-fits and redraws once it has been still this long. */
export const RESIZE_DEBOUNCE_MS = 150;
/** Pages beyond this many get no size up front (a book): they take the size of the last known page until they are drawn. */
export const SIZE_SCAN_MAX = 300;
/** Pages this far from the visible ones are drawn in advance (one above and one below), and dropped again when they are this many pages away. */
export const PRELOAD_PAGES = 1;
export const KEEP_PAGES = 3;

export const zoomIn = (z: PdfZoom): PdfZoom => ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)];
export const zoomOut = (z: PdfZoom): PdfZoom => ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)];
/** The text of the middle button: `null` for Fit (the caller says it in the language), else "150%". */
export const zoomLabel = (z: PdfZoom): string | null => (z === "fit" ? null : `${z * 100}%`);

/** CSS pixels per PDF unit: Fit = the width the stage leaves between the side rooms, else the share of the real size. Never below 0.1 or above 8. */
export function cssScale(zoom: PdfZoom, pageWidthPt: number, stageWidthPx: number): number {
  const s = zoom === "fit" ? (Math.max(0, stageWidthPx) - 2 * SIDE_ROOM) / Math.max(1, pageWidthPt) : zoom * CSS_UNITS;
  return Math.min(8, Math.max(0.1, s));
}

/**
 * The resolution of a canvas: the device pixel ratio, at most 2, and lower when the page would not fit into `MAX_CANVAS_PIXELS` (a poster at 200 %). Never below 1 unless the
 * page alone is bigger than the limit.
 */
export function outputScale(dpr: number, cssWidth: number, cssHeight: number): number {
  const want = Math.min(2, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  const area = Math.max(1, cssWidth * cssHeight);
  const room = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(0.25, Math.min(want, room));
}

export interface PageSize {
  /** the size at scale 1, in PDF units, rotation applied */
  w: number;
  h: number;
}

export interface Layout {
  /** the scale of each page */
  scales: number[];
  widths: number[];
  heights: number[];
  /** the distance of each page's top from the top of the pages area */
  tops: number[];
  /** the height of the whole pages area, and the width of the widest page */
  total: number;
  maxWidth: number;
}

/** The place of every page: one below the other, `PAGE_GAP` above the first and between pages (and below the last). Pure. */
export function layoutPages(sizes: readonly PageSize[], zoom: PdfZoom, stageWidthPx: number): Layout {
  const scales: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  const tops: number[] = [];
  let y = PAGE_GAP;
  let maxWidth = 0;
  for (const s of sizes) {
    const k = cssScale(zoom, s.w, stageWidthPx);
    const w = Math.round(s.w * k);
    const h = Math.round(s.h * k);
    scales.push(k);
    widths.push(w);
    heights.push(h);
    tops.push(y);
    y += h + PAGE_GAP;
    maxWidth = Math.max(maxWidth, w);
  }
  return { scales, widths, heights, tops, total: y, maxWidth };
}

/** The page (0-based) whose area covers the middle of the visible part; between two pages the one above. */
export function pageAtMiddle(tops: readonly number[], _heights: readonly number[], scrollTop: number, viewHeight: number): number {
  if (!tops.length) return 0;
  const mid = scrollTop + viewHeight / 2;
  let page = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= mid) page = i;
    else break;
  }
  // the middle lies below the last page's bottom edge: still the last page
  return Math.min(page, tops.length - 1);
}

export interface PageRange {
  from: number;
  to: number;
}

/** The pages that touch the visible part (`to` inclusive); null when there are none. */
export function visiblePages(tops: readonly number[], heights: readonly number[], scrollTop: number, viewHeight: number): PageRange | null {
  let from = -1;
  let to = -1;
  for (let i = 0; i < tops.length; i++) {
    const bottom = tops[i] + heights[i];
    if (bottom >= scrollTop && tops[i] <= scrollTop + viewHeight) {
      if (from < 0) from = i;
      to = i;
    } else if (from >= 0) break;
  }
  return from < 0 ? null : { from, to };
}

/** The pages to have drawn: the visible ones and `PRELOAD_PAGES` more on each side, nearest to the middle first (the order they are drawn in). */
export function pagesToDraw(tops: readonly number[], heights: readonly number[], scrollTop: number, viewHeight: number, count: number = tops.length): number[] {
  const vis = visiblePages(tops, heights, scrollTop, viewHeight);
  if (!vis) return [];
  const from = Math.max(0, vis.from - PRELOAD_PAGES);
  const to = Math.min(count - 1, vis.to + PRELOAD_PAGES);
  const mid = pageAtMiddle(tops, heights, scrollTop, viewHeight);
  const list: number[] = [];
  for (let i = from; i <= to; i++) list.push(i);
  return list.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
}

/** Whether a page that was drawn can be dropped (its canvas freed): it is more than `KEEP_PAGES` away from the visible ones. */
export function canDrop(page: number, vis: PageRange | null): boolean {
  if (!vis) return true;
  return page < vis.from - KEEP_PAGES || page > vis.to + KEEP_PAGES;
}

// ---------------------------------------------------------------- the state of the viewer

export type PdfViewState = "loading" | "ready" | "locked" | "damaged" | "unavailable";
export type PdfViewEvent = "page1" | "password" | "error" | "timeout" | "unavailable";

/**
 * `loading` until the first page is drawn. `page1`: it was drawn (`ready`); `password`: the PDF needs one (`locked`, nothing is asked); `error`: the file or the first page cannot be read
 * (`damaged`); `timeout`: the first page was not drawn in time (`damaged`); `unavailable`: the PDF engine or its worker cannot be loaded at all (the card replaces the viewer).
 * A state that is not `loading` stays (a late event does not bring a message back to a viewer, or the other way round) except that `unavailable` always wins: the engine is gone.
 */
export function nextViewState(s: PdfViewState, ev: PdfViewEvent): PdfViewState {
  if (ev === "unavailable") return "unavailable";
  if (s !== "loading") return s;
  switch (ev) {
    case "page1":
      return "ready";
    case "password":
      return "locked";
    case "error":
    case "timeout":
      return "damaged";
  }
}

/** What a rejected `getDocument` means: a password (by the name of PDF.js's exception), a worker that could not be set up (the engine is unavailable), or a damaged file. */
export function classifyLoadError(e: unknown): "password" | "unavailable" | "damaged" {
  const err = e as { name?: unknown; message?: unknown } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  const message = typeof err?.message === "string" ? err.message : typeof e === "string" ? e : "";
  if (name === "PasswordException") return "password";
  if (name === "InvalidPDFException" || name === "MissingPDFException" || name === "FormatError") return "damaged";
  if (/worker/i.test(message) && /fake worker|worker failed|setting up|could not be|cannot be/i.test(message)) return "unavailable";
  return "damaged";
}

/** What the preview shows for a state, as the key of the message (`null`: no message, the viewer or the spinner is shown). */
export function messageFor(s: PdfViewState): "reading.pv.pdfLocked" | "reading.pv.pdfNotDrawn" | null {
  return s === "locked" ? "reading.pv.pdfLocked" : s === "damaged" ? "reading.pv.pdfNotDrawn" : null;
}
