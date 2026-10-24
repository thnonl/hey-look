import { unsubscribeMailto } from "../unsubscribeMailto";
import { blockedPictureBox } from "../blockedPicture";
import { frameCsp, frameSandbox } from "../frameSandbox";
import { openUpdateLink } from "../updates";
import { guardFrame } from "../contextGuard";
import { Archive, Clock, ExternalLink, Flag, Forward, MailX, MoreHorizontal, Moon, Pin, Reply, ReplyAll, Sparkles, Sun, Trash2, ChevronsDownUp, ChevronsUpDown, Mail, ShieldAlert, AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mailFrameStats, writeMailDocument } from "../mailFrame";
import { forward, replyTo } from "../actions";
import { useAnswerBusy } from "../answerBusy";
import { answerKey } from "../popout/entry";
import { startCompose } from "../popout/composeOpen";
import { shiftNow } from "../popout/modifier";
import { api, MessageFull } from "../api";
import { copyToClipboard } from "../open";
import { revealSaved } from "../reveal";
import { setMailDark } from "../darkMail";
import { LANGS, t, type Key, type Lang } from "../i18n";
import { useLang, useT } from "../i18n/react";
import { fmtNumber } from "../i18n/format";
import { tx } from "../i18n/rich";
import { DARK_CANVAS, effectiveCanvas, frameBaseCss, frameRootClass, pressCanvas } from "../mailCanvas";
import { useAppDark } from "../useAppDark";
import { MAIL_FRAME_CSS, MAIL_FRAME_SPIN_CSS } from "../mailFrameCss";
import { reapply as reapplyColorScheme, rewriteMailHtml } from "../colorSchemeMedia";
import { eff } from "../prefs";
import { CONFIDENTIAL_FRAME_CSS, lockDocument, useContentProtection } from "../protect";
import { accountsOf, canMoveToJunk } from "../junk";
import { friendlyError, useStore } from "../store";
import { folderNameOf } from "../attachName";
import { linkWarning } from "../linkCheck";
import { cancelTranslation, dismissTranslation, jobErrorText, startTranslation } from "../translate";
import { MAX_CHARS } from "../translateChunks";
import { summaryBody } from "../summaryText";
import { elapsedLabel, jobFor, slowHint, type TranslateJob } from "../translateJobs";
import { useAiSlot } from "../useAiSlot";
import { aiReady, clearAiProblem, leaveAiContext, openAiSettings, showAiNotSetUp, showAiProblem } from "../aiGuide";
import { classifyAiError } from "../aiProblem";
import { fmtFull, fmtSize, plainToHtml, sanitizeHtml, snoozePresets, subjectText } from "../util";
import { AttachmentStrip, Lightbox, LbItem } from "./Attachments";
import { InviteCard } from "./InviteCard";
import { osNow } from "../platform";
import { EmptyState } from "./overlays";
import { useDelayedFlag } from "../delayedFlag";
import { hlMark } from "../perfMarks";
import { printFrame, usePrinting } from "../printStatus";
import { printFrameNative, setPrintSource } from "../printNative";
import { pendingToast } from "../pendingToast";
import { announceFrame, isHeavy, RpBody, useOpeningPending } from "../openStatus";
import { ImportanceMark } from "./Importance";
import { EncCard, importKeyFromMessage, isKeyAttachment, needsCard, SecBadges } from "./Pgp";
import { Avatar, Dropdown } from "./ui";
import { openReader } from "../popout/openReader";
import { readerAllowed } from "../popout/readerLogic";

// Remote images already fetched through the backend (url -> data: URI), shared by all messages. Capped by size (the oldest go first): a long session with newsletters would else keep every
// picture it ever showed.
const imageCache = new Map<string, string>();
const IMAGE_CACHE_CHARS = 40_000_000;
let imageChars = 0;
function cacheImage(url: string, data: string): void {
  imageChars -= imageCache.get(url)?.length ?? 0;
  imageCache.delete(url);
  imageCache.set(url, data);
  imageChars += data.length;
  while (imageChars > IMAGE_CACHE_CHARS && imageCache.size > 1) {
    const oldest = imageCache.keys().next().value as string;
    imageChars -= imageCache.get(oldest)?.length ?? 0;
    imageCache.delete(oldest);
  }
}

/**
 * Free height of the reading pane from the top of this frame down (pane viewport minus everything above the frame
 * and the reply row / padding below it). The frame never gets shorter than this, so a short mail fills the empty
 * pane from the first paint instead of opening tall and shrinking, and only a taller mail makes the pane scroll.
 */
function fillHeight(frame: HTMLIFrameElement): number {
  const pane = frame.closest<HTMLElement>(".rp-body");
  const last = pane?.lastElementChild;
  if (!pane || !last) return 0;
  const f = frame.getBoundingClientRect();
  const top = f.top - pane.getBoundingClientRect().top + pane.scrollTop;
  const below = last.getBoundingClientRect().bottom - f.bottom + parseFloat(getComputedStyle(pane).paddingBottom);
  return Math.max(0, Math.floor(pane.clientHeight - top - below));
}

/** Smallest scale a wide mail is shrunk to (14px text stays about 8.5px). */
const MIN_ZOOM = 0.6;

// Last measured content height per message: reopening a mail starts at its real height.
const heightCache = new Map<string, number>();
const HEIGHTS_MAX = 500;
function rememberHeight(id: string, h: number): void {
  heightCache.delete(id);
  heightCache.set(id, h);
  if (heightCache.size > HEIGHTS_MAX) heightCache.delete(heightCache.keys().next().value as string);
}

