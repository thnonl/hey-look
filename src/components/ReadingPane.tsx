import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, Clock, Flag, Forward, MailX, MoreHorizontal, Moon, Pin, Reply, ReplyAll, Sparkles, Sun, Trash2, ChevronsDownUp, ChevronsUpDown, Mail, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { forward, replyTo } from "../actions";
import { api, MessageFull } from "../api";
import { appSurface, setMailDark } from "../darkMail";
import { eff } from "../prefs";
import { CONFIDENTIAL_FRAME_CSS, CONFIDENTIAL_NOTE, lockDocument, useContentProtection } from "../protect";
import { friendlyError, useStore } from "../store";
import { useAppDark } from "../useAppDark";
import { fmtFull, fmtSize, plainToHtml, sanitizeHtml, snoozePresets } from "../util";
import { AttachmentStrip, Lightbox, LbItem } from "./Attachments";
import { InviteCard } from "./Calendar";
import { EmptyState } from "./overlays";
import { EncCard, importKeyFromMessage, isKeyAttachment, needsCard, SecBadges } from "./Pgp";
import { Avatar, Dropdown } from "./ui";

// Remote images already fetched through the backend (url -> data: URI), shared by all messages.
const imageCache = new Map<string, string>();

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

function remoteImageUrls(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set<string>();
  doc.querySelectorAll("img[src]").forEach((i) => {
    const u = i.getAttribute("src") ?? "";
    if (/^https?:\/\//i.test(u)) urls.add(u);
  });
  return Array.from(urls);
}

/** Pictures the sync did not embed: loaded ones become data: URIs, the rest become click-to-load placeholders. */
function pictureHtml(html: string, m: MessageFull, loaded: Record<string, string>, state: Record<string, { status: "loading" | "failed"; error?: string }>): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
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
      ph.textContent = `Picture missing from this message (cid:${cid})`;
    } else if (st?.status === "loading") {
      ph.setAttribute("aria-busy", "true");
      const spin = doc.createElement("span");
      spin.className = "hl-spin";
      ph.append(spin, `Loading ${fmtSize(meta.size)}…`);
    } else if (st?.status === "failed") {
      ph.classList.add("bad");
      const b = doc.createElement("b");
      b.textContent = "Couldn’t load this picture.";
      ph.append(b, " Retry");
    } else {
      const b = doc.createElement("b");
      b.textContent = meta.name;
      const small = doc.createElement("span");
      small.textContent = `${fmtSize(meta.size)} · large picture, not loaded yet`;
      ph.append(b, doc.createElement("br"), small, " · Show");
    }
    ph.setAttribute("aria-label", meta ? `Show picture ${meta.name}, ${fmtSize(meta.size)}` : "Picture missing");
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

