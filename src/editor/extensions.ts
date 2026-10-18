// The one extension set of every rich-text editor of the app: the message body, the signature editor and the template editor
// (spec-rich-text.md REQ-1). A format that exists in one exists in all of them; the message body adds its own nodes (pictures, the
// signature region) on top of this list.
//
// Keys (REQ-7, composeKeys.ts keeps the Ctrl+K / AltGr / Ctrl+Shift+B rules): Strikethrough and inline code have no key (Ctrl+E is Center
// in Outlook, Ctrl+Shift+S the Styles menu); Subscript is Ctrl+=, Superscript Ctrl+Shift+=; Ctrl+] / Ctrl+[ (and Ctrl+Shift+> / <) grow and shrink
// the font; Ctrl+Space and Ctrl+\ clear the formatting. Paragraph formats (Outlook's keys): Ctrl+L / E / R / Shift+J align left / centre / right / justify,
// Ctrl+T / Ctrl+Shift+T indent more / less, Ctrl+Shift+S the Styles menu, Ctrl+Shift+N Normal, Ctrl+Alt+1..3 Heading 1-3 (never with AltGr: composeKeys.ts),
// Ctrl+Shift+L / 8 bulleted, Ctrl+Shift+7 numbered list. Paste: Ctrl+V per the paste default, Ctrl+Shift+V text only (pasteOptions.tsx).

import Placeholder from "@tiptap/extension-placeholder";
import { Code } from "@tiptap/extension-code";
import { Link } from "@tiptap/extension-link";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Strike } from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Plugin } from "@tiptap/pm/state";
import { Extension, type AnyExtension, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { t as tNow } from "../i18n";
import { checkLinkUrl } from "../linkUrl";
import { openExternal } from "../open";
import { kbd, osNow } from "../platform";
import type { BaseFont } from "./emailHtml";
import { BlockFormat } from "./blockExtension";
import { applyStyle, changeIndent, clearFormatting, setAlignment, stepFontSize, toggleScript } from "./commands";
import { kitExtensions } from "./kit";
import type { QuoteOptions } from "./quoteNode";
import { PasteHandling } from "./pasteOptions";
import { PreviewColors } from "./previewColors";

/**
 * An empty paragraph is written `<p style="margin:0"><br></p>` so it keeps its height in a recipient's client (emailHtml.ts). Read back, that `<br>` is not a
 * line break: the paragraph is empty again (a paragraph holding a line break would be two lines tall in the editor, one in the sent message).
 */
const LineBreak = HardBreak.extend({
  parseHTML() {
    return [{ tag: "br", getAttrs: (el) => (/^(P|H[1-3])$/.test((el as HTMLElement).parentElement?.tagName ?? "") && (el as HTMLElement).parentElement!.childNodes.length === 1 ? false : null) }];
  },
});
const NoKeyStrike = Strike.extend({ addKeyboardShortcuts: () => ({}) });
const NoKeyCode = Code.extend({ addKeyboardShortcuts: () => ({}) });
// "Mod-=" is the key the browser calls "="; "Mod-Shift-=" arrives as "+" on a US keyboard (the keymap also tries the key code)
const Sub = Subscript.extend({
  addKeyboardShortcuts() {
    return { "Mod-=": () => toggleScript(this.editor, "subscript") };
  },
});
const Sup = Superscript.extend({
  addKeyboardShortcuts() {
    return { "Mod-Shift-=": () => toggleScript(this.editor, "superscript"), "Mod-Shift-+": () => toggleScript(this.editor, "superscript") };
  },
});

/**
 * The link mark of the editor (made with each editor). The editor's own is "inclusive" (text typed at the end of a link goes on being the link): in Word and
 * Outlook the words typed after a link are not part of it, so this one is not. Web, mail and tel addresses only (linkUrl.ts), https for an address typed
 * without a scheme, and no target / rel / class in the editor (the sent HTML has none either).
 */
const editorLink = () =>
  Link.extend({ inclusive: false }).configure({
    openOnClick: false,
    defaultProtocol: "https",
    HTMLAttributes: { target: null, rel: null, class: null, title: kbd(tNow("compose.link.openTip")) }, // (the tooltip is in the language of the moment the editor is made)
    isAllowedUri: (url: string) => checkLinkUrl(url).ok,
  });

/**
 * Ctrl+click (Cmd+click on a Mac) on a link opens it in the default program; a plain click only moves the caret (spec REQ-30, AC-50). The editor's own
 * "open on click" is off: it opened the link in a new window on every click.
 */
const LinkOpen = Extension.create({
  name: "linkOpen",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick: (_view, _pos, e) => {
            if (!(osNow() === "macos" ? e.metaKey : e.ctrlKey) || e.button !== 0) return false;
            const a = (e.target as HTMLElement | null)?.closest?.("a[href]");
            const check = checkLinkUrl(a?.getAttribute("href") ?? "");
            if (!check.ok) return false;
            e.preventDefault();
            void openExternal(check.href).catch(() => undefined);
            return true;
          },
        },
      }),
    ];
  },
});