function remoteImageUrls(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set<string>();
  doc.querySelectorAll("img[src]").forEach((i) => {
    const u = i.getAttribute("src") ?? "";
    if (/^https?:\/\//i.test(u)) urls.add(u);
  });
  return Array.from(urls);
}

/**
 * The HTML the frame shows, kept with the cleaned result it was made from. The main page gets a new message object whenever a reader window marks the mail read, a sync or a refresh
 * reads the conversation again, and building this parses and serialises the whole mail (pictureHtml, inlineImages): for a 2 MB mail that leaves a parsed document of several MB behind
 * on every one of those, and WebKit collects such documents late (Mac round 13: the main page grew by about 5 MB per reader window opened on the same 2 MB mail). With the same inputs the
 * same string comes back and nothing is parsed. One entry per cleaned result; the result is dropped from CLEANED by size and count, and the entry goes with it.
 */
const SHOWN = new WeakMap<object, { key: string; html: string }>();
function shownHtml(clean: { html: string }, allowed: boolean, m: MessageFull, loaded: Record<string, string>, state: Record<string, { status: "loading" | "failed"; error?: string }>, lang: string, version: number): string {
  const key = [
    allowed ? 1 : 0,
    allowed ? version : 0,
    lang,
    m.attachments.filter((a) => a.cid).map((a) => `${a.cid}:${a.name}:${a.size}`).join(","),
    Object.entries(loaded).map(([k, v]) => `${k}:${v.length}`).join(","),
    Object.entries(state).map(([k, v]) => `${k}:${v.status}:${v.error ?? ""}`).join(","),
  ].join("|");
  const hit = SHOWN.get(clean);
  if (hit && hit.key === key) return hit.html;
  const out = pictureHtml(allowed ? inlineImages(clean.html) : clean.html, m, loaded, state);
  SHOWN.set(clean, { key, html: out });
  return out;
}

/** Pictures the sync did not embed: loaded ones become data: URIs, the rest become click-to-load placeholders. */
function pictureHtml(html: string, m: MessageFull, loaded: Record<string, string>, state: Record<string, { status: "loading" | "failed"; error?: string }>): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // a remote picture that is blocked: a box of the size the mail gave it with an icon and the alt text (nothing at all for a tracking pixel); not announced, not clickable -
  // the banner above the message ("Load content") is the way to load them
  doc.querySelectorAll("img[data-hl-blocked]").forEach((img) => {
    const size = blockedPictureBox({ width: img.getAttribute("width"), height: img.getAttribute("height"), style: img.getAttribute("style") });
    if (size.hidden) return img.remove();
    const box = doc.createElement("span");
    box.className = "hl-bp";
    box.setAttribute("aria-hidden", "true");
    box.style.width = size.width;
    box.style.height = size.height;
    const ico = doc.createElement("span");
    ico.className = "hl-bp-ico";
    box.append(ico);
    const alt = (img.getAttribute("alt") ?? "").trim();
    if (alt) {
      const label = doc.createElement("span");
      label.className = "hl-bp-alt";
      label.textContent = alt;
      box.append(label);
    }
    img.replaceWith(box);
  });
  doc.querySelectorAll("img[src^='cid:']").forEach((img) => {
    const cid = (img.getAttribute("src") ?? "").slice(4);
    if (loaded[cid]) {
      img.setAttribute("src", loaded[cid]);
      return;
    }
    const meta = m.attachments.find((a) => a.cid === cid);
    const ph = doc.createElement("button");
    ph.type = "button";
    ph.className = "hl-ph";
    ph.setAttribute("data-cid", cid);
    const st = state[cid];
    if (!meta) {
      ph.disabled = true;
      ph.textContent = t("reading.pic.missing", { cid });
    } else if (st?.status === "loading") {
      ph.setAttribute("aria-busy", "true");
      const spin = doc.createElement("span");
      spin.className = "hl-spin";
      ph.append(spin, t("reading.pic.loading", { size: fmtSize(meta.size) }));
    } else if (st?.status === "failed") {
      ph.classList.add("bad");
      const b = doc.createElement("b");
      b.textContent = t("reading.pic.failed");
      ph.append(b, ` ${t("common.retry")}`);
    } else {
      const b = doc.createElement("b");
      b.textContent = meta.name;
      const small = doc.createElement("span");
      small.textContent = t("reading.pic.large", { size: fmtSize(meta.size) });
      ph.append(b, doc.createElement("br"), small, ` · ${t("reading.pic.show")}`);
    }
    ph.setAttribute("aria-label", meta ? t("reading.pic.showLabel", { name: meta.name, size: fmtSize(meta.size) }) : t("reading.pic.missingLabel"));
    img.replaceWith(ph);
  });
  return doc.body.innerHTML;
}

function inlineImages(html: string): string {
  if (imageCache.size === 0) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("img[src]").forEach((i) => {
    const data = imageCache.get(i.getAttribute("src") ?? "");
    if (data) i.setAttribute("src", data);
  });
  return doc.body.innerHTML;
}

/**
 * Background the mail is shown on: the mail's own colours or the dark one (see darkMail.ts). In the light app theme always the original unless this session chose dark with the button
 * (a session choice, never stored); in the dark app theme the stored choice, which the button changes (WP13g, mailCanvas.ts effectiveCanvas / pressCanvas).
 */
function useCanvas() {
  const themeDark = useAppDark();
  const stored = useStore((s) => s.prefs.mailCanvas);
  const session = useStore((s) => s.mailCanvasSession);
  const setPrefs = useStore((s) => s.setPrefs);
  const setSession = useStore((s) => s.setMailCanvasSession);
  const dark = effectiveCanvas(themeDark, stored, session) === "dark";
  return {
    dark,
    toggle: () => {
      const press = pressCanvas(themeDark, stored, session);
      if (press.pref) setPrefs({ mailCanvas: press.pref });
      else if (press.session !== undefined) setSession(press.session);
    },
  };
}

/** The cleaned HTML of the last messages that were opened (W13.6 S2): opening a mail again, or switching the picture choice back, does not clean it again. Capped by count and by size. */
const CLEANED = new Map<string, { html: string; blocked: number }>();
const CLEANED_MAX = 20;
const CLEANED_CHARS = 8_000_000;
let cleanedChars = 0;
const cleanKey = (m: MessageFull, allowed: boolean) => (m.html ? `${m.id}|${allowed ? 1 : 0}|${m.html.length}` : `${m.id}|text|${m.text?.length ?? 0}`);
export const isCleaned = (m: MessageFull, allowed: boolean): boolean => CLEANED.has(cleanKey(m, allowed));
function cleanOf(m: MessageFull, allowed: boolean): { html: string; blocked: number } {
  const key = cleanKey(m, allowed);
  const hit = CLEANED.get(key);
  if (hit) {
    CLEANED.delete(key);
    CLEANED.set(key, hit); // (most recently used last)
    return hit;
  }
  hlMark("open:clean:start");
  const r = m.html ? sanitizeHtml(m.html, allowed) : { html: plainToHtml(m.text ?? ""), blocked: 0 };
  hlMark("open:clean:end");
  CLEANED.set(key, r);
  cleanedChars += r.html.length;
  while (CLEANED.size > CLEANED_MAX || (cleanedChars > CLEANED_CHARS && CLEANED.size > 1)) {
    const oldest = CLEANED.keys().next().value as string;
    cleanedChars -= CLEANED.get(oldest)?.html.length ?? 0;
    CLEANED.delete(oldest);
  }
  return r;
}

/** Paint first, then work (W13.6 S3, RULE-4): a heavy HTML body is cleaned and drawn only after the status "Opening message…" was painted. */
function AfterPaint({ wait, children }: { wait: boolean; children: React.ReactNode }) {
  const [go, setGo] = useState(!wait);
  useEffect(() => {
    if (go) return;
    let live = true;
    const fin = () => live && setGo(true);
    const raf = requestAnimationFrame(() => setTimeout(fin, 0)); // (after the frame that painted the status)
    const guard = setTimeout(fin, 120); // (a window that is not painting gets no animation frame)
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      clearTimeout(guard);
    };
  }, [go]);
  return go ? <>{children}</> : null;
}

