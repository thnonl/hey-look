// The PDF viewer of the attachment preview on macOS and Linux (W5.1): PDF.js (display layer only) draws the pages on canvases of the app's own page, with a text layer for selection
// and screen readers. Nothing of PDF.js is in the first chunk of the app: this module, with the library, loads when the first PDF is previewed (src/lazyViews.tsx `LazyPdfView`).
//
// What it does not do, on purpose: no annotation layer (a link inside the PDF is not a link here), no scripting (`pdf.sandbox` is not shipped), no XFA, no form filling. The bytes arrive
// already checked (`isPdfBytes`, PreviewDialog); no blob URL and no frame is made. The content security policy of the app is not touched: the library and its worker are scripts of the
// app's own origin (`script-src 'self'`), the cMaps and fonts are fetched from it (`connect-src 'self'`), and WebAssembly is never used (`useWasm: false`: the policy has no
// 'wasm-unsafe-eval'; the JavaScript decoders of JPEG 2000 and JBIG2 are shipped instead).
import "./pdfView.css";
import { ExternalLink, ImageOff, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import { useT } from "./i18n/react";
import {
  canDrop,
  classifyLoadError,
  layoutPages,
  messageFor,
  nextViewState,
  outputScale,
  pageAtMiddle,
  PAGE1_WAIT_MS,
  pagesToDraw,
  RESIZE_DEBOUNCE_MS,
  SIZE_SCAN_MAX,
  visiblePages,
  zoomIn,
  zoomLabel,
  zoomOut,
  type Layout,
  type PageSize,
  type PdfViewEvent,
  type PdfViewState,
  type PdfZoom,
} from "./pdfViewLogic";

interface PdfViewInfo {
  state: PdfViewState;
  /** the page in the middle of the stage (1-based) and the number of pages; 0 until the document is known */
  page: number;
  total: number;
}

export interface PdfViewProps {
  /** the bytes of the PDF, checked by `isPdfBytes`; the viewer works on a copy */
  bytes: Uint8Array;
  name: string;
  /** the place in the header of the dialog where the page number and the zoom buttons are drawn (once the first page is there) */
  tools: HTMLElement | null;
  /** the debug seam HEYLOOK_TEST_PDF_VIEW=pdfjs-broken: the worker address points to a file that is not there (AC-5.1.13) */
  broken?: boolean;
  /** the engine or its worker cannot be loaded: the caller shows the card */
  onUnavailable: () => void;
  onOpen?: () => void;
}

/** Where the files of PDF.js are served (src/vite pdfjs plugin, and the app's assets): next to the page, resolved against it so that `tauri://`, `http://tauri.localhost` and the dev server all work. */
const asset = (path: string) => new URL(`pdfjs/${path}`, document.baseURI).href;

let sharedWorker: pdfjs.PDFWorker | null = null;
/** One worker for the whole run (it stays after a document is closed); a worker that was destroyed is replaced. */
function workerFor(src: string): pdfjs.PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed || (pdfjs.GlobalWorkerOptions.workerSrc && pdfjs.GlobalWorkerOptions.workerSrc !== src)) {
    pdfjs.GlobalWorkerOptions.workerSrc = src;
    sharedWorker = new pdfjs.PDFWorker({});
  }
  return sharedWorker;
}

interface PageSlot {
  el: HTMLDivElement;
  status: "none" | "drawing" | "done" | "error";
  /** the scale and resolution the canvas was drawn at ("" = not drawn) */
  key: string;
  canvas?: HTMLCanvasElement;
  text?: HTMLDivElement;
  task?: pdfjs.RenderTask;
  textLayer?: pdfjs.TextLayer;
}

