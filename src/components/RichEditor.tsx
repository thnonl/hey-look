import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Italic, Link2, List, ListOrdered, Underline as UIcon } from "lucide-react";
import { useT } from "../i18n/react";

/** Small rich-text editor (signatures, templates): the user never has to write HTML. */
export function RichEditor({ value, onChange, placeholder, minHeight = 140, label }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; label?: string }) {
  const t = useT();
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: placeholder ?? "" })],
    editorProps: { attributes: { "aria-label": label ?? t("compose.fmt.text") } },
    content: value || "<p></p>",
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
  });
  return (
    <div className="rich">
      <div className="rich-bar" role="toolbar" aria-label={t("compose.fmt.toolbar")}>
        <button type="button" className="icon-btn" title={t("compose.fmt.bold")} aria-label={t("compose.fmt.bold")} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></button>
        <button type="button" className="icon-btn" title={t("compose.fmt.italic")} aria-label={t("compose.fmt.italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></button>
        <button type="button" className="icon-btn" title={t("compose.fmt.underline")} aria-label={t("compose.fmt.underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UIcon size={14} /></button>
        <button type="button" className="icon-btn" title={t("compose.fmt.bulleted")} aria-label={t("compose.fmt.bulleted")} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></button>
        <button type="button" className="icon-btn" title={t("compose.fmt.numbered")} aria-label={t("compose.fmt.numbered")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></button>
        <button
          type="button"
          className="icon-btn"
          title={t("compose.fmt.link")}
          aria-label={t("compose.fmt.link")}
          onClick={() => {
            const url = prompt(t("compose.fmt.linkPrompt"));
            if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          }}
        >
          <Link2 size={14} />
        </button>
      </div>
      <EditorContent editor={editor} className="rich-body" style={{ minHeight }} />
    </div>
  );
}