function MessageBody({ m, frameRef, dark, onPictures }: { m: MessageFull; frameRef: React.RefObject<HTMLIFrameElement | null>; dark: boolean; onPictures: (items: { src: string; name: string }[], index: number) => void }) {
  const t = useT();
  const lang = useLang(); // the picture placeholders carry text: rebuilt when the language changes
  const prefs = useStore((s) => s.prefs);
  const setDialog = useStore((s) => s.setDialog);
  const confirm = useStore((s) => s.confirm);
  const loadRemote = eff(prefs, m.accountId, "loadRemote");
  const [allow, setAllow] = useState(false);
  const [version, setVersion] = useState(0); // bumps when images arrive from the backend
  const [loadedPics, setLoadedPics] = useState<Record<string, string>>({});
  const [picState, setPicState] = useState<Record<string, { status: "loading" | "failed"; error?: string }>>({});
  const allowed = loadRemote || allow;
  const clean = useMemo(() => cleanOf(m, allowed), [m, allowed]);
  const html = useMemo(
    () => {
      hlMark("open:pics:start");
      const out = shownHtml(clean, allowed, m, loadedPics, picState, lang, version);
      hlMark("open:pics:end");
      return out;
    },
    [clean, allowed, version, m, loadedPics, picState, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // a picture that was not embedded at sync time: fetch it from the server (click, or by the auto-load setting)
  const loadPicture = useCallback(
    async (cid: string) => {
      setPicState((s) => ({ ...s, [cid]: { status: "loading" } }));
      try {
        const d = await api.inlineImage(m.id, cid);
        setLoadedPics((s) => ({ ...s, [cid]: `data:${d.mime};base64,${d.dataBase64}` }));
        setPicState((s) => {
          const n = { ...s };
          delete n[cid];
          return n;
        });
      } catch (e) {
        setPicState((s) => ({ ...s, [cid]: { status: "failed", error: friendlyError(e) } }));
      }
    },
    [m.id],
  );
  const loadRef = useRef(loadPicture);
  loadRef.current = loadPicture;
  const onPicturesRef = useRef(onPictures);
  onPicturesRef.current = onPictures;

  // auto-load per the setting (2 MB each by default; 5 MB; or always), within a 10 MB budget per message
  useEffect(() => {
    const limit = prefs.inlineAutoLoadMB === 0 ? Infinity : prefs.inlineAutoLoadMB * 1024 * 1024;
    if (!m.html) return;
    let budget = 10 * 1024 * 1024;
    for (const a of m.attachments) {
      if (!(a.inline && a.referenced && a.cid) || !m.html.includes(`cid:${a.cid}`)) continue;
      if (a.size > limit || a.size > budget) continue;
      budget -= a.size;
      void loadRef.current(a.cid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, prefs.inlineAutoLoadMB]);

  // Fetch remote images in the backend instead of letting the webview contact the sender's servers.
  useEffect(() => {
    if (!allowed || !m.html) return;
    const missing = remoteImageUrls(clean.html).filter((u) => !imageCache.has(u));
    if (missing.length === 0) return;
    let live = true;
    api.fetchRemoteImages(missing).then((got) => {
      if (!live) return;
      Object.entries(got).forEach(([u, d]) => cacheImage(u, d));
      setVersion((v) => v + 1);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [allowed, clean, m.html]);

  // CSP inside the message frame: without consent nothing remote may load; with consent the backend already
  // inlined what it could and the rest falls back to a direct request.
  const csp = frameCsp(allowed ? "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:" : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
  // The base colours switch with a class on <html> (screen only, so print stays light), and the mail's own colours with
  // the sheet from darkMail.ts: toggling never reloads the frame. The frame is created already dark and hidden
  // (hm-pend) so the original colours are never painted first. The picture placeholders (.hl-ph) are ordinary mail
  // elements for the dark sheet, so they are recoloured with the rest.
  const darkNow = useRef(dark);
  darkNow.current = dark;
  const lockedNow = useRef(!!m.confidential);
  lockedNow.current = !!m.confidential;
  // The document of the frame in three pieces (head, the mail, tail): it is written into the frame (mailFrame.ts, fix35), never made one string, never an attribute.
  const docParts = useMemo(
    () => [
      `<!doctype html><html data-hm-doc${frameRootClass(darkNow.current ? "dark" : "original")}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
    <style>${frameBaseCss()}
    ${MAIL_FRAME_CSS}
    ${lockedNow.current ? CONFIDENTIAL_FRAME_CSS : ""}
    ${MAIL_FRAME_SPIN_CSS}</style>
    </head><body>`,
      rewriteMailHtml(html, darkNow.current),
      `<style>html,body{overflow:hidden!important;height:auto!important;min-height:0!important}</style></body></html>`,
    ],
    [html, csp, m.confidential], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // macOS Print (W5.3) builds its document from the same inputs as the frame: the HTML as shown now, its CSP and the subject
  const printHtmlRef = useRef(html);
  printHtmlRef.current = html;
  const printSubject = useRef(m.subject);
  printSubject.current = m.subject;
  const printCspRef = useRef(csp);
  printCspRef.current = csp;
  useEffect(() => {
    setPrintSource(frameRef.current, () => ({ html: printHtmlRef.current, csp: printCspRef.current, subject: printSubject.current }));
  }, [frameRef]);
  // theme change or toggle on a loaded mail: recolour in place (a freshly loaded mail is handled in onLoad)
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement?.hasAttribute("data-hm-doc")) {
      setMailDark(doc, dark, DARK_CANVAS);
      // what the mail's own prefers-color-scheme rules mean follows the background (W5.5), in place: the frame is not reloaded
      reapplyColorScheme(doc, dark);
    }
  }, [dark, frameRef]);

  // Frame height follows the content, never below the free height of the pane (see fillHeight). The content is
  // measured through the body's own height: nothing is collapsed or resized while measuring, because shrinking the
  // scroll container for a moment clamps the user's scrollTop back to 0.
  const stopObserve = useRef<() => void>(() => undefined);
  const applyFill = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const min = `${Math.max(40, fillHeight(frame))}px`;
    if (frame.style.minHeight !== min) frame.style.minHeight = min;
  }, [frameRef]);
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;
    applyFill();
    // The reading pane is the only scroller: the mail never scrolls inside its frame. A mail wider than the pane
    // (fixed-width tables, big images) is scaled down to fit the width instead of getting a horizontal scrollbar.
    // Below MIN_ZOOM the text would be too small to read: the frame is then made wider than the pane and the reading
    // pane scrolls sideways (never the frame itself).
    // width the frame may use = the pane's content width minus the message body's own padding (not the row's width,
    // which a wide frame itself makes larger)
    const box = frame.parentElement;
    const cs = box ? getComputedStyle(box) : null;
    const rp = frame.closest<HTMLElement>(".rp-body");
    const rcs = rp ? getComputedStyle(rp) : null;
    const avail = box && cs && rp && rcs
      ? rp.clientWidth - parseFloat(rcs.paddingLeft) - parseFloat(rcs.paddingRight) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      : frame.clientWidth;
    if (frame.dataset.avail !== String(Math.round(avail))) {
      frame.dataset.avail = String(Math.round(avail)); // the pane changed width: start again from the pane width
      frame.style.width = "";
    }
    const root = doc.documentElement;
    root.style.zoom = "";
    const natural = Math.max(root.scrollWidth, doc.body.scrollWidth);
    const fit = natural > avail + 1 ? Math.max(MIN_ZOOM, avail / natural) : 1;
    if (fit < 1) root.style.zoom = String(fit);
    const wide = fit < 1 && natural * fit > avail + 1 ? `${Math.ceil(natural * fit)}px` : "";
    if (frame.style.width !== wide) frame.style.width = wide;
    // a wide frame widens its message row, and the header / actions stay as wide as the pane and stick to its left edge
    // (CSS: .rp-msg-head and the non-frame children of .rp-msg-body), so only the mail itself scrolls sideways
    const row = frame.closest<HTMLElement>(".rp-msg");
    const pane = frame.closest<HTMLElement>(".rp-body");
    if (row && pane) {
      const minW = wide ? `${Math.ceil(frame.getBoundingClientRect().left - row.getBoundingClientRect().left + parseFloat(wide))}px` : "";
      if (row.style.minWidth !== minW) row.style.minWidth = minW;
      const pcs = getComputedStyle(pane);
      pane.style.setProperty("--rp-cw", `${pane.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight)}px`);
    }
    const h = Math.ceil(Math.max(doc.body.scrollHeight * (fit < 1 ? fit : 1), doc.body.getBoundingClientRect().height, root.scrollHeight > root.clientHeight ? root.scrollHeight : 0));
    // images still loading: the real height is unknown, so do not shrink below what the frame already has
    const loading = Array.from(doc.images).some((i) => !i.complete);
    const target = `${loading ? Math.max(h, frame.offsetHeight) : h}px`;
    if (h > 0 && frame.style.height !== target) {
      frame.style.height = target;
      frame.dispatchEvent(new Event("rp-measured", { bubbles: true }));
    }
    if (h > 0 && !loading) rememberHeight(m.id, h);
    if (frame.style.visibility === "hidden") {
      frame.style.visibility = ""; // first measurement done: show the mail at its final height
      hlMark("open:shown");
      announceFrame(frame, m.id); // (the status "Opening message…" of the pane ends, openStatus.tsx)
    }
  }, [frameRef, applyFill, m.id]);

  // first paint: open at the free height of the pane (no fixed 500px that then jumps)
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const fill = Math.max(40, fillHeight(frame));
    frame.style.minHeight = `${fill}px`;
    frame.style.height = `${Math.max(fill, heightCache.get(m.id) ?? 0)}px`;
    // stay invisible until the first measurement (a frame or two) so the height step after load is never seen as content jumping
    frame.style.visibility = "hidden";
    const safety = setTimeout(() => {
      if (frame.style.visibility === "hidden") {
        frame.style.visibility = "";
        announceFrame(frame, m.id);
      }
    }, 600);
    return () => clearTimeout(safety);
  }, [frameRef, m.id]);

  useEffect(() => () => stopObserve.current(), []);

  // The mail document is taken in hand (recoloured, measured, its clicks hooked) as soon as it is PARSED, not when the frame's `load` event says so: `load`
  // waits for every picture the mail asks for, and with "load remote content" on, a slow or dead image host kept the dark frame hidden (hm-pend) and blank
  // until the picture came or timed out (D-052). `onLoad` stays: it measures again once the pictures are in.
  const hooked = useRef<Document | null>(null);
  const hookDoc = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body || !doc.documentElement.hasAttribute("data-hm-doc")) return; // (not the empty document the frame starts with)
    if (hooked.current === doc) return measure(); // (the load event of a document that was hooked when it was parsed)
    hooked.current = doc;
    stopObserve.current();
    hlMark("open:dark:start");
    setMailDark(doc, darkNow.current, DARK_CANVAS);
    hlMark("open:dark:end");
    measure();
    // images without a height attribute (common in newsletters) only get their size once they load
    const imgs = Array.from(doc.images);
    imgs.forEach((i) => {
      i.addEventListener("load", measure);
      i.addEventListener("error", measure);
    });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(doc.body);
    // the pane itself resizing (window, splitter) changes the free height
    const pane = frame.closest(".rp-body");
    const paneRo = typeof ResizeObserver !== "undefined" && pane ? new ResizeObserver(() => measure()) : null;
    if (pane) paneRo?.observe(pane);
    window.addEventListener("resize", measure);
    void doc.fonts?.ready.then(measure);
    doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => (a.title = a.href)); // show the real target on hover
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const ph = target.closest?.(".hl-ph[data-cid]") as HTMLElement | null;
      if (ph) {
        e.preventDefault();
        void loadRef.current(ph.getAttribute("data-cid") ?? "");
        return;
      }
      const pic = target.closest?.("img") as HTMLImageElement | null;
      if (pic && (pic.getAttribute("src") ?? "").startsWith("data:")) {
        e.preventDefault();
        const all = Array.from(doc.querySelectorAll<HTMLImageElement>("img")).filter((i) => (i.getAttribute("src") ?? "").startsWith("data:"));
        onPicturesRef.current(all.map((i) => ({ src: i.getAttribute("src") ?? "", name: i.getAttribute("alt") || "picture" })), Math.max(0, all.indexOf(pic)));
        return;
      }
      const a = target.closest("a");
      if (!a?.href) return;
      e.preventDefault();
      const text = (a.textContent ?? "").trim();
      const warn = linkWarning(text, a.href);
      if (warn) {
        void confirm({
          title: t("reading.body.linkWarnTitle"),
          body: warn.kind === "mismatch" ? t("reading.body.linkWarnBody", { text: warn.text, target: warn.target }) : warn.kind === "lookalike" ? t("reading.body.linkWarnLookalike", { target: warn.target }) : t("reading.body.linkWarnHidden", { target: warn.target }),
          confirmLabel: t("reading.body.linkWarnConfirm"),
          danger: true,
        }).then((ok) => ok && void openUpdateLink(a.href));
      } else void openUpdateLink(a.href); // (an open that fails says so and copies the link, instead of doing nothing)
    };
    doc.addEventListener("click", onClick);
    doc.addEventListener("auxclick", onClick); // middle click on a link opens it in the browser too (REQ-50)
    // print is always light (W5.5): the rules of the mail that follow the dark background are put back to the light ones while the page is printed
    const win = doc.defaultView;
    const beforePrint = () => void reapplyColorScheme(doc, false);
    const afterPrint = () => void reapplyColorScheme(doc, darkNow.current);
    win?.addEventListener("beforeprint", beforePrint);
    win?.addEventListener("afterprint", afterPrint);
    const unlock = lockedNow.current ? lockDocument(doc) : undefined;
    // no native webview menu in the mail either: Copy on selected text, Open link / Copy link address on a link (confidential mail has no menu at all)
    const unguard = lockedNow.current ? undefined : guardFrame(frame, doc);
    stopObserve.current = () => {
      unlock?.();
      unguard?.();
      imgs.forEach((i) => {
        i.removeEventListener("load", measure);
        i.removeEventListener("error", measure);
      });
      ro?.disconnect();
      paneRo?.disconnect();
      window.removeEventListener("resize", measure);
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("auxclick", onClick);
      win?.removeEventListener("beforeprint", beforePrint);
      win?.removeEventListener("afterprint", afterPrint);
    };
  };

  const onLoad = () => hookDoc();
  const hookRef = useRef(hookDoc);
  hookRef.current = hookDoc;
  // The mail is written into the frame before the first paint (a layout effect runs before the passive ones below, which hook the document). A written document keeps the frame's
  // Document object, so what the hooking remembers by identity is forgotten first (and the observers of the document that is replaced are stopped).
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    hooked.current = null;
    stopObserve.current();
    if (!writeMailDocument(frame, docParts)) {
      frame.srcdoc = docParts.join(""); // (no document to write into: the old way)
      mailFrameStats.fallbacks++;
    }
  }, [docParts, frameRef]);
  useLayoutEffect(() => {
    mailFrameStats.created++;
    return () => {
      mailFrameStats.removed++;
    };
  }, []);
  // watches for the document the written mail makes and hooks it once it is parsed
  useEffect(() => {
    let timer = 0;
    const t0 = Date.now();
    const look = () => {
      const doc = frameRef.current?.contentDocument;
      if (doc && doc !== hooked.current && doc.documentElement?.hasAttribute("data-hm-doc") && doc.readyState !== "loading" && doc.body) return hookRef.current();
      if (Date.now() - t0 < 10000) timer = window.setTimeout(look, 15);
    };
    look();
    // The way out of hm-pend when nothing recolours the mail is the CSS animation of the frame (mailCanvas.ts, 1.5 s), and an animation timeline stands still while the
    // window is hidden or not in front (WK-F7.02): this timer does not.
    const failsafe = window.setTimeout(() => frameRef.current?.contentDocument?.documentElement?.classList.remove("hm-pend"), 1500);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(failsafe);
    };
  }, [docParts, frameRef]);

  return (
    <>
      {clean.blocked > 0 && !allowed && (
        <div className="notice">
          {t("reading.body.blocked")}{" "}
          <button className="link" onClick={() => setAllow(true)}>{t("reading.body.loadContent")}</button>
          {" · "}
          <button className="link" onClick={() => setDialog({ type: "settings", tab: "mb:all", focus: "loadRemote" })}>
            {t("reading.body.alwaysLoad")}
          </button>
        </div>
      )}
      {/* no script can run (CSP script-src none; on Chromium the sandbox forbids scripts too); allow-same-origin only lets us read height / hook links */}
      <iframe
        ref={frameRef}
        className="msg-frame"
        // a dark mail sits on the dark surface even before its document has painted: the frame never shows the (light) pane through it for a frame (D-052)
        style={dark ? { background: `rgb(${DARK_CANVAS.join(",")})` } : undefined}
        sandbox={frameSandbox(navigator.userAgent)}
        scrolling="no"
        onLoad={onLoad}
        title={m.subject ? t("reading.body.frameTitleSubject", { subject: m.subject }) : t("reading.body.frameTitle")}
      />
    </>
  );
}

