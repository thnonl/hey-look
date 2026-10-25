// The quote block of a reply or forward in the composer (spec-rich-text.md REQ-35, design 4.6): the original message is NOT parsed into the editor's
// schema. It is one atom node (`quoteBlock`, attributes in quoteBlock.ts) shown read-only with its own formatting in a shadow tree (the app's style sheets
// cannot reach into it and its own cannot reach out), and written back to the stored / sent HTML exactly as it was cleaned (emailHtml.ts).
//
//  - Shown: the original goes through DOMPurify again (a draft that came back from the server is not trusted), links do nothing on a plain click and open the
//    default browser on Ctrl/Cmd+click. Pictures from the web follow the reading pane's rule (the account's "Load remote content"): allowed = the backend fetches
//    them (remoteImages.ts, the cache the reading pane fills too) and the quote draws that data: copy, the webview never contacts the sender's server; not
//    allowed = a box of the size the mail gave (the reading pane's), a note and "Load content" for this quote. Either way the address stays in the sent HTML.
//  - Header: the attribution line / forward header, "Edit quoted text" (after a confirmation the original becomes ordinary editable text), Hide / Show,
//    Remove. A click on the block selects it; Delete / Backspace on the selection removes it (one Undo brings it back).
//  - Guarded: typing, pasting or Enter while the block is selected go below it instead of replacing it; Backspace / Delete next to it never merge with it;
//    a pasted block is dropped (a second quote cannot be made by hand); there is never more than one.
//  - Preview: on the dark "Preview as recipient" surface the original is recoloured like the reading pane does (composePreviewDom.ts); the document and the
//    sent bytes are never changed by it.
// Part of the editor kit chunk (kit.ts).

