import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Italic, Link2, List, ListOrdered, Underline as UIcon } from "lucide-react";

/** Small rich-text editor (signatures, templates): the user never has to write HTML. */
export function RichEditor({ value, onChange, placeholder, minHeight = 140, label }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; label?: string }) {
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: placeholder ?? "" })],
    editorProps: { attributes: { "aria-label": label ?? "Text" } },
    content: value || "<p></p>",
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
  });
  return (
    <div className="rich">
      <div className="rich-bar" role="toolbar" aria-label="Formatting">
        <button type="button" className="icon-btn" title="Bold" aria-label="Bold" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></button>
        <button type="button" className="icon-btn" title="Italic" aria-label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></button>
        <button type="button" className="icon-btn" title="Underline" aria-label="Underline" onClick={() => editor?.chain().focus().toggleUnderline().run()}><UIcon size={14} /></button>
        <button type="button" className="icon-btn" title="Bulleted list" aria-label="Bulleted list" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></button>
        <button type="button" className="icon-btn" title="Numbered list" aria-label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></button>
        <button
          type="button"
          className="icon-btn"
          title="Link"
          aria-label="Link"
          onClick={() => {
            const url = prompt("Link URL");
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
