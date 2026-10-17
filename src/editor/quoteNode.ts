// The quote block of a reply or forward in the composer (spec-rich-text.md REQ-35, design 4.6): the original message is NOT parsed into the editor's
// schema. It is one atom node (`quoteBlock`, attributes in quoteBlock.ts) shown read-only with its own formatting in a shadow tree (the app's style sheets
// cannot reach into it and its own cannot reach out), and written back to the stored / sent HTML exactly as it was cleaned (emailHtml.ts).
//
//  - Shown: the original goes through DOMPurify again (a draft that came back from the server is not trusted), pictures from the web are NOT requested
//    (the composer never loads them; they stay in the sent HTML), links do nothing on a plain click and open the default browser on Ctrl/Cmd+click.
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
import { setDarkRegion } from "../composePreviewDom";
import { t } from "../i18n";
import { checkLinkUrl } from "../linkUrl";
import { openExternal } from "../open";
import { kbd } from "../platform";
import type { BaseFont } from "./emailHtml";
import { QUOTE_STYLE } from "./quoteBlock";
import { QUOTE_NODE, quoteGuard } from "./quoteGuard";

export interface QuoteOptions {
  /** the confirmation before the original becomes editable text; true = go on */
  ask: () => Promise<boolean>;
  /** the default font of the message (the paste cleaner leaves it out of the text it keeps) */
  base: () => BaseFont;
}

const NAME = QUOTE_NODE;

// ---------------------------------------------------------------- what is shown

const TAGS = "p br div span strong b em i u s strike sub sup a ul ol li h1 h2 h3 h4 h5 h6 blockquote pre code hr img table thead tbody tfoot tr th td caption colgroup col".split(" ");
const ATTRS = "style dir align href src alt title width height border cellpadding cellspacing bgcolor colspan rowspan valign type start value span".split(" ");

let purify: ReturnType<typeof DOMPurify> | null = null;
let blockedNow = 0;

/** The original as it is shown: allow-list again, no picture from the web, no link scheme but http / https / mailto / tel, no `url()` in a style. */
export function displayHtml(html: string): { html: string; blocked: number } {
  if (!purify) {
    purify = DOMPurify(window);
    purify.addHook("afterSanitizeAttributes", (node) => {
      const el = node as Element;
      const tag = el.tagName;
      if (tag === "IMG") {
        const src = el.getAttribute("src") ?? "";
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) {
          if (src) blockedNow++;
          el.removeAttribute("src"); // (nothing is requested: the alt text shows instead)
          el.setAttribute("data-blocked", "");
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
  const out = purify.sanitize(html, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
  return { html: out, blocked: blockedNow };
}

const SHADOW_CSS = `
:host { display: block; }
.q { font-family: var(--cp-font, Calibri, Carlito, Arial, sans-serif); font-size: var(--cp-size, 11pt); line-height: normal; color: var(--pv-fg, #242424);
  overflow: auto; max-height: 600px; overflow-wrap: anywhere; contain: content; }
.q img { max-width: 100%; height: auto; }
.q img[data-blocked] { outline: 1px dashed #9aa0a6; outline-offset: -1px; min-width: 16px; min-height: 16px; color: #6b7280; font-size: 12px; }
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
export async function quoteToText(editor: Editor, base: BaseFont): Promise<void> {
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
export function removeQuote(editor: Editor): void {
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
  addOptions: () => ({ ask: async () => true, base: () => ({ family: "Calibri, Carlito, Arial, sans-serif", size: 11 }) }),
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
      const fill = () => {
        const a = node.attrs as { kind: string; head: string; html: string };
        dom.dataset.kind = a.kind;
        attr.innerHTML = displayHtml(a.head).html;
        const shown = displayHtml(a.html);
        scope.innerHTML = a.kind === "forward" ? shown.html : `<blockquote style="${QUOTE_STYLE}">${shown.html}</blockquote>`;
        note.textContent = shown.blocked ? t("compose.quote.remote") : "";
        note.hidden = !shown.blocked;
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
        stopEvent: (e) => Boolean((e.target as HTMLElement | null)?.closest?.(".quote-tools")),
        ignoreMutation: () => true,
        update(n) {
          if (n.type.name !== NAME) return false;
          const same = n.attrs.kind === node.attrs.kind && n.attrs.head === node.attrs.head && n.attrs.html === node.attrs.html;
          node = n;
          if (!same) fill();
          return true;
        },
        destroy() {
          watch?.disconnect();
          setDarkRegion(scope, false, root);
        },
      };
    };
  },
});