/** Keys of the font and the formatting that are not a mark of their own. `getBase` is the default font of the message (what an unsized run is). */
const FormatKeys = (getBase: () => BaseFont, focusToolbar?: () => void, openStyles?: () => void, openFind?: (mode: "find" | "replace") => void) =>
  Extension.create({
    name: "formatKeys",
    // before the editor's own Ctrl+Alt+1..3 (heading toggles): the Styles menu and these keys do the same thing
    priority: 1000,
    addKeyboardShortcuts() {
      const grow = () => stepFontSize(this.editor, 1, getBase());
      const shrink = () => stepFontSize(this.editor, -1, getBase());
      const clear = () => clearFormatting(this.editor);
      return {
        "Mod-]": grow,
        "Mod-Shift->": grow,
        "Mod-Shift-.": grow,
        "Mod-[": shrink,
        "Mod-Shift-<": shrink,
        "Mod-Shift-,": shrink,
        "Mod-\\": clear,
        // Alt+F10: the formatting toolbar (Esc brings the focus back to the text with the selection unchanged)
        "Alt-F10": () => (focusToolbar?.(), true),
        // Bulleted list: Outlook's Ctrl+Shift+L (the editor's own Ctrl+Shift+8 stays)
        "Mod-Shift-l": () => this.editor.commands.toggleBulletList(),
        // Alignment (Outlook: Ctrl+L, Ctrl+E, Ctrl+R, Ctrl+Shift+J) and indent (Ctrl+T, Ctrl+Shift+T)
        "Mod-l": () => setAlignment(this.editor, "left"),
        "Mod-e": () => setAlignment(this.editor, "center"),
        "Mod-r": () => setAlignment(this.editor, "right"),
        "Mod-Shift-j": () => setAlignment(this.editor, "justify"),
        "Mod-t": () => changeIndent(this.editor, 1),
        "Mod-Shift-t": () => changeIndent(this.editor, -1),
        // Styles: the menu, Normal, Heading 1-3
        "Mod-Shift-s": () => (openStyles?.(), true),
        "Mod-Shift-n": () => applyStyle(this.editor, "normal"),
        // Find and replace (the message body): Ctrl+F finds, Ctrl+H replaces (on a Mac Cmd+H hides the app: Cmd+Shift+H replaces; Cmd+Option+... keys are the app's, composeKeys.ts)
        ...(openFind ? { "Mod-f": () => (openFind("find"), true), ...(osNow() === "macos" ? { "Mod-Shift-h": () => (openFind("replace"), true) } : { "Mod-h": () => (openFind("replace"), true) }) } : {}),
        // Change case: Shift+F3 goes round lowercase, UPPERCASE, Capitalize Each Word (the code is fetched with the first use)
        "Shift-F3": () => (void import("./changeCase").then((m) => m.changeCase(this.editor, null)), true),
        "Mod-Alt-1": () => applyStyle(this.editor, "h1"),
        "Mod-Alt-2": () => applyStyle(this.editor, "h2"),
        "Mod-Alt-3": () => applyStyle(this.editor, "h3"),
        // Ctrl+Space is the input-method switch on a Mac (Cmd+Space is Spotlight): Cmd+\ only there
        ...(osNow() === "macos" ? {} : { "Mod-Space": clear }),
      };
    },
  });