import { Node as TipNode, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import DOMPurify from "dompurify";
import { blockedPictureBox } from "../blockedPicture";
import { setDarkRegion } from "../composePreviewDom";
import { t } from "../i18n";
import { checkLinkUrl } from "../linkUrl";
import { BLOCKED_PICTURE_CSS } from "../mailFrameCss";
import { openExternal } from "../open";
import { kbd } from "../platform";
import { cachedImage, loadRemoteImages } from "../remoteImages";
import type { BaseFont } from "./emailHtml";
import { QUOTE_STYLE } from "./quoteBlock";
import { QUOTE_NODE, quoteGuard } from "./quoteGuard";

export interface QuoteOptions {
  /** the confirmation before the original becomes editable text; true = go on */
  ask: () => Promise<boolean>;
  /** the default font of the message (the paste cleaner leaves it out of the text it keeps) */
  base: () => BaseFont;
  /** may pictures from the web be fetched (the account's "Load remote content", as the reading pane asks it)? */
  remote: () => boolean;
}

const NAME = QUOTE_NODE;

// ---------------------------------------------------------------- what is shown

const TAGS = "p br div span strong b em i u s strike sub sup a ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code hr img table thead tbody tfoot tr th td caption colgroup col".split(" ");
const ATTRS = "style dir align href src alt title width height border cellpadding cellspacing bgcolor colspan rowspan valign type start value span".split(" ");

let purify: ReturnType<typeof DOMPurify> | null = null;
let blockedNow = 0;
let pendingNow: string[] = [];
/** What the running `displayHtml` may do with a picture from the web: undefined = nothing (its address is taken off); else show the copy the backend fetched, when the cache has it. */
let webNow: { tried: ReadonlySet<string> } | undefined;

const isWeb = (u: string) => /^https?:\/\//i.test(u);

/**
 * The original as it is shown: allow-list again, no link scheme but http / https / mailto / tel, no `url()` in a style, and no picture from the web but a data: copy of it that the
 * backend fetched (`web`: the reading pane's rule allows it; `tried`: addresses already asked for in vain). Every other picture loses its address (`data-blocked`; `boxes` draws a box
 * instead). `blocked` counts the ones the rule keeps back; `pending` lists the web pictures that are not in the cache yet (they are `data-pending`).
 */
function displayHtml(html: string, web?: { tried: ReadonlySet<string> }): { html: string; blocked: number; pending: string[] } {
  if (!purify) {
    purify = DOMPurify(window);
    purify.addHook("afterSanitizeAttributes", (node) => {
      const el = node as Element;
      const tag = el.tagName;
      if (tag === "IMG") {
        const src = el.getAttribute("src") ?? "";
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) {
          const url = src.trim();
          const copy = webNow && isWeb(url) ? cachedImage(url) : undefined;
          if (copy) {
            el.setAttribute("src", copy); // (a data: copy: the webview requests nothing)
          } else {
            el.removeAttribute("src"); // (nothing is requested: a box shows instead)
            el.setAttribute("data-blocked", "");
            if (!webNow) {
              if (src) blockedNow++;
            } else if (isWeb(url) && !webNow.tried.has(url)) {
              el.setAttribute("data-pending", "");
              pendingNow.push(url);
            }
          }
        }
      }
      if (tag === "A") {
        const href = el.getAttribute("href") ?? "";
        if (!/^(?:https?:|mailto:|tel:)/i.test(href.trim())) el.removeAttribute("href");
        el.setAttribute("tabindex", "-1");
        if (href) el.setAttribute("title", kbd(t("compose.link.openTip")));
      }
      const st = el.getAttribute?.("style");
      if (st && /url\(|image-set\(|expression\(|@import|javascript:/i.test(st)) el.setAttribute("style", st.replace(/[^;]*(?:url\(|image-set\(|expression\(|@import|javascript:)[^;]*;?/gi, ""));
    });
  }
  blockedNow = 0;
  pendingNow = [];
  webNow = web;
  try {
    const out = purify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
    return { html: out, blocked: blockedNow, pending: pendingNow };
  } finally {
    webNow = undefined;
  }
}

/** A picture without its address becomes the reading pane's box (blockedPicture.ts): the size the mail gave, an icon and the alt text; nothing for a tracking pixel. Not announced, not clickable. */
function boxes(scope: ParentNode): void {
  scope.querySelectorAll("img[data-blocked]").forEach((img) => {
    const size = blockedPictureBox({ width: img.getAttribute("width"), height: img.getAttribute("height"), style: img.getAttribute("style") });
    if (size.hidden) return img.remove();
    const box = document.createElement("span");
    box.className = "hl-bp";
    box.setAttribute("aria-hidden", "true");
    if (img.hasAttribute("data-pending")) box.setAttribute("data-pending", "");
    box.style.width = size.width;
    box.style.height = size.height;
    const ico = document.createElement("span");
    ico.className = "hl-bp-ico";
    box.append(ico);
    const alt = (img.getAttribute("alt") ?? "").trim();
    if (alt) {
      const label = document.createElement("span");
      label.className = "hl-bp-alt";
      label.textContent = alt;
      box.append(label);
    }
    img.replaceWith(box);
  });
}

const SHADOW_CSS = `
:host { display: block; }
.q { font-family: var(--cp-font, Calibri, Carlito, Arial, sans-serif); font-size: var(--cp-size, 11pt); line-height: normal; color: var(--pv-fg, #242424);
  overflow: auto; max-height: 600px; overflow-wrap: anywhere; contain: content; }
.q img { max-width: 100%; height: auto; }
${BLOCKED_PICTURE_CSS}
.hl-bp[data-pending] { opacity: .6; }
.q a { color: var(--pv-link, #0f6cbd); cursor: default; }
.q pre { white-space: pre-wrap; }
`;

const ICON = {
  chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

// ---------------------------------------------------------------- the commands

const findQuote = (state: EditorState): { pos: number; node: PMNode } | null => {
  let found: { pos: number; node: PMNode } | null = null;
  state.doc.forEach((node, offset) => {
    if (!found && node.type.name === NAME) found = { pos: offset, node };
  });
  return found;
};

/** The original becomes ordinary editable text (the way a paste in "Keep source formatting" would bring it): the attribution line, then the quoted blocks. */
async function quoteToText(editor: Editor, base: BaseFont): Promise<void> {
  const { cleanPaste } = await import("./pasteClean");
  const q = findQuote(editor.state);
  if (!q) return;
  const a = q.node.attrs as { kind: string; head: string; html: string };
  const body = cleanPaste(a.html, { mode: "source", tables: Boolean(editor.schema.nodes.table), base }).html;
  const head = `<p>${a.head}</p>`;
  const html = a.kind === "forward" ? head + body : `${head}<blockquote>${body}</blockquote>`;
  editor.chain().focus().insertContentAt({ from: q.pos, to: q.pos + q.node.nodeSize }, html).run();
}

/** Removes the block (one Undo brings it back). */
function removeQuote(editor: Editor): void {
  const q = findQuote(editor.state);
  if (q) editor.chain().focus().deleteRange({ from: q.pos, to: q.pos + q.node.nodeSize }).run();
}

// ---------------------------------------------------------------- the node

export const QuoteBlock = TipNode.create<QuoteOptions>({
  name: NAME,
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addOptions: () => ({ ask: async () => true, base: () => ({ family: "Calibri, Carlito, Arial, sans-serif", size: 11 }), remote: () => false }),
  addAttributes() {
    return {
      kind: { default: "reply", rendered: false, parseHTML: (el: HTMLElement) => (el.getAttribute("data-quote-block") === "forward" ? "forward" : "reply") },
      head: { default: "", rendered: false, parseHTML: (el: HTMLElement) => el.getAttribute("data-quote-head") ?? "" },
      html: { default: "", rendered: false, parseHTML: (el: HTMLElement) => el.getAttribute("data-quote-html") ?? "" },
    };
  },
  parseHTML: () => [{ tag: "div[data-quote-block]" }],
  // what a copy of the block puts on the clipboard: the original as formatted text (it is not pasted back into this editor as a block: transformPasted)
  renderHTML({ node }) {
    const box = document.createElement("div");
    const { html: head } = displayHtml(String(node.attrs.head ?? ""));
    const { html } = displayHtml(String(node.attrs.html ?? ""));
    box.innerHTML = `<div>${head}</div>${node.attrs.kind === "forward" ? `<div>${html}</div>` : `<blockquote style="${QUOTE_STYLE}">${html}</blockquote>`}`;
    return box;
  },
  addProseMirrorPlugins: () => [quoteGuard()],
  addNodeView() {
    const opts = this.options;
    const editor = this.editor;
    return ({ node: first }) => {
      let node = first;
      const dom = document.createElement("div");
      dom.className = "quote-block";
      dom.contentEditable = "false";
      dom.setAttribute("role", "group");
      dom.setAttribute("aria-label", t("compose.quote.region"));
      dom.innerHTML =
        `<div class="quote-head"><div class="quote-attr"></div><div class="quote-tools">` +
        `<button type="button" class="link" data-act="edit"></button>` +
        `<button type="button" class="icon-btn" data-act="toggle" aria-expanded="true">${ICON.chevron}</button>` +
        `<button type="button" class="icon-btn" data-act="remove">${ICON.x}</button>` +
        `</div></div><div class="quote-note"></div><div class="quote-host"></div>`;
      const q = <T extends HTMLElement>(sel: string) => dom.querySelector<T>(sel)!;
      const attr = q(".quote-attr");
      const note = q(".quote-note");
      const edit = q<HTMLButtonElement>('[data-act="edit"]');
      const toggle = q<HTMLButtonElement>('[data-act="toggle"]');
      const remove = q<HTMLButtonElement>('[data-act="remove"]');
      const root = q(".quote-host").attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SHADOW_CSS;
      const scope = document.createElement("div");
      scope.className = "q";
      root.append(style, scope);
      let collapsed = false;

      const labels = () => {
        edit.textContent = t("compose.quote.edit");
        for (const [b, text] of [[remove, t("compose.quote.remove")], [toggle, collapsed ? t("compose.quote.show") : t("compose.quote.hide")]] as const) {
          b.title = text;
          b.setAttribute("aria-label", text);
        }
        toggle.setAttribute("aria-expanded", String(!collapsed));
        dom.classList.toggle("collapsed", collapsed);
      };
      const dark = () => Boolean(dom.closest(".cp-pv.pv-dark"));
      const recolour = () => setDarkRegion(scope, dark(), root);
      // pictures from the web: shown when the reading pane's rule allows them (`opts.remote()`) or the person pressed "Load content" in this quote; the backend fetches them
      // (once per address: `tried`) and the quote is drawn again when they are in
      let loadNow = false;
      let live = true;
      const tried = new Set<string>();
      const fill = (retry = false) => {
        const a = node.attrs as { kind: string; head: string; html: string };
        dom.dataset.kind = a.kind;
        attr.innerHTML = displayHtml(a.head).html;
        const web = loadNow || opts.remote();
        const shown = displayHtml(a.html, web ? { tried } : undefined);
        scope.innerHTML = a.kind === "forward" ? shown.html : `<blockquote style="${QUOTE_STYLE}">${shown.html}</blockquote>`;
        boxes(scope);
        // (the note and its button are rebuilt with the text of the moment: the language can change while the message is open)
        note.replaceChildren();
        if (shown.blocked) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "link";
          more.dataset.act = "load";
          more.textContent = t("reading.body.loadContent");
          note.append(t("compose.quote.remote"), " ", more);
        }
        note.hidden = !shown.blocked;
        if (shown.pending.length) {
          shown.pending.forEach((u) => tried.add(u));
          void loadRemoteImages(shown.pending, retry).then(() => {
            if (live) fill();
          });
        }
        labels();
        recolour();
      };
      fill();

      // the preview surface is a class of the editor's pane (Compose): follow it (the block exists a moment before the pane holds it)
      let watch: MutationObserver | null = null;
      let looks = 0;
      const attach = () => {
        const pane = dom.closest(".cp-pv");
        if (!pane) {
          if (dom.isConnected || ++looks > 60) return; // (not in a composer: nothing to follow)
          requestAnimationFrame(attach);
          return;
        }
        recolour();
        watch = new MutationObserver(recolour);
        watch.observe(pane, { attributes: true, attributeFilter: ["class"] });
      };
      queueMicrotask(attach);

      dom.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest?.("button[data-act]") as HTMLElement | null;
        if (btn) {
          e.preventDefault();
          const act = btn.dataset.act;
          if (act === "toggle") {
            collapsed = !collapsed;
            labels();
          } else if (act === "load") {
            loadNow = true;
            tried.clear();
            fill(true);
          } else if (act === "remove") removeQuote(editor);
          else if (act === "edit") void opts.ask().then((ok) => (ok ? quoteToText(editor, opts.base()) : undefined));
          return;
        }
        // a link of the original: nothing on a plain click, the default browser on Ctrl / Cmd + click
        const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
        if (!a) return;
        e.preventDefault();
        const check = checkLinkUrl(a.getAttribute("href") ?? "");
        if ((e.ctrlKey || e.metaKey) && e.button === 0 && check.ok) void openExternal(check.href).catch(() => undefined);
      });
      dom.addEventListener("auxclick", (e) => {
        if (e.composedPath().some((n) => n instanceof HTMLAnchorElement)) e.preventDefault();
      });

      return {
        dom,
        // the header buttons are the block's own (the editor must not turn a click on them into a selection)
        stopEvent: (e) => Boolean((e.target as HTMLElement | null)?.closest?.(".quote-tools, .quote-note")),
        ignoreMutation: () => true,
        update(n) {
          if (n.type.name !== NAME) return false;
          const same = n.attrs.kind === node.attrs.kind && n.attrs.head === node.attrs.head && n.attrs.html === node.attrs.html;
          node = n;
          if (!same) fill();
          return true;
        },
        destroy() {
          live = false;
          watch?.disconnect();
          setDarkRegion(scope, false, root);
        },
      };
    };
  },
});