const AUTO_IMPORTED = new Set<string>();
// "Translate to ...": every language of the app (registry order), then the ones the model can write but the app is not translated into.
// The English name goes into the AI prompt; the key is the name shown in the menu (a language added to the registry fails tsc until it has one).
const LANG_NAME: Record<Lang, Key> = {
  en: "reading.lang.english",
  vi: "reading.lang.vietnamese",
  fr: "reading.lang.french",
  "zh-Hans": "reading.lang.chineseSimplified",
  es: "reading.lang.spanish",
  ja: "reading.lang.japanese",
  de: "reading.lang.german",
  ru: "reading.lang.russian",
};
export const TRANSLATE_TO: { en: string; key: Key }[] = [
  ...LANGS.map((l) => ({ en: l.englishName, key: LANG_NAME[l.code] })),
  { en: "Korean", key: "reading.lang.korean" },
];

/** An AI call under way, where it appears: ring, what is going on, the time and Cancel; a second line says where it is (Part 2 of 5). */
export function AiRunning({ title, text, detail, startedAt, onCancel }: { title: React.ReactNode; text: string; detail?: string; startedAt: number; onCancel: () => void }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className="summary tr-box" role="status">
      {title}
      <div className="tr-row">
        <span className="tr-main">
          <span className="busy-ring spin" aria-hidden />
          <span className="busy-dots" aria-hidden>···</span>
          <span className="tr-text">{text}</span>
        </span>
        <span className="tr-side">
          <span className="muted small tr-time" aria-hidden>{elapsedLabel(now - startedAt)}</span>
          <button className="link small" onClick={onCancel}>{t("common.cancel")}</button>
        </span>
      </div>
      {detail && <div className="muted small tr-hint">{detail}</div>}
      {slowHint(startedAt, now) && <div className="muted small tr-hint">{t("reading.translate.slow")}</div>}
    </div>
  );
}

