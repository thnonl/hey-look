import { EditorContent, useEditor } from "@tiptap/react";
import { useRef } from "react";
import { useT } from "../i18n/react";
import { baseFromPrefs } from "../editor/baseFont";
import { docToHtml } from "../editor/emailHtml";
import { baseExtensions } from "../editor/extensions";
import { useKit } from "../editor/kit";
import { FormatBar, type FormatBarApi } from "../editor/FormatBar";
import { insertPictureNodes } from "../editor/insertPictures";
import { nameForMime } from "../editor/messageBody";
import { fitSignaturePicture, initialWidth } from "../editor/signaturePicture";
import { editorKeyHandlers } from "../composeKeys";
import { useStore } from "../store";
import { dataUriBytes, fileToBase64, fmtSize, imageSize, PICTURE_TYPES, resizeImage } from "../util";
import { useLinkEditor } from "./LinkPopover";

/**
 * Small rich-text editor (signatures, templates): the user never has to write HTML. It has the extension set and the toolbar of the message
 * body (editor/extensions.ts, editor/FormatBar.tsx, compact variant) and stores the same email HTML the body is sent as (editor/emailHtml.ts).
 * `pictures`: it takes pictures too (REQ-25): the Picture button adds one from a file, shown 240 px wide at most and limited to 1 MB; in a sent
 * message it is an inline part like a picture of the body.
 */
export function RichEditor(props: RichEditorProps) {
  // the table nodes come in a chunk of their own (editor/kit.ts); the editor is made once they are there
  return useKit() ? <RichEditorBody {...props} /> : <div className="rich" style={{ minHeight: (props.minHeight ?? 140) + 40 }} />;
}

interface RichEditorProps { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; label?: string; pictures?: boolean }

function RichEditorBody({ value, onChange, placeholder, minHeight = 140, label, pictures }: RichEditorProps) {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const showToast = useStore((s) => s.showToast);
  // a signature is shown in the default font of new messages, as it will look in them
  const base = baseFromPrefs(prefs);
  const baseRef = useRef(base);
  baseRef.current = base;
  const linkRef = useRef<() => void>(() => undefined);
  const barApi = useRef<FormatBarApi>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: baseExtensions({ placeholder: placeholder ?? "", getBase: () => baseRef.current, focusToolbar: () => barApi.current?.focus(), openStyles: () => barApi.current?.openStyles(), pictures }),
    // Ctrl/Cmd+K is the link UI here too; AltGr characters never trigger the editor shortcuts
    editorProps: { attributes: { "aria-label": label ?? t("compose.fmt.text") }, handleDOMEvents: editorKeyHandlers(() => linkRef.current()) },
    content: value || "<p></p>",
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : docToHtml(editor.getJSON(), baseRef.current)),
  });
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const link = useLinkEditor(editor, linkBtnRef);
  linkRef.current = link.open;

  /** The picture files the person chose: each is read, made smaller when it weighs more than 1 MB, and put in at the caret. */
  const addPictures = async (files: File[]) => {
    for (const f of files) {
      if (!PICTURE_TYPES.includes(f.type)) {
        showToast(() => t("compose.sigpic.unsupported", { name: f.name }), undefined, "error");
        continue;
      }
      try {
        const dataUrl = `data:${f.type};base64,${await fileToBase64(f)}`;
        const size = await imageSize(dataUrl);
        const fit = await fitSignaturePicture({ dataUrl, mime: f.type, ...size }, { resize: resizeImage, bytes: dataUriBytes });
        if (!fit.ok) {
          showToast(() => t("compose.sigpic.tooBig", { name: f.name }), undefined, "error");
          continue;
        }
        if (fit.resized) showToast(() => t("compose.sigpic.resized", { name: f.name, size: fmtSize(dataUriBytes(fit.dataUrl)) }), undefined, "info");
        insertPictureNodes(editor, [{ src: fit.dataUrl, alt: "", "data-name": nameForMime(f.name, fit.mime), width: initialWidth(fit.w) }]); // (the caret is behind it: the next file goes after it, not over it)
      } catch {
        showToast(() => t("compose.sigpic.unsupported", { name: f.name }), undefined, "error");
      }
    }
  };

  return (
    <div className="rich" style={{ "--cp-font": base.family, "--cp-size": `${base.size}pt` } as React.CSSProperties}>
      <div className="rich-bar">
        <FormatBar
          editor={editor}
          base={base}
          variant="compact"
          apiRef={barApi}
          host={{ link: { open: () => linkRef.current(), isOpen: link.isOpen, btnRef: linkBtnRef }, insertPicture: pictures ? () => fileRef.current?.click() : undefined }}
        />
        {link.node}
        {pictures && (
          <input
            ref={fileRef}
            type="file"
            accept={PICTURE_TYPES.join(",")}
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void addPictures(files);
            }}
          />
        )}
      </div>
      <EditorContent editor={editor} className="rich-body" style={{ minHeight }} />
    </div>
  );
}