/** The drawing, as plain DOM: pages come and go with the scroll position, which React would only get in the way of. */
class Viewer {
  private doc?: pdfjs.PDFDocumentProxy;
  private loading?: pdfjs.PDFDocumentLoadingTask;
  private slots: PageSlot[] = [];
  private sizes: PageSize[] = [];
  private layout: Layout = layoutPages([], "fit", 0);
  private zoom: PdfZoom;
  private stageW = 0;
  private dead = false;
  private pumping = false;
  private epoch = 0;
  private state: PdfViewState = "loading";
  private page = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private raf = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private observer?: ResizeObserver;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly scroller: HTMLDivElement,
    private readonly host: HTMLDivElement,
    zoom: PdfZoom,
    private readonly broken: boolean,
    private readonly report: (info: PdfViewInfo) => void,
  ) {
    this.zoom = zoom;
  }

  private emit(ev?: PdfViewEvent): void {
    if (ev) this.state = nextViewState(this.state, ev);
    this.report({ state: this.state, page: this.page, total: this.slots.length });
  }

  async start(): Promise<void> {
    this.timers.push(setTimeout(() => this.emit("timeout"), PAGE1_WAIT_MS));
    let worker: pdfjs.PDFWorker;
    try {
      worker = workerFor(this.broken ? asset("missing.worker.mjs") : asset("pdf.worker.min.mjs"));
    } catch {
      this.emit("unavailable");
      return;
    }
    try {
      this.loading = pdfjs.getDocument({
        data: this.bytes.slice(),
        worker,
        enableXfa: false,
        cMapUrl: asset("cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: asset("standard_fonts/"),
        wasmUrl: asset("wasm/"),
        iccUrl: asset("iccs/"),
        useWasm: false,
        useWorkerFetch: false,
        verbosity: 0,
      });
      this.doc = await this.loading.promise;
      if (this.dead) return;
      const first = await this.doc.getPage(1);
      if (this.dead) return;
      const v = first.getViewport({ scale: 1 });
      first.cleanup();
      const n = this.doc.numPages;
      this.sizes = Array.from({ length: n }, () => ({ w: v.width, h: v.height }));
      this.build(n);
      this.stageW = this.scroller.clientWidth;
      this.applyLayout(false);
      this.page = 1;
      this.observer = new ResizeObserver(() => this.onResize());
      this.observer.observe(this.scroller);
      this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
      void this.pump();
      void this.scanSizes();
    } catch (e) {
      if (this.dead) return;
      const kind = classifyLoadError(e);
      this.emit(kind === "password" ? "password" : kind === "unavailable" ? "unavailable" : "error");
    }
  }

  private build(n: number): void {
    this.host.replaceChildren();
    this.slots = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      el.className = "pv-page";
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", t("reading.pv.page", { n: i + 1, total: n }));
      this.host.appendChild(el);
      this.slots.push({ el, status: "none", key: "" });
    }
  }

  /** Sizes and places the page boxes for the current zoom and stage width; keeps what the person was looking at in place. */
  private applyLayout(keep: boolean): void {
    const sc = this.scroller;
    const old = this.layout;
    const anchor = pageAtMiddle(old.tops, old.heights, sc.scrollTop, sc.clientHeight);
    const frac = old.heights[anchor] ? (sc.scrollTop + sc.clientHeight / 2 - old.tops[anchor]) / old.heights[anchor] : 0;
    this.layout = layoutPages(this.sizes, this.zoom, this.stageW);
    const l = this.layout;
    this.slots.forEach((s, i) => {
      s.el.style.width = `${l.widths[i]}px`;
      s.el.style.height = `${l.heights[i]}px`;
    });
    if (keep && sc.scrollTop > 0) sc.scrollTop = Math.max(0, l.tops[anchor] + frac * l.heights[anchor] - sc.clientHeight / 2);
    // a vertical scrollbar that appeared with the pages narrows the stage: fit again once, to the width that is left
    if (this.zoom === "fit" && sc.clientWidth !== this.stageW && sc.clientWidth > 0) {
      this.stageW = sc.clientWidth;
      this.applyLayout(keep);
    }
  }

  setZoom(zoom: PdfZoom): void {
    if (zoom === this.zoom || this.dead || !this.doc) {
      this.zoom = zoom;
      return;
    }
    this.zoom = zoom;
    this.relayout();
  }

  /** A layout change (zoom, resize): the boxes move at once, the pictures are drawn again for the new size. */
  private relayout(): void {
    this.epoch++;
    this.stageW = this.scroller.clientWidth;
    this.applyLayout(true);
    for (const s of this.slots) {
      s.task?.cancel();
      s.textLayer?.cancel();
      s.text?.remove();
      s.text = undefined;
      s.textLayer = undefined;
      if (s.status === "done" || s.status === "drawing") s.status = "none"; // (the old canvas stays, stretched, until the new one replaces it)
    }
    this.updatePage();
    void this.pump();
  }

  private onResize = (): void => {
    if (this.dead) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.dead) return;
      if (this.scroller.clientWidth !== this.stageW) this.relayout();
    }, RESIZE_DEBOUNCE_MS);
  };

  private onScroll = (): void => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dead) return;
      this.updatePage();
      void this.pump();
    });
  };

  private updatePage(): void {
    const sc = this.scroller;
    const p = pageAtMiddle(this.layout.tops, this.layout.heights, sc.scrollTop, sc.clientHeight) + 1;
    if (p !== this.page) {
      this.page = p;
      this.emit();
    }
  }

  /** The sizes of the other pages, so that the scroll bar and "Page 3 of 30" are right before they are drawn (a book is not scanned to the end). */
  private async scanSizes(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const n = Math.min(doc.numPages, SIZE_SCAN_MAX);
    let changed = false;
    for (let i = 1; i < n; i++) {
      if (this.dead) return;
      try {
        const p = await doc.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        p.cleanup();
        if (v.width !== this.sizes[i].w || v.height !== this.sizes[i].h) {
          this.sizes[i] = { w: v.width, h: v.height };
          changed = true;
        }
      } catch {
        /* a page that cannot be read keeps the size of the first one */
      }
      if (changed && (i % 25 === 0 || i === n - 1)) {
        this.applyLayout(true);
        this.updatePage();
        changed = false;
      }
    }
    if (changed && !this.dead) {
      this.applyLayout(true);
      this.updatePage();
    }
    // the pages beyond the scan take the size of the last page that was looked at
    if (doc.numPages > n) for (let i = n; i < doc.numPages; i++) this.sizes[i] = this.sizes[n - 1];
    if (doc.numPages > n && !this.dead) this.applyLayout(true);
  }

  /** Draws the pages that are wanted, one after the other, the one nearest to the middle first; frees the ones that are far away. */
  private async pump(): Promise<void> {
    if (this.pumping || this.dead) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.dead || !this.doc) return;
        const sc = this.scroller;
        const { tops, heights } = this.layout;
        const wanted = pagesToDraw(tops, heights, sc.scrollTop, sc.clientHeight, this.slots.length);
        const vis = visiblePages(tops, heights, sc.scrollTop, sc.clientHeight);
        this.slots.forEach((s, i) => {
          if (s.status === "done" && canDrop(i, vis)) this.free(s);
          if (s.status === "drawing" && !wanted.includes(i)) s.task?.cancel();
        });
        const next = wanted.find((i) => this.slots[i].status === "none" || (this.slots[i].status === "done" && this.slots[i].key !== this.keyFor(i)));
        if (next === undefined) return;
        const epoch = this.epoch;
        await this.draw(next, epoch);
      }
    } finally {
      this.pumping = false;
    }
  }

  private keyFor(i: number): string {
    const k = this.layout.scales[i];
    const o = outputScale(window.devicePixelRatio || 1, this.layout.widths[i], this.layout.heights[i]);
    return `${k.toFixed(4)}@${o.toFixed(3)}`;
  }

  private free(s: PageSlot): void {
    s.task?.cancel();
    s.textLayer?.cancel();
    if (s.canvas) {
      s.canvas.width = 0;
      s.canvas.height = 0;
      s.canvas.remove();
    }
    s.text?.remove();
    s.canvas = s.text = s.task = s.textLayer = undefined;
    s.status = "none";
    s.key = "";
  }

  private async draw(i: number, epoch: number): Promise<void> {
    const doc = this.doc;
    const s = this.slots[i];
    if (!doc || !s) return;
    s.status = "drawing";
    const key = this.keyFor(i);
    try {
      const page = await doc.getPage(i + 1);
      if (this.dead || epoch !== this.epoch) {
        s.status = "none";
        return;
      }
      const scale = this.layout.scales[i];
      const css = page.getViewport({ scale });
      const dpr = outputScale(window.devicePixelRatio || 1, css.width, css.height);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      canvas.setAttribute("aria-hidden", "true");
      s.task = page.render({ canvas, viewport: vp });
      await s.task.promise;
      s.task = undefined;
      if (this.dead || epoch !== this.epoch) {
        canvas.width = canvas.height = 0;
        s.status = "none";
        return;
      }
      s.canvas?.remove();
      s.canvas = canvas;
      s.el.prepend(canvas);
      // the text, over the picture: selection, copy and screen readers (the words of the page are real text here)
      s.text?.remove();
      const text = document.createElement("div");
      text.className = "pv-text-layer";
      text.style.setProperty("--total-scale-factor", String(scale));
      s.el.appendChild(text);
      s.text = text;
      s.textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: css });
      try {
        await s.textLayer.render();
      } catch (e) {
        if (!isCancel(e)) text.remove();
      }
      page.cleanup();
      s.status = "done";
      s.key = key;
      if (i === 0 && this.state === "loading") {
        this.timers.forEach(clearTimeout);
        this.timers = [];
        this.emit("page1");
      }
      // a page of an unscanned book: its real size is known now
      const real = page.getViewport({ scale: 1 });
      if (Math.abs(real.width - this.sizes[i].w) > 0.5 || Math.abs(real.height - this.sizes[i].h) > 0.5) {
        this.sizes[i] = { w: real.width, h: real.height };
        this.applyLayout(true);
        this.updatePage();
      }
    } catch (e) {
      s.task = undefined;
      if (isCancel(e) || this.dead) {
        s.status = "none";
        return;
      }
      s.status = "error";
      if (i === 0) this.emit("error");
    }
  }

  focusIfIdle(): void {
    const a = document.activeElement;
    if (!a || a === document.body || (a instanceof HTMLElement && a.classList.contains("pv-modal"))) this.scroller.focus({ preventScroll: true });
  }

  /** The kind of worker that does the work, for the QA: "module" (a real worker) or "fake" (the same code on the page's own thread). */
  workerKind(): string {
    return sharedWorker && typeof Worker !== "undefined" && sharedWorker.port instanceof Worker ? "module" : "fake";
  }

  destroy(): void {
    this.dead = true;
    this.epoch++;
    this.timers.forEach(clearTimeout);
    clearTimeout(this.resizeTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    for (const s of this.slots) this.free(s);
    this.host.replaceChildren();
    this.slots = [];
    // the measuring canvas the text layers keep in the page (one per language) goes with the last viewer
    try {
      pdfjs.TextLayer.cleanup();
    } catch {
      /* nothing to clean */
    }
    const loading = this.loading;
    this.doc = undefined;
    this.loading = undefined;
    void Promise.resolve(loading?.destroy()).catch(() => undefined);
  }
}