const host = (u: string) => {
  try {
    return new URL(/^[a-z]+:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** Background the mail is shown on: dark in the dark theme (see darkMail.ts), the toggle shows the original colours of this mail instead. */
function useCanvas() {
  const appDark = useAppDark();
  const [light, setLight] = useState(false);
  useEffect(() => setLight(false), [appDark]);
  const dark = appDark && !light;
  return { appDark, dark, toggle: () => setLight(dark) };
}

function MessageBody({ m, frameRef, dark, onPictures }: { m: MessageFull; frameRef: React.RefObject<HTMLIFrameElement | null>; dark: boolean; onPictures: (items: { src: string; name: string }[], index: number) => void }) {
  const prefs = useStore((s) => s.prefs);
  const setDialog = useStore((s) => s.setDialog);
  const confirm = useStore((s) => s.confirm);
  const loadRemote = eff(prefs, m.accountId, "loadRemote");
  const [allow, setAllow] = useState(false);
  const [version, setVersion] = useState(0); // bumps when images arrive from the backend
  const [loadedPics, setLoadedPics] = useState<Record<string, string>>({});
  const [picState, setPicState] = useState<Record<string, { status: "loading" | "failed"; error?: string }>>({});
  const allowed = loadRemote || allow;
  const clean = useMemo(
    () => (m.html ? sanitizeHtml(m.html, allowed) : { html: plainToHtml(m.text ?? ""), blocked: 0 }),
    [m, allowed],
  );
  const html = useMemo(
    () => pictureHtml(allowed ? inlineImages(clean.html) : clean.html, m, loadedPics, picState),
    [clean, allowed, version, m, loadedPics, picState], // eslint-disable-line react-hooks/exhaustive-deps
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
      Object.entries(got).forEach(([u, d]) => imageCache.set(u, d));
      setVersion((v) => v + 1);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [allowed, clean, m.html]);

  // CSP inside the message frame: without consent nothing remote may load; with consent the backend already
  // inlined what it could and the rest falls back to a direct request.
  const csp = allowed ? "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:" : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  // The base colours switch with a class on <html> (screen only, so print stays light), and the mail's own colours with
  // the sheet from darkMail.ts: toggling never reloads the frame. The frame is created already dark and hidden
  // (hm-pend) so the original colours are never painted first. The picture placeholders (.hl-ph) are ordinary mail
  // elements for the dark sheet, so they are recoloured with the rest.
  const darkNow = useRef(dark);
  darkNow.current = dark;
  const lockedNow = useRef(!!m.confidential);
  lockedNow.current = !!m.confidential;
  const srcDoc = useMemo(
    () => `<!doctype html><html data-hm-doc${darkNow.current ? ' class="hm-dark hm-pend"' : ""}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
    <style>html{--hm-fg:#242424;--hm-link:#0f6cbd;--hm-bg:#ffffff}
    @media screen{html.hm-dark{--hm-fg:#e6e6e6;--hm-link:#6cb8f6;--hm-bg:transparent;color-scheme:dark}html.hm-dark img{filter:brightness(.9)}html.hm-pend body{visibility:hidden}}
    body{font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;margin:0;padding:10px 12px;word-wrap:break-word;background:var(--hm-bg);color:var(--hm-fg)}
    img{max-width:100%;height:auto;cursor:zoom-in}blockquote{margin:0 0 0 .8ex;border-left:2px solid #999;padding-left:1ex}a{color:var(--hm-link)}table{max-width:100%}
    .hl-ph{display:flex;align-items:center;gap:10px;max-width:100%;width:360px;padding:12px 14px;border:1px dashed #9aa3af;border-radius:10px;background:#f6f7f9;color:#5b6470;font:13px/1.4 "Segoe UI",sans-serif;cursor:pointer;text-align:left;box-sizing:border-box;flex-wrap:wrap}
    .hl-ph:hover{background:#eceef2}.hl-ph b{color:#1f2328}.hl-ph.bad{border-color:#c4314b;color:#c4314b}.hl-ph:disabled{cursor:default}
    ${lockedNow.current ? CONFIDENTIAL_FRAME_CSS : ""}
    .hl-spin{width:14px;height:14px;border:2px solid #9aa3af;border-top-color:transparent;border-radius:50%;animation:hlspin 1s linear infinite;flex:none}@keyframes hlspin{to{transform:rotate(360deg)}}</style>
    </head><body>${html}<style>html,body{overflow:hidden!important;height:auto!important;min-height:0!important}</style></body></html>`,
    [html, csp, m.confidential], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // theme change or toggle on a loaded mail: recolour in place (a freshly loaded mail is handled in onLoad)
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.documentElement?.hasAttribute("data-hm-doc")) setMailDark(doc, dark, appSurface());
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
    if (h > 0 && !loading) heightCache.set(m.id, h);
    frame.style.visibility = ""; // first measurement done: show the mail at its final height
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
    const safety = setTimeout(() => (frame.style.visibility = ""), 600);
    return () => clearTimeout(safety);
  }, [frameRef, m.id]);

  useEffect(() => () => stopObserve.current(), []);

  const onLoad = () => {
    stopObserve.current();
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;
    setMailDark(doc, darkNow.current, appSurface());
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
      const looksLikeUrl = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(text);
      if (looksLikeUrl && host(text) && host(text) !== host(a.href)) {
        void confirm({
          title: "This link may not go where it says",
          body: `It is shown as “${text.slice(0, 80)}” but opens ${host(a.href) || a.href}. Open it anyway?`,
          confirmLabel: "Open link",
          danger: true,
        }).then((ok) => ok && void openUrl(a.href));
      } else void openUrl(a.href);
    };
    doc.addEventListener("click", onClick);
    const unlock = lockedNow.current ? lockDocument(doc) : undefined;
    stopObserve.current = () => {
      unlock?.();
      imgs.forEach((i) => {
        i.removeEventListener("load", measure);
        i.removeEventListener("error", measure);
      });
      ro?.disconnect();
      paneRo?.disconnect();
      window.removeEventListener("resize", measure);
      doc.removeEventListener("click", onClick);
    };
  };

  return (
    <>
      {clean.blocked > 0 && !allowed && (
        <div className="notice">
          Some content in this message has been blocked to help prevent tracking.{" "}
          <button className="link" onClick={() => setAllow(true)}>Load content</button>
          {" · "}
          <button className="link" onClick={() => setDialog({ type: "settings", tab: "mb:all", focus: "loadRemote" })}>
            Always load remote content (Settings)
          </button>
        </div>
      )}
      {/* sandbox without allow-scripts: no script can run; allow-same-origin only lets us read height / hook links */}
      <iframe
        ref={frameRef}
        className="msg-frame"
        sandbox="allow-same-origin allow-modals"
        scrolling="no"
        srcDoc={srcDoc}
        onLoad={onLoad}
        title={m.subject ? `Message body: ${m.subject}` : "Message body"}
      />
    </>
  );
}