/** The translation of a message, where it appears: progress while it runs (it goes on when the person reads other mail), the error, the text. */
function TranslateBox({ job }: { job: TranslateJob }) {
  const t = useT();
  const head = <b><Sparkles size={13} /> {t("reading.msg.translation")}</b>;
  const total = job.parts.length;
  if (job.status === "running")
    return (
      <AiRunning
        title={head}
        text={t("reading.msg.translating", { lang: t(job.langKey as Key) })}
        detail={total > 1 ? t("reading.translate.part", { n: job.translated.length + 1, total }) : undefined}
        startedAt={job.startedAt}
        onCancel={() => cancelTranslation(job.key)}
      />
    );
  if (job.status === "failed")
    return (
      <div className="summary tr-box error" role="alert">
        {head}
        <div className="tr-row">
          <AlertTriangle size={14} aria-hidden />
          <span className="tr-text">{t("reading.translate.failed", { error: jobErrorText(job) })}</span>
        </div>
        {total > 1 && job.translated.length > 0 && (
          <div className="muted small tr-hint">{t("reading.translate.resume", { done: job.translated.length, total, next: job.translated.length + 1 })}</div>
        )}
        <div className="tr-actions">
          <button className="link small" onClick={() => startTranslation(job)}>{t("common.retry")}</button>
          {/* the way to the field that is wrong (the key, the address, the model), as the toast of the other AI features has it */}
          <button className="link small" onClick={() => void openAiSettings(classifyAiError(job.errorSource ?? job.error ?? "")?.focus)}>{t("reading.aiProblem.openSettings")}</button>
          <button className="link small" onClick={() => dismissTranslation(job.key)}>{t("reading.msg.dismiss")}</button>
        </div>
      </div>
    );
  return (
    <div className="summary">
      {head}
      <div className="pre">{job.result}</div>
      {job.truncated && <div className="muted small tr-hint">{t("reading.translate.truncated", { n: fmtNumber(MAX_CHARS) })}</div>}
      <button className="link small" onClick={() => dismissTranslation(job.key)}>{t("reading.msg.dismiss")}</button>
    </div>
  );
}

/** "Translate to ...": a confidential or still locked message is not sent to the AI Assistant. */
export async function translateMessage(m: MessageFull, lang: { en: string; key: Key }) {
  const { showToast } = useStore.getState();
  if (needsCard(m)) return showToast(t("reading.ai.unlockThis"), undefined, "info");
  if (m.confidential) return showToast(t("reading.ai.noConfidential"), undefined, "info");
  // not set up: say so, with the way to Settings, instead of starting a job that can only fail
  if (!(await aiReady())) {
    showAiNotSetUp("translate");
    return;
  }
  startTranslation({
    messageId: m.id,
    threadId: useStore.getState().selected ?? m.id,
    folder: m.folder,
    accountId: m.accountId,
    subject: m.subject,
    lang: lang.en,
    langKey: lang.key,
    // all of it: a long text is translated in parts (src/translateChunks.ts)
    text: m.text ?? m.html?.replace(/<[^>]+>/g, " ") ?? "",
  });
}

/** Does this message draw a frame (the status "Opening message…" ends when it is visible)? An encrypted message that needs its card, and an invitation with no text, do not. */
export const hasFrame = (m: MessageFull): boolean => !needsCard(m) && !(m.invite && !m.html?.trim() && !m.text?.trim());

/**
 * A click that ends a text selection in the header (a drag over the sender or the recipients) is not a click on the message (W13.3, REQ-13.3.3). A double-click is two clicks that cancel
 * each other (as before), a triple-click is not counted at all, so neither changes the message while they select a word or a line.
 */
const headClickIsSelection = (e: React.MouseEvent<HTMLElement>): boolean => {
  if (e.detail >= 3) return true;
  if (e.detail === 2) return false;
  const head = e.currentTarget;
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0 && (head.contains(sel.anchorNode) || head.contains(sel.focusNode));
};