const isCancel = (e: unknown) => (e as { name?: unknown } | null)?.name === "RenderingCancelledException" || e instanceof pdfjs.RenderingCancelledException;

/** The pages of a PDF, drawn by PDF.js inside the preview's stage. */
export function PdfView({ bytes, name, tools, broken, onUnavailable, onOpen }: PdfViewProps) {
  const tr = useT();
  const [state, setState] = useState<PdfViewState>("loading");
  const [zoom, setZoom] = useState<PdfZoom>("fit");
  const [shown, setShown] = useState({ page: 0, total: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const callbacks = useRef({ onUnavailable });
  callbacks.current = { onUnavailable };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!scroller.current || !host.current) return;
    setState("loading");
    let last: PdfViewState = "loading";
    const v = new Viewer(bytes, scroller.current, host.current, zoomRef.current, !!broken, (info) => {
      if (info.state !== last) {
        last = info.state;
        setState(info.state);
        if (info.state === "unavailable") callbacks.current.onUnavailable();
      }
      setShown((p) => (p.page === info.page && p.total === info.total ? p : { page: info.page, total: info.total }));
      if (scroller.current) {
        scroller.current.dataset.worker = v.workerKind();
        scroller.current.dataset.page = String(info.page);
      }
    });
    viewer.current = v;
    void v.start();
    return () => {
      v.destroy();
      viewer.current = null;
    };
  }, [bytes, broken]);

  useEffect(() => {
    viewer.current?.setZoom(zoom);
  }, [zoom]);

  // the pages take the focus once they are on screen (a hidden element cannot have it), unless the person has put it on a button of the header already
  useEffect(() => {
    if (state === "ready") viewer.current?.focusIfIdle();
  }, [state]);

  const message = messageFor(state);
  return (
    <>
      {state === "ready" && tools && createPortal(
        <>
          <span className="muted small pv-page-no">{tr("reading.pv.page", { n: shown.page, total: shown.total })}</span>
          <span className="pv-zoom">
            <button className="icon-btn" aria-label={tr("reading.pv.zoomOut")} onClick={() => setZoom(zoomOut)}><ZoomOut size={15} /></button>
            <button className="link-btn small" onClick={() => setZoom("fit")}>{zoomLabel(zoom) ?? tr("reading.pv.fit")}</button>
            <button className="icon-btn" aria-label={tr("reading.pv.zoomIn")} onClick={() => setZoom(zoomIn)}><ZoomIn size={15} /></button>
          </span>
        </>,
        tools,
      )}
      <div ref={scroller} className="pv-pdfjs" data-state={state} tabIndex={0} role="region" aria-label={name}>
        <div ref={host} className="pv-pages" />
      </div>
      {state === "loading" && (
        <div className="pv-msg pv-pdfjs-msg" role="status">
          <div><span className="spin" /> {tr("common.loading")}</div>
        </div>
      )}
      {message && (
        <div className="pv-msg pv-pdfjs-msg" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <ImageOff size={28} />
          <div>{tr(message)}</div>
          {message === "reading.pv.pdfNotDrawn" && onOpen && (
            <button className="btn small" onClick={onOpen}><ExternalLink size={13} /> {tr("reading.att.open")}</button>
          )}
        </div>
      )}
    </>
  );
}