export interface BaseExtensionOptions {
  /** the text of the empty paragraph; a function is read whenever the editor builds the placeholder (the language can change while the editor is open: `refreshPlaceholder`) */
  placeholder?: string | (() => string);
  /** the placeholder is shown in every empty paragraph (the message body) or only in the current one */
  showOnlyCurrent?: boolean;
  /** the default font of the message, read when a font command needs it */
  getBase: () => BaseFont;
  /** Alt+F10: put the focus on the formatting toolbar */
  focusToolbar?: () => void;
  /** Ctrl+Shift+S: open the Styles menu */
  openStyles?: () => void;
  /** the editor takes pictures (the message body; a signature or template does not) */
  pictures?: boolean;
  /** the message body has the quote block of a reply / forward (quoteNode.ts) */
  quote?: QuoteOptions;
  /** the message body has Find and replace: Ctrl+F / Ctrl+H call this with the panel to open */
  openFind?: (mode: "find" | "replace") => void;
}

export function baseExtensions(o: BaseExtensionOptions): AnyExtension[] {
  return [
    // headings 1-3 only (the Styles menu of Outlook); the editor's own Strike / Code shortcuts are replaced above; the link is editorLink()
    StarterKit.configure({ strike: false, code: false, hardBreak: false, link: false, heading: { levels: [1, 2, 3] } }),
    editorLink(),
    LinkOpen,
    LineBreak,
    NoKeyStrike,
    NoKeyCode,
    Sub,
    Sup,
    // font family, size, colour and highlight are attributes of one `textStyle` mark: one <span style> in the HTML
    TextStyleKit.configure({ lineHeight: false }),
    BlockFormat,
    FormatKeys(o.getBase, o.focusToolbar, o.openStyles, o.openFind),
    // paste and drop: the cleaning of Word / Excel / Outlook / Gmail / web HTML, the three paste options, Ctrl+Shift+V (pasteOptions.tsx)
    PasteHandling.configure({ getBase: o.getBase }),
    PreviewColors,
    // tables and the picture node (a chunk of their own: kit.ts)
    ...kitExtensions({ pictures: o.pictures ?? false, quote: o.quote, find: !!o.openFind }),
    Placeholder.configure({ placeholder: o.placeholder ?? "", showOnlyCurrent: o.showOnlyCurrent ?? true }),
  ];
}

/**
 * The placeholder in the language in use, also in an editor that is open when the language is switched. The Placeholder extension builds its decorations once (in the
 * message body, showOnlyCurrent: false) and again only for a paragraph that changes, so the text its function returned then stays on the paragraphs that are there.
 * This builds the plugin again: its state starts from the document and asks the option function (which reads t()) for every empty paragraph; the other plugins, the
 * document and the undo history are not touched.
 */
export function refreshPlaceholder(editor: Editor | null | undefined): void {
  if (!editor || editor.isDestroyed) return;
  const ext = editor.extensionManager.extensions.find((e) => e.name === "placeholder");
  const make = ext?.config.addProseMirrorPlugins as ((this: unknown) => Plugin[]) | undefined;
  if (!ext || !make) return;
  const plugins = make.call({ name: ext.name, options: ext.options, storage: ext.storage, editor, parent: null });
  editor.unregisterPlugin(PLACEHOLDER_KEY);
  for (const p of plugins) editor.registerPlugin(p);
}
/**
 * Puts the accessible name on the node ProseMirror renders (`aria-label` of the contenteditable). It goes through the editor's props: ProseMirror
 * applies `attributes` itself and takes a plain `setAttribute` back at its next update. Typed text, selection and undo history are not touched.
 */
export function setEditorLabel(editor: Editor | null | undefined, label: string): void {
  if (!editor || editor.isDestroyed) return;
  const props = editor.options.editorProps;
  const attrs = (props?.attributes ?? {}) as Record<string, string>;
  if (attrs["aria-label"] === label) return;
  editor.setOptions({ editorProps: { ...props, attributes: { ...attrs, "aria-label": label } } });
}
const PLACEHOLDER_KEY = "tiptap__placeholder"; // (the key of the plugin of @tiptap/extensions)
