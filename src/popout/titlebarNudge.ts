// What is painted behind a full-size title bar (macOS), seen from the page.
//
// tauri's default title bar style on macOS gives the window a full-size content view: the web view runs UNDER the title bar, and WebKit fills
// that strip from the page (the background of the root, or the colour of a fixed / sticky element at the top edge, which it samples). Mac QA
// 1.0.6: the NSWindow appearance of every window was right and the compose title bar still kept the colour of the theme it was opened in; the
// compose page was the only one whose root was `position: fixed` (now it is not, App.css `.popout-compose`).
//
// Two helpers, both only for the log and the safety net of src-tauri/src/titlebar.rs (HEYLOOK_TITLEBAR_MODE 7 / 8):
// - `topStripInfo`: one line that says which colours the top of the page has, and which element is topmost there and how it is positioned;
// - `nudgeTopEdge`: a 1 px change of the box of every element that is fixed or sticky at the top edge for two frames, so that WebKit lays that
//   edge out again and takes its colour again.

const PROBE_LIMIT = 4000;

/** Does something between the element and the body scroll or clip (overflow other than visible)? A sticky element then sticks inside that box. */
function insideOwnScroller(el: HTMLElement, doc: Document): boolean {
  for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
    const cs = doc.defaultView?.getComputedStyle(p);
    if (cs && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) return true;
  }
  return false;
}

/**
 * The elements that stick to the top edge of the viewport: `position: fixed`, or `sticky` directly in the page (not inside a box of its own that
 * scrolls), with their top within a pixel of it.
 */
export function topEdgeElements(doc: Document = document): HTMLElement[] {
  const out: HTMLElement[] = [];
  const all = doc.body ? doc.body.querySelectorAll<HTMLElement>("*") : [];
  let n = 0;
  for (const el of all) {
    if (++n > PROBE_LIMIT) break;
    const pos = doc.defaultView?.getComputedStyle(el).position;
    if (pos !== "fixed" && pos !== "sticky") continue;
    if (pos === "sticky" && insideOwnScroller(el, doc)) continue;
    if (el.getBoundingClientRect().top <= 1) out.push(el);
  }
  return out;
}

const describe = (el: Element | null): string => {
  if (!el) return "none";
  const cs = getComputedStyle(el);
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).slice(0, 2).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${cls} position ${cs.position} bg ${cs.backgroundColor}`;
};

/** One line: the colours of the root and body, the topmost element at the top edge, and the elements that stick to it. */
export function topStripInfo(doc: Document = document): string {
  const root = doc.documentElement;
  const rootBg = getComputedStyle(root).backgroundColor;
  const bodyBg = doc.body ? getComputedStyle(doc.body).backgroundColor : "-";
  const top = doc.elementFromPoint(Math.max(1, Math.floor(window.innerWidth / 2)), 1);
  const sticking = topEdgeElements(doc);
  return `html bg ${rootBg}, body bg ${bodyBg}, color-scheme ${getComputedStyle(root).colorScheme}, data-theme ${root.getAttribute("data-theme") ?? "(none)"}; topmost at y=1: ${describe(top)}; ${sticking.length} element(s) stick to the top edge${sticking.length ? ` [${sticking.slice(0, 4).map(describe).join("; ")}]` : ""}`;
}

/** Move every element that sticks to the top edge by 1 px (its top margin) for two animation frames, then put it back. Returns how many. */
export function nudgeTopEdge(doc: Document = document): number {
  const els = topEdgeElements(doc);
  const saved = els.map((el) => el.style.marginTop);
  for (const el of els) el.style.marginTop = "1px";
  const win = doc.defaultView ?? window;
  win.requestAnimationFrame(() =>
    win.requestAnimationFrame(() => {
      els.forEach((el, i) => {
        el.style.marginTop = saved[i];
      });
    }),
  );
  return els.length;
}