export function MessageCard({ m, open, onToggle }: { m: MessageFull; open: boolean; onToggle: () => void }) {
  const t = useT();
  const { showToast, setDialog, prefs } = useStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cv = useCanvas();
  const canvasLabel = t("reading.canvas.label");
  // the translation is a job in the store (it keeps running when this pane shows other mail)
  const job = useStore((s) => jobFor(s.translations, m.id));
  const [lightbox, setLightbox] = useState<{ items: { src: string; name: string }[]; index: number } | null>(null);
  const who = m.fromName || m.fromEmail;
  const conf = !!m.confidential;
  const noCopy = (e: React.SyntheticEvent) => conf && e.preventDefault();

  // received public keys: imported without asking when the mailbox is set to do that (once per message)
  const keyAtt = open ? m.attachments.find(isKeyAttachment) : undefined;
  const importMode = eff(prefs, m.accountId, "pgpImportFromMail");
  useEffect(() => {
    if (!keyAtt || importMode !== "auto" || AUTO_IMPORTED.has(m.id)) return;
    AUTO_IMPORTED.add(m.id);
    void importKeyFromMessage(m, keyAtt.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, keyAtt?.index, importMode]);

  // Unsubscribe always ends in one visible outcome (D-065, DEC-021): the link shows it is working at once (a ring, aria-busy, no second start) and
  // the work ends in a toast: "Unsubscribed" (the one-click POST was accepted), "the sender's page is open" (the browser was asked), "send this
  // message" (a compose was opened), or the error. The POST gives up by itself (5 s / 10 s in the backend); the page does not wait longer than 15 s.
  const [unsubBusy, setUnsubBusy] = useState(false);
  const unsubRunning = useRef(false);
  const unsub = async () => {
    if (unsubRunning.current) return;
    unsubRunning.current = true;
    setUnsubBusy(true);
    const shift = shiftNow(); // (read now: the server is asked first)
    let over = false;
    const end = () => {
      if (over) return false;
      over = true;
      clearTimeout(safety);
      unsubRunning.current = false;
      setUnsubBusy(false);
      return true;
    };
    const failed = (error: string) => showToast(() => t("reading.msg.unsubscribeFailed", { error }), undefined, "error");
    const safety = setTimeout(() => end() && failed(t("errors.timeout")), 15000);
    try {
      const r = await api.unsubscribe(m.id);
      if (over) return; // (the safety end has told already)
      if (r.kind === "done") {
        end();
        showToast(t("reading.msg.unsubscribed"), undefined, "success");
      } else if (r.kind === "open") {
        const opened = await openUpdateLink(r.target, false, (error) => void api.unsubscribeOpened(r.target, error).catch(() => undefined));
        // (a browser that could not be started has said so, with the copied link)
        if (end() && opened) showToast(() => t("reading.msg.unsubscribeOpened"), undefined, "info", undefined, 9000);
      } else {
        const mt = unsubscribeMailto(r.target); // the subject often holds the sender's token for this reader (RFC 2369)
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        void startCompose({ accountId: m.accountId, to: [mt.to], subject: mt.subject, ...(mt.body ? { bodyHtml: `<p>${esc(mt.body).replace(/\r?\n/g, "<br>")}</p>` } : {}) }, { shift });
        if (end()) showToast(() => t("reading.msg.unsubscribeMailto"), undefined, "info", undefined, 9000);
      }
    } catch (e) {
      if (end()) failed(friendlyError(e));
    }
  };

  /** Every attachment into one folder (pictures included); a failed file does not stop the others. */
  const saveAll = async (ask = false) => {
    if (conf) return showToast(t("reading.strip.confSave"), undefined, "info");
    // (W13.14 A5) several files into a folder the person did not have to choose: the download of the message and the disk take a while; "Loading…" says so until the result toast replaces it
    const working = m.attachments.length >= 2 && !(ask || prefs.askWhereToSave) ? pendingToast("save-all", () => t("common.loading"), 300) : null;
    try {
      const r = await api.attachmentSaveAll(m.id, ask || prefs.askWhereToSave);
      working?.end();
      if (!r) return;
      const folder = folderNameOf(r.dir) || r.dir;
      if (r.failed.length === 0) showToast(() => t("reading.strip.savedMany", { n: r.saved.length, folder }), undefined, "success", r.saved[0] ? [{ label: () => t("reading.att.showInFolder"), run: () => void revealSaved(r.saved[0]) }] : undefined);
      else showToast(() => t("reading.strip.savedPartial", { n: r.saved.length, total: m.attachments.length, name: r.failed[0].name, error: friendlyError(r.failed[0].error) }), undefined, "error", [{ label: () => t("common.retry"), run: () => void saveAll(ask) }]);
    } catch (e) {
      working?.end();
      showToast(() => t("reading.strip.saveAllFailed", { error: friendlyError(e) }), undefined, "error", [{ label: () => t("common.retry"), run: () => void saveAll(ask) }]);
    }
  };

  const translate = (lang: { en: string; key: Key }) => translateMessage(m, lang);

  const replyDefaultAll = eff(prefs, m.accountId, "replyDefault") === "replyAll";
  // the press shows on the button while the answer opens (W13.13): a ring in place of the icon, aria-busy, the progress cursor
  const reBusy = useAnswerBusy(answerKey("reply", m.id));
  const raBusy = useAnswerBusy(answerKey("replyAll", m.id));
  const fwBusy = useAnswerBusy(answerKey("forward", m.id));
  const printing = usePrinting((s) => s.on);
  const ring = <span className="spin" aria-hidden />;
  return (
    <div className={`rp-msg ${open ? "open" : ""}`}>
      <div className="rp-msg-head" onClick={(e) => { if (!headClickIsSelection(e)) onToggle(); }}>
        <Avatar name={who} size={40} />
        <div className="rp-meta">
          <div className="rp-from ellipsis" data-email={m.fromEmail}>
            <b>{who}</b>
            <span className="muted"> &lt;{m.fromEmail}&gt;</span>
          </div>
          {(m.importance === "high" || m.importance === "low") && <ImportanceMark level={m.importance} size={13} label />}
          <div className={`muted small ellipsis${open ? " rp-to" : ""}`}>{open ? (m.cc ? t("reading.msg.toCc", { to: m.to, cc: m.cc }) : t("reading.msg.to", { to: m.to })) : needsCard(m) ? t("reading.msg.encrypted") : conf ? t("reading.msg.confidential") : (m.text ?? "").replace(/\s+/g, " ").slice(0, 140)}</div>
        </div>
        {open && (
          <div className="rp-msg-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" data-intent="editor" title={t("reading.msg.reply")} aria-label={t("reading.msg.reply")} aria-busy={reBusy || undefined} onClick={() => replyTo(m, false)}>{reBusy ? ring : <Reply size={16} />}</button>
            <button className="icon-btn" data-intent="editor" title={t("reading.msg.replyAll")} aria-label={t("reading.msg.replyAll")} aria-busy={raBusy || undefined} onClick={() => replyTo(m, true)}>{raBusy ? ring : <ReplyAll size={16} />}</button>
            <button className="icon-btn" data-intent="editor" title={conf ? t("reading.msg.forwardBlocked") : t("reading.msg.forward")} aria-label={t("reading.msg.forward")} aria-busy={fwBusy || undefined} disabled={conf} onClick={() => forward(m)}>{fwBusy ? ring : <Forward size={16} />}</button>
            <button className="icon-btn" title={canvasLabel} aria-label={canvasLabel} aria-pressed={cv.dark} onClick={cv.toggle}>
              {cv.dark ? <Moon size={16} /> : <Sun size={16} />}
            </button>
            <Dropdown
              className="icon-btn"
              caret={false}
              align="right"
              title={t("reading.msg.moreActions")}
              items={[
                { label: t("reading.msg.showOriginal"), disabled: conf, onClick: () => setDialog({ type: "original", messageId: m.id }) },
                // macOS: WKWebView cannot print the frame itself, the backend prints a document made from it (printNative.ts, W5.3)
                { label: t("reading.msg.print"), disabled: conf || printing, onClick: () => void (osNow() === "macos" ? printFrameNative(frameRef.current, (text) => useStore.getState().showToast(() => text, undefined, "error")) : printFrame(frameRef.current)) },
                {
                  label: t("reading.msg.createEvent"),
                  onClick: () => setDialog({ type: "event", init: { summary: m.subject.replace(/^((re|fwd?):\s*)+/i, ""), description: conf ? "" : (m.text ?? "").trim().slice(0, 1500) } }),
                },
                { label: t("reading.msg.copySender"), onClick: () => void copyToClipboard(m.fromEmail).then((ok) => (ok ? showToast(t("reading.msg.copied")) : showToast(() => t("mail.ctx.copyFailed"), undefined, "error"))) },
                { divider: true },
                ...TRANSLATE_TO.map((l) => ({ label: t("reading.msg.translateTo", { lang: t(l.key) }), onClick: () => translate(l), disabled: needsCard(m) || conf })),
                ...(m.canUnsubscribe ? [{ divider: true }, { label: t("reading.msg.unsubscribe"), disabled: unsubBusy, onClick: () => void unsub() }] : []),
                ...(m.attachments.length ? [{ divider: true }, { label: t("reading.msg.saveAllAtt"), disabled: conf, onClick: () => void saveAll(false) }] : []),
              ]}
            >
              <MoreHorizontal size={16} />
            </Dropdown>
          </div>
        )}
        <div className="muted small rp-date">{fmtFull(m.date)}</div>
      </div>
      {open && (
        <div className={`rp-msg-body ${conf ? "confidential" : ""}`} onCopy={noCopy} onCut={noCopy} onContextMenu={noCopy} onDragStart={noCopy}>
          {conf && (
            <div className="notice conf-banner" role="note">
              <ShieldAlert size={14} aria-hidden /> {t("reading.protect.note")}
            </div>
          )}
          <SecBadges m={m} />
          {m.invite && <InviteCard m={m} />}
          {m.canUnsubscribe && (
            <div className="notice">
              {tx("reading.msg.newsletter", { link: <button className="link unsub-link" aria-busy={unsubBusy || undefined} onClick={() => void unsub()}>{t("reading.msg.unsubscribe")}{unsubBusy && <><span className="busy-ring spin" aria-hidden /><span className="busy-dots" aria-hidden>···</span></>}</button> })}
            </div>
          )}
          {job && <TranslateBox job={job} />}
          {!hasFrame(m) ? (needsCard(m) ? <EncCard m={m} /> : null) : <AfterPaint wait={isHeavy(m) && !isCleaned(m, eff(prefs, m.accountId, "loadRemote"))}><MessageBody m={m} frameRef={frameRef} dark={cv.dark} onPictures={(items, index) => setLightbox({ items, index })} /></AfterPaint>}
          <AttachmentStrip m={m} />
          {lightbox && (
            <Lightbox
              items={lightbox.items.map((p, i): LbItem => ({ key: `${i}:${p.name}`, name: p.name, load: () => Promise.resolve(p.src) }))}
              index={lightbox.index}
              confidential={conf}
              onClose={() => setLightbox(null)}
              onIndex={(i) => setLightbox((l) => (l ? { ...l, index: i } : l))}
            />
          )}
          <div className="rp-reply-row">
            <button className="btn" data-intent="editor" aria-busy={(replyDefaultAll ? raBusy : reBusy) || undefined} onClick={() => replyTo(m, replyDefaultAll)}>
              {(replyDefaultAll ? raBusy : reBusy) ? ring : replyDefaultAll ? <ReplyAll size={14} /> : <Reply size={14} />} {replyDefaultAll ? t("reading.msg.replyAll") : t("reading.msg.reply")}
            </button>
            <button className="btn" data-intent="editor" aria-busy={(replyDefaultAll ? reBusy : raBusy) || undefined} onClick={() => replyTo(m, !replyDefaultAll)}>
              {(replyDefaultAll ? reBusy : raBusy) ? ring : replyDefaultAll ? <Reply size={14} /> : <ReplyAll size={14} />} {replyDefaultAll ? t("reading.msg.reply") : t("reading.msg.replyAll")}
            </button>
            <button className="btn" data-intent="editor" aria-busy={fwBusy || undefined} disabled={conf} title={conf ? t("reading.msg.forwardBlocked") : undefined} onClick={() => forward(m)}>
              {fwBusy ? ring : <Forward size={14} />} {t("reading.msg.forward")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Keeps the reading position through a window resize (used by the reading pane and by the reader window): see the comment in the effect.
 */
export function useKeepReadingPosition() {
  // Keep the reading position through a window resize: the browser shifts scrollTop when the pane changes size and the
  // frame is re-measured (new zoom / height), so remember the position from before the resize and restore it by
  // proportion (scrollTop / scrollHeight) once the layout has settled. Only resizes: selecting a mail still starts at 0.
  useEffect(() => {
    const pane = () => document.querySelector<HTMLElement>(".rp-body");
    let saved = { top: 0, left: 0, h: 0 };
    let lastH = 0; // scrollHeight as of the last time the pane was at rest
    let resizing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      resizing = false;
      const p = pane();
      if (!p) return;
      const h = p.scrollHeight;
      p.scrollTop = saved.h && saved.h !== h ? Math.round((saved.top * h) / saved.h) : saved.top;
      p.scrollLeft = saved.left;
      lastH = p.scrollHeight;
    };
    const onScroll = (e: Event) => {
      if (!resizing && e.target instanceof HTMLElement && e.target.classList.contains("rp-body")) lastH = e.target.scrollHeight;
    };
    const onResize = () => {
      if (!resizing) {
        // .rp-body has overflow-anchor: none, so the browser has not moved the position yet: remember where the user was
        const p = pane();
        if (p) saved = { top: p.scrollTop, left: p.scrollLeft, h: lastH || p.scrollHeight };
      }
      resizing = true;
      clearTimeout(timer);
      timer = setTimeout(settle, 500);
    };
    const onMeasured = () => {
      // a frame re-measured (new height / zoom) while resizing: wait for the layout to stop changing
      if (!resizing) {
        const p = pane();
        if (p) lastH = p.scrollHeight;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(settle, 400);
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("rp-measured", onMeasured);
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("rp-measured", onMeasured);
      window.removeEventListener("resize", onResize);
    };
  }, []);
}

export function ReadingPane() {
  const t = useT();
  const { selected, messages, threads, folders, folder, act, showToast, prefs, aiConfigured, confirm, checked, openingDraft } = useStore();
  // a draft is being opened in Compose (it can take seconds): the status of REQ-13.7.1, shown only when the open is not over after 150 ms
  const draftBusy = useDelayedFlag(!!openingDraft);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryCut, setSummaryCut] = useState(false); // the conversation was longer than what was sent: the card says so
  const ai = useAiSlot("summarize");
  const summ = threads.find((th) => th.threadId === selected);
  const bodyRef = useRef<HTMLDivElement>(null);
  // while confidential mail is on screen the window is hidden from screen capture and recording
  useContentProtection(!!selected && messages.some((m) => m.confidential));

  // a newly selected mail starts at the top - once, here, and nowhere else (nothing re-scrolls while it loads)
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selected]);

  useKeepReadingPosition();
  // (W13.6) "Opening message…" over the body area from the selection until the frame of the open message is visible
  const openError = useStore((s) => s.openError);
  const opening = useOpeningPending(selected && summ ? selected : null, messages, hasFrame) && openError !== selected;
  const printing = usePrinting((s) => s.on);

  // another conversation: a summary still being made is dropped (its request too), so it is never shown on the wrong mail
  useEffect(() => ai.cancel, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // and the "Try again" of a failed summary is for that conversation: it goes with it
  useEffect(() => () => leaveAiContext("summarize"), [selected]);

  useEffect(() => {
    setSummary(null);
    setSummaryCut(false);
    setOpenIds(new Set(messages.length ? [messages[messages.length - 1].id] : []));
  }, [selected, messages.length]);

  if (draftBusy) {
    return (
      <section className="reading-pane empty" aria-label={t("reading.pane.label")}>
        <div className="reader-state" role="status" aria-busy="true">
          <span className="busy-ring spin" aria-hidden />
          <span className="busy-dots" aria-hidden>···</span>
          <p className="muted">{t("compose.draft.opening")}</p>
        </div>
      </section>
    );
  }
  if (!selected || !summ) {
    return (
      <section className="reading-pane empty" aria-label={t("reading.pane.label")}>
        <EmptyState
          icon={<Mail size={44} />}
          title={t("reading.empty.title")}
          text={checked.size > 1 ? t("reading.empty.selected", { n: checked.size }) : t("reading.empty.none")}
        />
      </section>
    );
  }

  const last = messages[messages.length - 1];
  const id = [selected];
  // no Junk folder on the mailbox: the items that move mail there are off, with the reason (src/junk.ts)
  const junkOff = canMoveToJunk(folders, accountsOf(threads, id)) ? {} : { disabled: true, hint: t("mail.junk.none"), title: t("mail.junk.noneTip") };
  const allOpen = messages.length > 0 && openIds.size === messages.length;

  const summarize = async () => {
    if (!(await aiReady())) {
      showAiNotSetUp("summarize");
      return;
    }
    const readable = messages.filter((m) => !needsCard(m) && !m.confidential);
    if (readable.length === 0) {
      showToast(messages.some((m) => m.confidential) ? t("reading.ai.noConfidential") : t("reading.ai.unlockEncrypted"), undefined, "info");
      return;
    }
    const { body, cut } = summaryBody(readable.map((m) => ({ head: `From: ${m.fromName} <${m.fromEmail}>\nDate: ${fmtFull(m.date)}`, text: m.text ?? "" })));
    clearAiProblem(); // (the toast of an earlier problem goes while this request runs)
    const out = await ai.run(
      // i18n-ok: a prompt for the language model, not text the person reads
      "You summarize email conversations. Reply with 2-5 concise bullet points covering key facts, decisions and requested actions. Use the language of the emails.",
      // the subject of a thread with confidential mail may be that mail's, so it is left out
      `${messages.some((m) => m.confidential) ? "" : `Subject: ${summ.subject}\n\n`}${body}`,
    );
    if (!out) return; // a click while one is under way, or Cancel: nothing to show
    if ("error" in out) showAiProblem(out.error, { feature: "summarize", retry: () => void summarize(), tied: true });
    else (setSummary(out.text), setSummaryCut(cut));
  };

  const block = async () => {
    if (!last) return;
    const ok = await confirm({
      title: t("reading.head.blockTitle", { email: last.fromEmail }),
      body: t("reading.head.blockBody"),
      confirmLabel: t("reading.head.blockConfirm"),
      danger: true,
    });
    if (ok) void act(id, "block", undefined, () => t("reading.head.blocked", { email: last.fromEmail }));
  };

  return (
    <section className="reading-pane" aria-label={t("reading.pane.label")}>
      <div className="rp-head">
        <h2>{subjectText(summ.subject)}</h2>
        <div className="rp-tools">
          <button className="icon-btn" title={t("reading.head.archiveTip")} aria-label={t("reading.head.archive")} onClick={() => void act(id, "archive", undefined, () => t("reading.head.archived"))}><Archive size={16} /></button>
          <button className="icon-btn" title={t("reading.head.deleteTip")} aria-label={t("reading.head.delete")} onClick={() => void act(id, "trash", undefined, () => t("reading.head.trashed"))}><Trash2 size={16} /></button>
          <Dropdown
            className="icon-btn snooze-btn"
            caret={false}
            title={t("reading.head.snoozeTip")}
            label={t("mail.hover.snooze")}
            items={snoozePresets(prefs.snoozeTimes).map((p) => ({
              label: p.label,
              onClick: () => void act(id, "snooze", String(p.ts), () => t("reading.head.snoozed", { label: p.label })),
            }))}
          >
            <Clock size={16} />
          </Dropdown>
          <button className={`icon-btn ${summ.pinned ? "on" : ""}`} title={t("reading.head.pinTip")} aria-label={t("reading.head.pin")} onClick={() => void act(id, summ.pinned ? "unpin" : "pin")}><Pin size={16} /></button>
          <button className={`icon-btn ${summ.flagged ? "on" : ""}`} title={t("reading.head.flagTip")} aria-label={t("reading.head.flag")} onClick={() => void act(id, summ.flagged ? "unstar" : "star")}><Flag size={16} fill={summ.flagged ? "currentColor" : "none"} /></button>
          <Dropdown
            className="icon-btn"
            caret={false}
            title={t("reading.head.more")}
            items={[
              { label: t("reading.head.markUnread"), icon: <MailX size={14} />, onClick: () => void act(id, "unread", undefined, () => t("reading.head.markedUnread")) },
              { label: t("reading.head.moveJunk"), onClick: () => void act(id, "junk", undefined, () => t("reading.head.movedJunk")), ...junkOff },
              { divider: true },
              { label: t("reading.head.blockSender"), onClick: () => void block(), ...junkOff },
            ]}
          >
            <MoreHorizontal size={16} />
          </Dropdown>
          {readerAllowed(folder, summ.folder) && (
            <button className="icon-btn" title={t("reading.popout.openTip")} aria-label={t("reading.popout.open")} onClick={() => void openReader(summ, folder)}><ExternalLink size={16} /></button>
          )}
          {messages.length > 1 && (
            <button
              className="icon-btn"
              title={allOpen ? t("reading.head.collapseAllTip") : t("reading.head.expandAllTip")}
              aria-label={allOpen ? t("reading.head.collapseAll") : t("reading.head.expandAll")}
              onClick={() => setOpenIds(allOpen ? new Set([messages[messages.length - 1].id]) : new Set(messages.map((m) => m.id)))}
            >
              {allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            </button>
          )}
          <button
            className="btn small ai-btn"
            onClick={summarize}
            disabled={ai.running}
            title={aiConfigured ? t("reading.head.summarizeTip") : t("reading.head.setupAiTip")}
          >
            <Sparkles size={13} /> {ai.running ? t("reading.head.summarizing") : aiConfigured ? t("reading.head.summarize") : t("reading.head.setupAi")}
          </button>
        </div>
      </div>
      {ai.running && ai.startedAt !== null && (
        <AiRunning
          title={<b><Sparkles size={13} /> {t("reading.head.summaryTitle")}</b>}
          text={t("reading.head.summarizing")}
          startedAt={ai.startedAt}
          onCancel={ai.cancel}
        />
      )}
      {summary && (
        <div className="summary">
          <b><Sparkles size={13} /> {t("reading.head.summaryTitle")}</b>
          <div className="pre">{summary}</div>
          {summaryCut && <div className="muted small tr-hint">{t("reading.head.summaryCut")}</div>}
        </div>
      )}
      <RpBody key={selected} pending={opening} heavy={isHeavy(last)} printing={printing} bodyRef={bodyRef}>
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            m={m}
            open={openIds.has(m.id)}
            onToggle={() =>
              setOpenIds((s) => {
                const n = new Set(s);
                if (n.has(m.id)) n.delete(m.id);
                else n.add(m.id);
                return n;
              })
            }
          />
        ))}
      </RpBody>
    </section>
  );
}
