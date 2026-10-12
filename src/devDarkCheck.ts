// Dev-only self-check of the dark mail rendering (there is no TS test runner in this repo). Run it in the dev preview:
//   open http://localhost:1431/#dark  and in the console:  await __darkCheck()            (all fixtures)
//                                                          await __darkCheck(["dk8"])      (some)
// It opens each fixture, reads every element's colours with the dark sheet off and on, and reports
//   paper   - a white / light-grey background (not a button / code chip) that is not exactly the app surface now (must be 0)
//   kept    - a coloured background that was flattened into the surface (must be 0)
//   text    - text below WCAG AA (4.5:1) on what it sits on (must be 0; text on pictures is exempt)
import { appSurface, contrast, parseColor, setMailDark } from "./darkMail";

type RGB = [number, number, number];
const TINTED = new Set(["a", "button", "input", "select", "textarea", "option", "summary", "code", "kbd", "samp", "mark", "img", "hr", "meter", "progress", "svg"]);

export interface FixtureReport {
  id: string;
  elements: number;
  paper: string[];
  kept: string[];
  text: string[];
}

// an independent test of "paper" (not darkMail's own isPaper, so a mistake there cannot hide itself): every channel light, hardly any spread
const isPaper = ([r, g, b]: RGB) => Math.min(r, g, b) >= 222 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (el: Element) => `${el.localName}${el.id ? `#${el.id}` : ""}${el.getAttribute("class") ? `.${el.getAttribute("class")}` : ""} "${(el.textContent ?? "").trim().slice(0, 24)}"`;
const over = (c: [number, number, number, number], bg: RGB): RGB => [c[0] * c[3] + bg[0] * (1 - c[3]), c[1] * c[3] + bg[1] * (1 - c[3]), c[2] * c[3] + bg[2] * (1 - c[3])];

export async function darkCheck(select: (id: string) => Promise<void>, ids: string[]): Promise<FixtureReport[]> {
  const base = appSurface();
  const out: FixtureReport[] = [];
  for (const id of ids) {
    await select(id);
    let doc: Document | null | undefined;
    for (let i = 0; i < 60; i++) {
      await wait(100);
      doc = document.querySelector<HTMLIFrameElement>(".reading-region iframe")?.contentDocument;
      if (doc?.body && doc.documentElement.classList.contains("hm-dark") && !doc.documentElement.classList.contains("hm-pend") && doc.body.children.length) break;
    }
    await wait(300);
    const rep: FixtureReport = { id, elements: 0, paper: [], kept: [], text: [] };
    if (!doc?.body || !doc.defaultView) {
      rep.text.push("fixture did not load (or the app is not in the dark theme)");
      out.push(rep);
      continue;
    }
    const win = doc.defaultView;
    const els = [doc.documentElement, ...Array.from(doc.body.querySelectorAll("*"))].filter((e) => win.getComputedStyle(e).display !== "none");
    const read = () => new Map(els.map((e) => [e, { bg: parseColor(win.getComputedStyle(e).backgroundColor), fg: parseColor(win.getComputedStyle(e).color), img: win.getComputedStyle(e).backgroundImage }]));
    setMailDark(doc, false, base);
    const was = read();
    setMailDark(doc, true, base);
    const now = read();
    rep.elements = els.length;
    const eff = new Map<Element, RGB>();
    const behind = (e: Element | null): RGB => {
      for (let p = e; p; p = p.parentElement) {
        const c = eff.get(p);
        if (c) return c;
      }
      return base;
    };
    for (const e of els) {
      const a = was.get(e)!;
      const b = now.get(e)!;
      let here = behind(e.parentElement);
      if (b.bg && b.bg[3] > 0) here = over(b.bg, here);
      eff.set(e, here);
      if (a.bg && a.bg[3] > 0 && b.bg) {
        const o: RGB = [a.bg[0], a.bg[1], a.bg[2]];
        if (isPaper(o) && !TINTED.has(e.localName)) {
          if (Math.abs(b.bg[0] - base[0]) > 1 || Math.abs(b.bg[1] - base[1]) > 1 || Math.abs(b.bg[2] - base[2]) > 1) rep.paper.push(`${label(e)} ${a.bg.slice(0, 3)} -> ${b.bg.slice(0, 3)}`);
        } else if (a.bg[3] > 0.5 && !isPaper(o) && Math.max(...o) - Math.min(...o) >= 40 && Math.abs(b.bg[0] - base[0]) + Math.abs(b.bg[1] - base[1]) + Math.abs(b.bg[2] - base[2]) <= 6) {
          rep.kept.push(`${label(e)} ${a.bg.slice(0, 3)} -> ${b.bg.slice(0, 3)}`);
        }
      }
      const own = Array.from(e.childNodes).some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ""));
      if (own && b.fg && !/url\(/.test(b.img)) {
        const seen = over(b.fg, here);
        const c = contrast(seen, here);
        if (c < 4.5) rep.text.push(`${label(e)} ${c.toFixed(2)}:1`);
      }
    }
    out.push(rep);
  }
  return out;
}
