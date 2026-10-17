// The one extension set of every rich-text editor of the app: the message body, the signature editor and the template editor
// (spec-rich-text.md REQ-1). A format that exists in one exists in all of them; the message body adds its own nodes (pictures, the
// signature region) on top of this list.
//
// Keys (REQ-7, composeKeys.ts keeps the Ctrl+K / AltGr / Ctrl+Shift+B rules): Strikethrough and inline code have no key (Ctrl+E is Center
// in Outlook, Ctrl+Shift+S the Styles menu); Subscript is Ctrl+=, Superscript Ctrl+Shift+=; Ctrl+] / Ctrl+[ (and Ctrl+Shift+> / <) grow and shrink
// the font; Ctrl+Space and Ctrl+\ clear the formatting.

import Placeholder from "@tiptap/extension-placeholder";
import { Code } from "@tiptap/extension-code";
import { Strike } from "@tiptap/extension-strike";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Extension, type AnyExtension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { osNow } from "../platform";
import type { BaseFont } from "./emailHtml";
import { clearFormatting, stepFontSize, toggleScript } from "./commands";
import { PreviewColors } from "./previewColors";

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
const FormatKeys = (getBase: () => BaseFont, focusToolbar?: () => void) =>
  Extension.create({
    name: "formatKeys",
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
}

export function baseExtensions(o: BaseExtensionOptions): AnyExtension[] {
  return [
    // headings 1-3 only (the Styles menu of Outlook); the editor's own Strike / Code shortcuts are replaced above
    StarterKit.configure({ strike: false, code: false, heading: { levels: [1, 2, 3] } }),
    NoKeyStrike,
    NoKeyCode,
    Sub,
    Sup,
    // font family, size, colour and highlight are attributes of one `textStyle` mark: one <span style> in the HTML
    TextStyleKit.configure({ lineHeight: false }),
    FormatKeys(o.getBase, o.focusToolbar),
    PreviewColors,
    Placeholder.configure({ placeholder: o.placeholder ?? "", showOnlyCurrent: o.showOnlyCurrent ?? true }),
  ];
}
