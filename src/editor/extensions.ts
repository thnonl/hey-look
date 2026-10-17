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
import { HardBreak } from "@tiptap/extension-hard-break";
import { Strike } from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Extension, type AnyExtension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { osNow } from "../platform";
import type { BaseFont } from "./emailHtml";
import { BlockFormat } from "./blockExtension";
import { applyStyle, changeIndent, clearFormatting, setAlignment, stepFontSize, toggleScript } from "./commands";
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

/** Keys of the font and the formatting that are not a mark of their own. `getBase` is the default font of the message (what an unsized run is). */
const FormatKeys = (getBase: () => BaseFont, focusToolbar?: () => void, openStyles?: () => void) =>
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
        "Mod-Alt-1": () => applyStyle(this.editor, "h1"),
        "Mod-Alt-2": () => applyStyle(this.editor, "h2"),
        "Mod-Alt-3": () => applyStyle(this.editor, "h3"),
        // Ctrl+Space is the input-method switch on a Mac (Cmd+Space is Spotlight): Cmd+\ only there
        ...(osNow() === "macos" ? {} : { "Mod-Space": clear }),
      };
    },
  });

export interface BaseExtensionOptions {
  placeholder?: string;
  /** the placeholder is shown in every empty paragraph (the message body) or only in the current one */
  showOnlyCurrent?: boolean;
  /** the default font of the message, read when a font command needs it */
  getBase: () => BaseFont;
  /** Alt+F10: put the focus on the formatting toolbar */
  focusToolbar?: () => void;
  /** Ctrl+Shift+S: open the Styles menu */
  openStyles?: () => void;
}

export function baseExtensions(o: BaseExtensionOptions): AnyExtension[] {
  return [
    // headings 1-3 only (the Styles menu of Outlook); the editor's own Strike / Code shortcuts are replaced above
    StarterKit.configure({ strike: false, code: false, hardBreak: false, heading: { levels: [1, 2, 3] } }),
    LineBreak,
    NoKeyStrike,
    NoKeyCode,
    Sub,
    Sup,
    // font family, size, colour and highlight are attributes of one `textStyle` mark: one <span style> in the HTML
    TextStyleKit.configure({ lineHeight: false }),
    BlockFormat,
    FormatKeys(o.getBase, o.focusToolbar, o.openStyles),
    // paste and drop: the cleaning of Word / Excel / Outlook / Gmail / web HTML, the three paste options, Ctrl+Shift+V (pasteOptions.tsx)
    PasteHandling.configure({ getBase: o.getBase }),
    PreviewColors,
    Placeholder.configure({ placeholder: o.placeholder ?? "", showOnlyCurrent: o.showOnlyCurrent ?? true }),
  ];
}
