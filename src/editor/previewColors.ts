// The colours of the text on the composer's dark "Preview as recipient" surface. A colour the person picked (font colour, highlight) is stored
// and sent exactly as picked, whatever the preview shows; on the dark surface it is DISPLAYED through the reading pane's own recolouring
// (darkMail.ts: a text colour that would not read on the dark canvas is replaced by a light one of the same hue, a highlight gets its dark
// counterpart), as a decoration of the view only: the document is never changed, so the saved and sent HTML is the same with the preview on or off.

import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { contrast, lightText } from "../darkMail";
import { DARK_CANVAS } from "../mailCanvas";
import { parseRgb, rgbHex } from "./colors";
import { darkHighlight, darkTextColor } from "./darkColors";
import type { PreviewBg } from "../composePreview";

const key = new PluginKey<PreviewBg>("previewColors");

export const PreviewColors = Extension.create({
  name: "previewColors",
  addProseMirrorPlugins() {
    return [
      new Plugin<PreviewBg>({
        key,
        state: { init: () => "light", apply: (tr, v) => (tr.getMeta(key) as PreviewBg | undefined) ?? v },
        props: {
          decorations(state) {
            if (key.getState(state) !== "dark") return null;
            const out: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              // the shading of a table cell goes through the same recolouring as a highlight (the text in it is light, or lightened to read on it)
              if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
                const shade = typeof node.attrs.background === "string" ? parseRgb(darkHighlight(node.attrs.background)) : null;
                if (shade) {
                  const decl = [`background-color:${rgbHex(shade)}`];
                  if (contrast([230, 230, 230], shade) < 4.5) decl.push(`color:${rgbHex(lightText([230, 230, 230], shade, 4.5))}`);
                  out.push(Decoration.node(pos, pos + node.nodeSize, { style: decl.join(";") }));
                }
                return;
              }
              if (!node.isText) return;
              const ts = node.marks.find((m) => m.type.name === "textStyle");
              const fg = typeof ts?.attrs.color === "string" ? ts.attrs.color : "";
              const bg = typeof ts?.attrs.backgroundColor === "string" ? ts.attrs.backgroundColor : "";
              if (!fg && !bg) return;
              const bgRgb = bg ? parseRgb(darkHighlight(bg)) : null;
              const decl: string[] = [];
              if (bg && bgRgb) decl.push(`background-color:${rgbHex(bgRgb)}`);
              if (fg) decl.push(`color:${darkTextColor(fg, bgRgb ?? DARK_CANVAS)}`);
              else if (bgRgb && contrast([230, 230, 230], bgRgb) < 4.5) decl.push(`color:${rgbHex(lightText([230, 230, 230], bgRgb, 4.5))}`);
              if (decl.length) out.push(Decoration.inline(pos, pos + node.nodeSize, { style: decl.join(";") }));
            });
            return DecorationSet.create(state.doc, out);
          },
        },
      }),
    ];
  },
});

/** Shows the picked colours for this preview surface (a view change, not an edit). */
export function setPreviewMode(editor: Editor, mode: PreviewBg): void {
  if (key.getState(editor.state) === mode) return;
  editor.view.dispatch(editor.state.tr.setMeta(key, mode).setMeta("addToHistory", false));
}
