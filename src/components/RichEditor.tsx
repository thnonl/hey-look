import { EditorContent, useEditor } from "@tiptap/react";
import { useRef } from "react";
import { useT } from "../i18n/react";
import { baseFromPrefs } from "../editor/baseFont";
import { docToHtml } from "../editor/emailHtml";
import { baseExtensions } from "../editor/extensions";
import { useKit } from "../editor/kit";
import { FormatBar, type FormatBarApi } from "../editor/FormatBar";
import { editorKeyHandlers } from "../composeKeys";
import { useStore } from "../store";
import { useLinkEditor } from "./LinkPopover";

/**
 * Small rich-text editor (signatures, templates): the user never has to write HTML. It has the extension set and the toolbar of the message
 * body (editor/extensions.ts, editor/FormatBar.tsx, compact variant) and stores the same email HTML the body is sent as (editor/emailHtml.ts).
 */
export function RichEditor(props: RichEditorProps) {
  // the table nodes come in a chunk of their own (editor/kit.ts); the editor is made once they are there
  return useKit() ? <RichEditorBody {...props} /> : <div className="rich" style={{ minHeight: (props.minHeight ?? 140) + 40 }} />;
}

interface RichEditorProps { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; label?: string }

function RichEditorBody({ value, onChange, placeholder, minHeight = 140, label }: RichEditorProps) {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  // a signature is shown in the default font of new messages, as it will look in them
  const base = baseFromPrefs(prefs);
  const baseRef = useRef(base);
  baseRef.current = base;
  const linkRef = useRef<() => void>(() => undefined);
  const barApi = useRef<FormatBarApi>(null);
  const editor = useEditor({
    extensions: baseExtensions({ placeholder: placeholder ?? "", getBase: () => baseRef.current, focusToolbar: () => barApi.current?.focus(), openStyles: () => barApi.current?.openStyles() }),
    // Ctrl/Cmd+K is the link UI here too; AltGr characters never trigger the editor shortcuts
    editorProps: { attributes: { "aria-label": label ?? t("compose.fmt.text") }, handleDOMEvents: editorKeyHandlers(() => linkRef.current()) },
    content: value || "<p></p>",
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : docToHtml(editor.getJSON(), baseRef.current)),
  });
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const link = useLinkEditor(editor, linkBtnRef);
  linkRef.current = link.open;
  return (
    <div className="rich" style={{ "--cp-font": base.family, "--cp-size": `${base.size}pt` } as React.CSSProperties}>
      <div className="rich-bar">
        <FormatBar editor={editor} base={base} variant="compact" apiRef={barApi} host={{ link: { open: () => linkRef.current(), isOpen: link.isOpen, btnRef: linkBtnRef } }} />
        {link.node}
      </div>
      <EditorContent editor={editor} className="rich-body" style={{ minHeight }} />
    </div>
  );
}