const AUTO_IMPORTED = new Set<string>();
const LANGS = ["English", "Vietnamese", "Japanese", "Chinese (Simplified)", "Korean", "French", "German", "Spanish"];

function MessageCard({ m, open, onToggle }: { m: MessageFull; open: boolean; onToggle: () => void }) {
  const { showToast, setDialog, prefs } = useStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cv = useCanvas();
  const [translated, setTranslated] = useState<string | null>(null);
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

  const unsub = async () => {
    try {
      const r = await api.unsubscribe(m.id);
      if (r.kind === "done") showToast("Unsubscribed", undefined, "success");
      else if (r.kind === "open") await openUrl(r.target);
      else void useStore.getState().openCompose({ accountId: m.accountId, to: [r.target.replace("mailto:", "").split("?")[0]], subject: "unsubscribe" });
    } catch (e) {
      showToast(`Unsubscribe failed: ${e}`, undefined, "error");
    }
  };

  /** Every attachment into one folder (pictures included); a failed file does not stop the others. */
  const saveAll = async (ask = false) => {
    if (conf) return showToast("Attachments of confidential mail can’t be saved.", undefined, "info");
    try {
      const r = await api.attachmentSaveAll(m.id, ask || prefs.askWhereToSave);
      if (!r) return;
      const folder = r.dir.split(/[\\/]/).filter(Boolean).pop() ?? r.dir;
      if (r.failed.length === 0) showToast(`Saved ${r.saved.length} attachment${r.saved.length === 1 ? "" : "s"} to ${folder}`, undefined, "success", r.saved[0] ? [{ label: "Show in folder", run: () => void api.attachmentReveal(r.saved[0]).catch(() => undefined) }] : undefined);
      else showToast(`Saved ${r.saved.length} of ${m.attachments.length}. ${r.failed[0].name} failed: ${friendlyError(r.failed[0].error)}`, undefined, "error", [{ label: "Retry", run: () => void saveAll(ask) }]);
    } catch (e) {
      showToast(`Save all failed: ${friendlyError(e)}`, undefined, "error", [{ label: "Retry", run: () => void saveAll(ask) }]);
    }
  };

  const translate = async (lang: string) => {
    if (needsCard(m)) return showToast("Unlock this message first.", undefined, "info");
    if (conf) return showToast("Confidential mail isn’t sent to the AI Assistant.", undefined, "info");
    showToast(`Translating to ${lang}…`);
    try {
      setTranslated(
        await api.aiComplete(
          `Translate the email into ${lang}. Output only the translation, keep the formatting and line breaks.`,
          (m.text ?? m.html?.replace(/<[^>]+>/g, " ") ?? "").slice(0, 12000),
        ),
      );
    } catch (e) {
      showToast(String(e), undefined, "error");
    }
  };

  const replyDefaultAll = eff(prefs, m.accountId, "replyDefault") === "replyAll";
  return (
    <div className={`rp-msg ${open ? "open" : ""}`}>
      <div className="rp-msg-head" onClick={onToggle}>
        <Avatar name={who} size={40} />
        <div className="rp-meta">
          <div className="rp-from ellipsis">
            <b>{who}</b>
            <span className="muted"> &lt;{m.fromEmail}&gt;</span>
          </div>
          <div className="muted small ellipsis">{open ? `To: ${m.to}${m.cc ? `; Cc: ${m.cc}` : ""}` : needsCard(m) ? "Encrypted message" : conf ? "Confidential message" : (m.text ?? "").replace(/\s+/g, " ").slice(0, 140)}</div>
        </div>
        {open && (
          <div className="rp-msg-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn" title="Reply" aria-label="Reply" onClick={() => replyTo(m, false)}><Reply size={16} /></button>
            <button className="icon-btn" title="Reply all" aria-label="Reply all" onClick={() => replyTo(m, true)}><ReplyAll size={16} /></button>
            <button className="icon-btn" title={conf ? "Confidential mail can’t be forwarded" : "Forward"} aria-label="Forward" disabled={conf} onClick={() => forward(m)}><Forward size={16} /></button>
            {cv.appDark && (
              <button
                className="icon-btn"
                title={!cv.dark ? "Switch to dark background" : "Switch to light background"}
                aria-label={!cv.dark ? "Switch to dark background" : "Switch to light background"}
                onClick={cv.toggle}
              >
                {!cv.dark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            )}
            <Dropdown
              className="icon-btn"
              caret={false}
              align="right"
              title="More actions"
              items={[
                { label: "Show original", disabled: conf, onClick: () => setDialog({ type: "original", messageId: m.id }) },
                { label: "Print", disabled: conf, onClick: () => frameRef.current?.contentWindow?.print() },
                {
                  label: "Create event from this email…",
                  onClick: () => setDialog({ type: "event", init: { summary: m.subject.replace(/^((re|fwd?):\s*)+/i, ""), description: conf ? "" : (m.text ?? "").trim().slice(0, 1500) } }),
                },
                { label: "Copy sender email", onClick: () => void navigator.clipboard.writeText(m.fromEmail).then(() => showToast("Copied")) },
                { divider: true },
                ...LANGS.map((l) => ({ label: `Translate to ${l}`, onClick: () => void translate(l), disabled: needsCard(m) || conf })),
                ...(m.canUnsubscribe ? [{ divider: true }, { label: "Unsubscribe", onClick: () => void unsub() }] : []),
                ...(m.attachments.length ? [{ divider: true }, { label: "Save all attachments…", disabled: conf, onClick: () => void saveAll(false) }] : []),
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
              <ShieldAlert size={14} aria-hidden /> {CONFIDENTIAL_NOTE}
            </div>
          )}
          <SecBadges m={m} />
          {m.invite && <InviteCard m={m} />}
          {m.canUnsubscribe && (
            <div className="notice">
              This looks like a newsletter. <button className="link" onClick={unsub}>Unsubscribe</button>
            </div>
          )}
          {translated && (
            <div className="summary">
              <b><Sparkles size={13} /> Translation</b>
              <div className="pre">{translated}</div>
              <button className="link small" onClick={() => setTranslated(null)}>Dismiss</button>
            </div>
          )}
          {needsCard(m) ? <EncCard m={m} /> : m.invite && !m.html?.trim() && !m.text?.trim() ? null : <MessageBody m={m} frameRef={frameRef} dark={cv.dark} onPictures={(items, index) => setLightbox({ items, index })} />}
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
            <button className="btn" onClick={() => replyTo(m, replyDefaultAll)}>
              {replyDefaultAll ? <ReplyAll size={14} /> : <Reply size={14} />} {replyDefaultAll ? "Reply all" : "Reply"}
            </button>
            <button className="btn" onClick={() => replyTo(m, !replyDefaultAll)}>
              {replyDefaultAll ? <Reply size={14} /> : <ReplyAll size={14} />} {replyDefaultAll ? "Reply" : "Reply all"}
            </button>
            <button className="btn" disabled={conf} title={conf ? "Confidential mail can’t be forwarded" : undefined} onClick={() => forward(m)}>
              <Forward size={14} /> Forward
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReadingPane() {
  const { selected, messages, threads, act, showToast, prefs, aiConfigured, setDialog, confirm, checked } = useStore();
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const summ = threads.find((t) => t.threadId === selected);
  const bodyRef = useRef<HTMLDivElement>(null);
  // while confidential mail is on screen the window is hidden from screen capture and recording
  useContentProtection(!!selected && messages.some((m) => m.confidential));

  // a newly selected mail starts at the top - once, here, and nowhere else (nothing re-scrolls while it loads)
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selected]);

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

  useEffect(() => {
    setSummary(null);
    setOpenIds(new Set(messages.length ? [messages[messages.length - 1].id] : []));
  }, [selected, messages.length]);

  if (!selected || !summ) {
    return (
      <section className="reading-pane empty" aria-label="Reading pane">
        <EmptyState
          icon={<Mail size={44} />}
          title="Select an item to read"
          text={checked.size > 1 ? `${checked.size} items selected` : "Nothing is selected"}
        />
      </section>
    );
  }

  const last = messages[messages.length - 1];
  const id = [selected];
  const allOpen = messages.length > 0 && openIds.size === messages.length;

  const summarize = async () => {
    if (!aiConfigured) {
      setDialog({ type: "settings", tab: "ai" });
      return;
    }
    setBusy(true);
    try {
      const readable = messages.filter((m) => !needsCard(m) && !m.confidential);
      if (readable.length === 0) {
        showToast(messages.some((m) => m.confidential) ? "Confidential mail isn’t sent to the AI Assistant." : "Unlock the encrypted message first.", undefined, "info");
        return;
      }
      const body = readable
        .map((m) => `From: ${m.fromName} <${m.fromEmail}>\nDate: ${fmtFull(m.date)}\n\n${(m.text ?? "").slice(0, 4000)}`)
        .join("\n\n-----\n\n")
        .slice(0, 24000);
      setSummary(
        await api.aiComplete(
          "You summarize email conversations. Reply with 2-5 concise bullet points covering key facts, decisions and requested actions. Use the language of the emails.",
          // the subject of a thread with confidential mail may be that mail's, so it is left out
          `${messages.some((m) => m.confidential) ? "" : `Subject: ${summ.subject}\n\n`}${body}`,
        ),
      );
    } catch (e) {
      showToast(String(e), undefined, "error");
    } finally {
      setBusy(false);
    }
  };

  const block = async () => {
    if (!last) return;
    const ok = await confirm({
      title: `Block ${last.fromEmail}?`,
      body: "Mail from this sender moves to Junk and they are added to Blocked senders (Settings → Blocked senders), where you can undo it.",
      confirmLabel: "Block sender",
      danger: true,
    });
    if (ok) void act(id, "block", undefined, `Blocked ${last.fromEmail}`);
  };

  return (
    <section className="reading-pane" aria-label="Reading pane">
      <div className="rp-head">
        <h2>{summ.subject}</h2>
        <div className="rp-tools">
          <button className="icon-btn" title="Archive (e)" aria-label="Archive" onClick={() => void act(id, "archive", undefined, "Archived")}><Archive size={16} /></button>
          <button className="icon-btn" title="Delete (#)" aria-label="Delete" onClick={() => void act(id, "trash", undefined, "Moved to Deleted Items")}><Trash2 size={16} /></button>
          <Dropdown
            className="icon-btn"
            caret={false}
            title="Snooze (s)"
            items={snoozePresets(prefs.snoozeTimes).map((p) => ({
              label: p.label,
              onClick: () => void act(id, "snooze", String(p.ts), `Snoozed: ${p.label}`),
            }))}
          >
            <Clock size={16} />
          </Dropdown>
          <button className={`icon-btn ${summ.pinned ? "on" : ""}`} title="Pin (p)" aria-label="Pin" onClick={() => void act(id, summ.pinned ? "unpin" : "pin")}><Pin size={16} /></button>
          <button className={`icon-btn ${summ.flagged ? "on" : ""}`} title="Flag (*)" aria-label="Flag" onClick={() => void act(id, summ.flagged ? "unstar" : "star")}><Flag size={16} fill={summ.flagged ? "currentColor" : "none"} /></button>
          <Dropdown
            className="icon-btn"
            caret={false}
            title="More"
            items={[
              { label: "Mark as unread", icon: <MailX size={14} />, onClick: () => void act(id, "unread", undefined, "Marked as unread") },
              { label: "Move to Junk", onClick: () => void act(id, "junk", undefined, "Moved to Junk") },
              { divider: true },
              { label: "Block sender…", onClick: () => void block() },
            ]}
          >
            <MoreHorizontal size={16} />
          </Dropdown>
          {messages.length > 1 && (
            <button
              className="icon-btn"
              title={allOpen ? "Collapse all messages" : "Expand all messages"}
              aria-label={allOpen ? "Collapse all" : "Expand all"}
              onClick={() => setOpenIds(allOpen ? new Set([messages[messages.length - 1].id]) : new Set(messages.map((m) => m.id)))}
            >
              {allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            </button>
          )}
          <button
            className="btn small ai-btn"
            onClick={summarize}
            disabled={busy}
            title={aiConfigured ? "Summarize this conversation" : "Set up the AI Assistant in Settings first"}
          >
            <Sparkles size={13} /> {busy ? "Summarizing…" : aiConfigured ? "Summarize" : "Set up AI"}
          </button>
        </div>
      </div>
      {summary && (
        <div className="summary">
          <b><Sparkles size={13} /> Conversation summary</b>
          <div className="pre">{summary}</div>
        </div>
      )}
      <div className="rp-body" ref={bodyRef}>
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
      </div>
    </section>
  );
}
