import { listen } from "@tauri-apps/api/event";
import {
  Archive, Calendar, Check, ChevronLeft, ChevronRight, Download, ExternalLink, File, FileCode, FileSpreadsheet, FileText, Film, FolderDown,
  FolderOpen, Image as ImageIcon, ImageOff, KeyRound, MoreHorizontal, Music, Paperclip, Presentation, ShieldAlert, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, AttMeta, errorCode, MessageFull } from "../api";
import { eff } from "../prefs";
import { friendlyError, useStore } from "../store";
import { fmtSize } from "../util";
import riskyExt from "../riskyExt.json";
import { importKeyFromMessage, isKeyAttachment } from "./Pgp";
import { Dropdown } from "./ui";

// ---------------------------------------------------------------- file types

export type FileKind = "pdf" | "doc" | "xls" | "ppt" | "img" | "zip" | "audio" | "video" | "code" | "ics" | "key" | "exe" | "file";

const EXT_KIND: Record<string, FileKind> = {
  pdf: "pdf", doc: "doc", docx: "doc", odt: "doc", rtf: "doc",
  xls: "xls", xlsx: "xls", ods: "xls", csv: "xls",
  ppt: "ppt", pptx: "ppt", odp: "ppt",
  zip: "zip", "7z": "zip", rar: "zip", tar: "zip", gz: "zip", tgz: "zip",
  js: "code", ts: "code", json: "code", xml: "code", html: "code", css: "code", py: "code", rs: "code", sh: "code",
  txt: "code", log: "code", md: "code",
  ics: "ics", asc: "key", gpg: "key", pgp: "key", key: "key",
};
/** Programs, scripts, macro files and disk images: these can run code, so opening them asks first (see Settings → Attachments).
 *  The list is src/riskyExt.json, the same file the Rust side reads, so the file-type icon and the open warning agree. */
export const RISKY_EXT: readonly string[] = riskyExt;

// like the Rust side: trailing dots and blanks do not hide the type ("setup.exe." is "setup.exe")
const ext = (name: string) => {
  const n = name.replace(/[\s. ]+$/, "");
  return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "";
};

export function fileKind(name: string, mime: string): FileKind {
  const e = ext(name);
  if (RISKY_EXT.includes(e)) return "exe";
  if (mime.startsWith("image/")) return "img";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "text/calendar") return "ics";
  if (mime === "application/pgp-keys" || mime === "application/pgp-signature") return "key";
  return EXT_KIND[e] ?? "file";
}

const KIND_LABEL: Partial<Record<FileKind, string>> = { pdf: "PDF", doc: "DOC", xls: "XLS", ppt: "PPT", zip: "ZIP" };

/** "PDF", "JPEG image", "Word document"… for the card's second line. */
export function typeName(name: string, mime: string): string {
  const k = fileKind(name, mime);
  if (KIND_LABEL[k]) return KIND_LABEL[k] as string;
  if (mime.startsWith("image/")) return `${mime.slice(6).toUpperCase().replace("JPG", "JPEG")} image`;
  if (k === "ics") return "Calendar invite";
  if (k === "key") return "Encryption key";
  if (k === "exe") return "Program or script";
  if (k === "code") return ext(name) ? `${ext(name).toUpperCase()} file` : "Text";
  return ext(name) ? `${ext(name).toUpperCase()} file` : "File";
}

function KindIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  const p = { size };
  switch (kind) {
    case "img": return <ImageIcon {...p} />;
    case "audio": return <Music {...p} />;
    case "video": return <Film {...p} />;
    case "code": return <FileCode {...p} />;
    case "zip": return <Archive {...p} />;
    case "xls": return <FileSpreadsheet {...p} />;
    case "ppt": return <Presentation {...p} />;
    case "ics": return <Calendar {...p} />;
    case "key": return <KeyRound {...p} />;
    case "exe": return <ShieldAlert {...p} />;
    case "doc": return <FileText {...p} />;
    default: return <File {...p} />;
  }
}

/** Preview is offered for pictures, PDFs and small text files. */
export function previewable(a: Pick<AttMeta, "name" | "mime" | "size">): "image" | "pdf" | "text" | null {
  const e = ext(a.name);
  if (a.mime.startsWith("image/") && a.size <= 25 * 1024 * 1024 && !["heic", "heif", "tif", "tiff"].includes(e)) return "image";
  if (a.mime === "application/pdf" || e === "pdf") return a.size <= 25 * 1024 * 1024 ? "pdf" : null;
  const textExt = ["txt", "log", "csv", "json", "xml", "md", "eml"];
  if ((a.mime.startsWith("text/") || textExt.includes(e)) && !RISKY_EXT.includes(e) && a.size <= 1024 * 1024) return "text";
  return null;
}

/** base64 payload to bytes (for Blob URLs). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- actions shared by cards and the list

type Status = "idle" | "busy" | "done" | "error";
interface CardState {
  status: Status;
  label?: string;
  error?: string;
  path?: string;
}

/** Ask before running a program/script; returns true when the user chose "Open anyway". */
async function confirmRisky(name: string, sender: string): Promise<"open" | "save" | "cancel"> {
  const choice = await useStore.getState().choose({
    title: `Open “${name}”?`,
    body: `This kind of file can run programs on your computer. Open it only if you trust ${sender || "the sender"} and expected this file.`,
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "save", label: "Save instead" },
      { id: "open", label: "Open anyway", kind: "danger" },
    ],
  });
  return choice === "open" ? "open" : choice === "save" ? "save" : "cancel";
}

/** Open a saved attachment with the default app (temp copy). */
export async function openAttachment(m: Pick<MessageFull, "id" | "fromEmail">, a: AttMeta, onError?: (msg: string) => void): Promise<void> {
  const st = useStore.getState();
  const attempt = async (confirmed: boolean): Promise<void> => {
    try {
      await api.attachmentOpen(m.id, a.index, confirmed);
    } catch (e) {
      if (errorCode(e) === "ATT_RISKY" && st.prefs.warnExecutables) {
        const c = await confirmRisky(a.name, m.fromEmail);
        if (c === "open") return attempt(true);
        if (c === "save") return void (await saveQuick(m, a, () => undefined));
        return;
      }
      const msg = `Couldn’t open ${a.name}: ${friendlyError(e)}`;
      if (onError) onError(msg);
      else st.showToast(msg, undefined, "error", [{ label: "Retry", run: () => void openAttachment(m, a) }]);
    }
  };
  await attempt(false);
}

/** Quick save to the download folder (or the Save as dialog when that is the setting). */
async function saveQuick(m: Pick<MessageFull, "id">, a: AttMeta, onDone: (path: string) => void): Promise<void> {
  const st = useStore.getState();
  if (st.prefs.askWhereToSave) return saveAs(m, a, onDone);
  const paths = await api.saveAttachments(m.id, a.index);
  if (paths[0]) onDone(paths[0]);
}

export async function saveAs(m: Pick<MessageFull, "id">, a: AttMeta, onDone: (path: string) => void): Promise<void> {
  const path = await api.attachmentSaveAs(m.id, a.index);
  if (path) onDone(path);
}

/** Toast after a save, following the "After saving" setting. */
function afterSave(path: string, name: string, m: MessageFull, a: AttMeta) {
  const st = useStore.getState();
  const folder = path.replace(/[\\/][^\\/]*$/, "");
  const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const reveal = { label: "Show in folder", run: () => void api.attachmentReveal(path).catch(() => undefined) };
  const open = { label: "Open", run: () => void openAttachment(m, a) };
  if (st.prefs.afterSave === "reveal") return void api.attachmentReveal(path).catch(() => undefined);
  if (st.prefs.afterSave === "open") return void openAttachment(m, a);
  st.showToast(`Saved ${name} to ${folderName}`, undefined, "success", [open, reveal]);
}

// ---------------------------------------------------------------- card

export function AttachmentCard({ m, a }: { m: MessageFull; a: AttMeta }) {
  const { prefs, showToast, openCompose } = useStore();
  const [st, setSt] = useState<CardState>({ status: "idle" });
  const [preview, setPreview] = useState(false);
  const kind = fileKind(a.name, a.mime);
  const pv = previewable(a);
  const sub = `${typeName(a.name, a.mime)} · ${fmtSize(a.size)}`;
  const saveTo = prefs.downloadDir ? prefs.downloadDir.split(/[\\/]/).filter(Boolean).pop() : "Downloads";

  const run = async (label: string, job: () => Promise<void>) => {
    setSt({ status: "busy", label });
    try {
      await job();
      setSt({ status: "idle" });
    } catch (e) {
      const msg = friendlyError(e);
      setSt({ status: "error", error: msg });
      showToast(`${label.replace(/…$/, "")} failed: ${msg}`, undefined, "error", [{ label: "Retry", run: () => void save(false) }]);
    }
  };

  const save = (askWhere: boolean) =>
    run("Saving…", async () => {
      const done = (path: string) => {
        setSt({ status: "done", path });
        afterSave(path, a.name, m, a);
      };
      if (askWhere) await saveAs(m, a, done);
      else await saveQuick(m, a, done);
    });

  const open = () => {
    setSt((s) => ({ ...s, status: "busy", label: "Opening…" }));
    void openAttachment(m, a, (msg) => setSt({ status: "error", error: msg })).finally(() =>
      setSt((s) => (s.status === "busy" ? { status: "idle" } : s)),
    );
  };

  const attachToNew = async () => {
    try {
      const d = await api.attachmentData(m.id, a.index);
      void openCompose({ accountId: m.accountId, subject: "", attachments: [{ filename: d.name, mime: d.mime, dataBase64: d.dataBase64 }] });
    } catch (e) {
      showToast(`Couldn’t attach ${a.name}: ${friendlyError(e)}`, undefined, "error");
    }
  };

  const isKey = isKeyAttachment(a) && eff(prefs, m.accountId, "pgpImportFromMail") !== "never";
  const menu = [
    ...(isKey ? [{ label: "Import key", onClick: () => void importKeyFromMessage(m, a.index) }, { divider: true }] : []),
    ...(pv ? [{ label: "Preview", hint: "Space", onClick: () => setPreview(true) }] : []),
    { label: "Open", hint: "Enter", onClick: open },
    { divider: true },
    { label: `Save to ${saveTo}`, onClick: () => void save(false) },
    { label: "Save as…", hint: "Ctrl+S", onClick: () => void save(true) },
    { divider: true },
    { label: "Attach to new message", onClick: () => void attachToNew() },
  ];

  const busy = st.status === "busy";
  const acts = (
    <div className="att-acts" onClick={(e) => e.stopPropagation()}>
      {busy ? (
        <button className="icon-btn" disabled aria-label={`${st.label ?? "Working"} ${a.name}`}><span className="spin" /></button>
      ) : st.status === "error" ? (
        <button className="btn small" onClick={() => void save(false)} aria-label={`Retry saving ${a.name}`}>Retry</button>
      ) : st.status === "done" ? (
        <>
          <button className="icon-btn" title="Open" aria-label={`Open ${a.name}`} onClick={open}><ExternalLink size={14} /></button>
          <button className="icon-btn" title="Show in folder" aria-label={`Show ${a.name} in folder`} onClick={() => st.path && void api.attachmentReveal(st.path)}><FolderOpen size={14} /></button>
        </>
      ) : isKey ? (
        <button className="btn small" onClick={() => void importKeyFromMessage(m, a.index)} aria-label={`Import key from ${a.name}`}>Import key</button>
      ) : pv ? (
        <button className="icon-btn" title={`Save to ${saveTo}`} aria-label={`Save ${a.name} to ${saveTo}`} onClick={() => void save(false)}><Download size={14} /></button>
      ) : (
        <button className="icon-btn" title="Open" aria-label={`Open ${a.name}`} onClick={open}><ExternalLink size={14} /></button>
      )}
      <Dropdown className="icon-btn" caret={false} align="right" title={`More actions for ${a.name}`} items={menu}>
        <MoreHorizontal size={15} />
      </Dropdown>
    </div>
  );

  const cls = ["att-card", st.status === "done" ? "done" : "", st.status === "error" ? "error" : ""].join(" ");
  return (
    <div
      className={cls}
      role="listitem"
      tabIndex={0}
      aria-busy={busy || undefined}
      aria-label={`${a.name}, ${sub}`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " " && pv) (e.preventDefault(), setPreview(true));
        else if (e.key === "Enter") (e.preventDefault(), open());
        else if (e.key === "s" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void save(true));
        else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") (e.preventDefault(), (e.currentTarget.querySelector(".dd button") as HTMLButtonElement | null)?.click());
      }}
      onDoubleClick={() => (pv ? setPreview(true) : open())}
      draggable={false}
    >
      {a.mime.startsWith("image/") && kind === "img" ? (
        <span className="ft" data-kind="img" aria-hidden><ImageIcon size={16} /></span>
      ) : (
        <span className="ft" data-kind={kind} aria-hidden>
          {KIND_LABEL[kind] ? <span>{KIND_LABEL[kind]}</span> : <KindIcon kind={kind} />}
        </span>
      )}
      <div className="att-main">
        <span className="att-name" title={a.name}>{a.name}</span>
        <span className="att-sub">
          {st.status === "busy" ? `${st.label === "Opening…" ? "Opening…" : "Saving…"}` : st.status === "error" ? st.error : st.status === "done" ? (
            <><Check size={11} aria-hidden /> Saved to {st.path ? st.path.replace(/[\\/][^\\/]*$/, "").split(/[\\/]/).filter(Boolean).pop() : saveTo}</>
          ) : sub}
        </span>
      </div>
      {acts}
      {busy && <div className="progress indet" role="progressbar" aria-label={`${st.label ?? "Working"} ${a.name}`}><i /></div>}
      {preview && <PreviewDialog m={m} items={[a]} start={0} onClose={() => setPreview(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- strip

/**
 * Attachments of one message. Pictures placed in the body collapse into a chip (unless the user lists them),
 * everything else is a card. Nothing is hidden: unreferenced pictures are cards.
 */
export function AttachmentStrip({ m }: { m: MessageFull }) {
  const { prefs, showToast } = useStore();
  const [listPics, setListPics] = useState(false);
  const [lightbox, setLightbox] = useState<{ idx: number; items: AttMeta[] } | null>(null);
  const [saveAll, setSaveAll] = useState<{ done: number; total: number; jobId: string } | null>(null);
  const pictures = m.attachments.filter((a) => a.inline && a.referenced);
  const cards = m.attachments.filter((a) => !(a.inline && a.referenced) || (listPics && pictures.includes(a)));
  const pictureItems = useMemo(() => pictures.filter((a) => a.mime.startsWith("image/")), [pictures]);
  const cardsTotal = cards.reduce((n, a) => n + a.size, 0);
  const picsTotal = pictures.reduce((n, a) => n + a.size, 0);

  useEffect(() => {
    if (!saveAll) return;
    let off: (() => void) | undefined;
    void listen<{ jobId: string; received: number; total: number; done?: boolean }>("attachment-progress", (e) => {
      if (e.payload.jobId !== saveAll.jobId) return;
      setSaveAll((s) => (s && s.jobId === e.payload.jobId ? { ...s, done: e.payload.received, total: e.payload.total } : s));
    }).then((u) => (off = u));
    return () => off?.();
  }, [saveAll?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSaveAll = async (ask: boolean) => {
    const jobId = crypto.randomUUID();
    setSaveAll({ done: 0, total: m.attachments.length, jobId });
    try {
      const r = await api.attachmentSaveAll(m.id, ask || prefs.askWhereToSave, jobId);
      if (!r) return; // cancelled
      const folder = r.dir.split(/[\\/]/).filter(Boolean).pop() ?? r.dir;
      if (r.failed.length === 0) {
        showToast(`Saved ${r.saved.length} attachment${r.saved.length === 1 ? "" : "s"} to ${folder}`, undefined, "success", [
          { label: "Show in folder", run: () => r.saved[0] && void api.attachmentReveal(r.saved[0]).catch(() => undefined) },
        ]);
      } else {
        const f = r.failed[0];
        showToast(`Saved ${r.saved.length} of ${m.attachments.length}. ${f.name} failed: ${f.error}`, undefined, "error", [{ label: "Retry", run: () => void runSaveAll(ask) }]);
      }
    } catch (e) {
      showToast(`Save all failed: ${friendlyError(e)}`, undefined, "error", [{ label: "Retry", run: () => void runSaveAll(ask) }]);
    } finally {
      setSaveAll(null);
    }
  };

  if (m.attachments.length === 0) return null;

  return (
    <>
      {cards.length > 0 && (
        <div className="att-strip" role="region" aria-label="Attachments">
          <div className="att-strip-head">
            <Paperclip size={14} aria-hidden />
            {saveAll ? (
              <span aria-live="polite">Saving… {saveAll.done} of {saveAll.total} · {fmtSize(cardsTotal)}</span>
            ) : (
              <span><b>{cards.length} attachment{cards.length === 1 ? "" : "s"}</b> · {fmtSize(cardsTotal)}</span>
            )}
            <span className="grow" />
            {cards.length > 1 && !saveAll && (
              <button className="link-btn small" title="Shift-click to choose a folder" onClick={(e) => void runSaveAll(e.shiftKey)}>
                <FolderDown size={13} /> Save all…
              </button>
            )}
          </div>
          {saveAll && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={saveAll.total} aria-valuenow={saveAll.done}><i style={{ width: `${saveAll.total ? (saveAll.done / saveAll.total) * 100 : 0}%` }} /></div>}
          <div className="att-grid" role="list">
            {cards.map((a) => (
              <AttachmentCard key={a.index} m={m} a={a} />
            ))}
          </div>
        </div>
      )}
      {pictures.length > 0 && (
        <div className="att-strip" style={{ marginTop: cards.length ? 8 : 12 }}>
          <span className="att-chip inline-pics" role="group" aria-label="Pictures in message">
            <ImageIcon size={13} aria-hidden />
            <span>{pictures.length} picture{pictures.length === 1 ? "" : "s"} in message</span>
            <span className="muted small">{fmtSize(picsTotal)}</span>
            <Dropdown
              className="icon-btn"
              caret
              title="Pictures in this message"
              items={[
                { label: "Show all pictures", disabled: pictureItems.length === 0, onClick: () => setLightbox({ idx: 0, items: pictureItems }) },
                { label: "Save all pictures", onClick: () => void (async () => {
                  let n = 0;
                  for (const p of pictures) {
                    try {
                      await api.saveAttachments(m.id, p.index);
                      n++;
                    } catch {
                      /* reported below */
                    }
                  }
                  showToast(`Saved ${n} of ${pictures.length} pictures`, undefined, n === pictures.length ? "success" : "error");
                })() },
                { divider: true },
                { label: listPics ? "Hide pictures as attachments" : "List them as attachments", onClick: () => setListPics((v) => !v) },
              ]}
            >
              <MoreHorizontal size={13} />
            </Dropdown>
          </span>
          {listPics && <span className="muted small"> · Listed below as attachments</span>}
        </div>
      )}
      {lightbox && (
        <Lightbox
          items={lightbox.items.map((a) => ({ key: `att:${a.index}`, name: a.name, size: a.size, load: () => api.attachmentData(m.id, a.index).then((d) => `data:${d.mime};base64,${d.dataBase64}`) }))}
          index={lightbox.idx}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((l) => (l ? { ...l, idx: i } : l))}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- preview

interface PvLoaded {
  url: string;
  text?: string;
  error?: string;
}

/** Modal preview of attachments (pictures, PDF, small text), with ← → between previewable items. */
export function PreviewDialog({ m, items, start, onClose }: { m: MessageFull; items: AttMeta[]; start: number; onClose: () => void }) {
  const list = items.filter((a) => previewable(a));
  const [i, setI] = useState(Math.max(0, Math.min(start, list.length - 1)));
  const [data, setData] = useState<PvLoaded | null>(null);
  const cur = list[i];
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cur) return;
    let live = true;
    setData(null);
    const kind = previewable(cur);
    void api
      .attachmentData(m.id, cur.index)
      .then((d) => {
        if (!live) return;
        if (kind === "text") {
          const bytes = b64ToBytes(d.dataBase64);
          setData({ url: "", text: new TextDecoder("utf-8").decode(bytes) });
          return;
        }
        if (kind === "pdf") {
          const url = URL.createObjectURL(new Blob([b64ToBytes(d.dataBase64) as BlobPart], { type: "application/pdf" }));
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setData({ url });
          return;
        }
        setData({ url: `data:${d.mime};base64,${d.dataBase64}` });
      })
      .catch((e) => live && setData({ url: "", error: friendlyError(e) }));
    return () => {
      live = false;
    };
  }, [cur?.index, m.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  useEffect(() => {
    // capture phase + stopPropagation: Escape and the arrows belong to this preview, not to the mail shortcuts behind it
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      else if (e.key === "ArrowRight") setI((x) => Math.min(list.length - 1, x + 1));
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [list.length, onClose]);

  const [zoom, setZoom] = useState<"fit" | 1 | 2>("fit");
  if (!cur) return null;
  const kind = previewable(cur);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal pv-modal" role="dialog" aria-modal="true" aria-label={`Preview ${cur.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="pv-head">
          <b className="pv-name ellipsis">{cur.name}</b>
          {list.length > 1 && <span className="muted small">{i + 1} of {list.length}</span>}
          {kind === "image" && (
            <span className="pv-zoom">
              <button className="icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => (z === 2 ? 1 : "fit"))}><ZoomOut size={15} /></button>
              <button className="link-btn small" onClick={() => setZoom("fit")}>{zoom === "fit" ? "Fit" : `${zoom * 100}%`}</button>
              <button className="icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => (z === "fit" ? 1 : 2))}><ZoomIn size={15} /></button>
            </span>
          )}
          <button className="btn small" onClick={() => void openAttachment(m, cur)}><ExternalLink size={13} /> Open</button>
          <button className="btn small" onClick={() => void saveAs(m, cur, () => undefined)}><Download size={13} /> Save as…</button>
          <button className="icon-btn" aria-label="Close preview" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="pv-stage">
          {list.length > 1 && (
            <>
              <button className="pv-nav prev" aria-label="Previous attachment" disabled={i === 0} onClick={() => setI((x) => x - 1)}><ChevronLeft size={18} /></button>
              <button className="pv-nav next" aria-label="Next attachment" disabled={i >= list.length - 1} onClick={() => setI((x) => x + 1)}><ChevronRight size={18} /></button>
            </>
          )}
          {!data ? (
            <div className="pv-msg"><span className="spin" /> Loading…</div>
          ) : data.error ? (
            <div className="pv-msg"><ImageOff size={28} /><div>Couldn’t show this file. {data.error}</div></div>
          ) : kind === "text" ? (
            <pre className="pv-text">{data.text}</pre>
          ) : kind === "pdf" ? (
            <iframe title={cur.name} src={data.url} sandbox="allow-same-origin allow-scripts" />
          ) : (
            <img
              src={data.url}
              alt={cur.name}
              style={zoom === "fit" ? undefined : { maxWidth: "none", maxHeight: "none", width: `${zoom * 100}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- lightbox (pictures)

export interface LbItem {
  key: string;
  name: string;
  size?: number;
  /** resolves to a data: URI (or uses `src` when it is already one) */
  load: () => Promise<string>;
}

/** Full-window picture viewer. ← → move, Esc closes, + − zoom, 0 fits. */
export function Lightbox({ items, index, onClose, onIndex }: { items: LbItem[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const cur = items[index];
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0); // 0 = fit
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!cur) return;
    let live = true;
    setSrc(null);
    setDims(null);
    void cur.load().then((s) => live && setSrc(s)).catch(() => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    closeRef.current?.focus();
    // capture phase + stopPropagation: Escape closes only the lightbox and does not clear the open message behind it
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, (z || 1) * 1.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, (z || 1) / 1.25));
      else if (e.key === "0") setZoom(0);
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items.length, onClose, onIndex]);

  if (!cur) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Picture ${cur.name}`}>
      <div className="lb-bar">
        <b className="ellipsis" style={{ minWidth: 0 }}>{cur.name}</b>
        <span className="muted small">{index + 1} of {items.length}{cur.size ? ` · ${fmtSize(cur.size)}` : ""}{dims ? ` · ${dims.w} × ${dims.h}` : ""}</span>
        <span className="grow" style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, (z || 1) / 1.25))}><ZoomOut size={16} /></button>
        <button className="link-btn small" onClick={() => setZoom(0)}>{zoom ? `${Math.round(zoom * 100)}%` : "Fit"}</button>
        <button className="icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, (z || 1) * 1.25))}><ZoomIn size={16} /></button>
        <button ref={closeRef} className="icon-btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="lb-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {index > 0 && <button className="lb-nav prev" aria-label="Previous picture" onClick={() => onIndex(index - 1)}><ChevronLeft size={20} /></button>}
        {index < items.length - 1 && <button className="lb-nav next" aria-label="Next picture" onClick={() => onIndex(index + 1)}><ChevronRight size={20} /></button>}
        {src === null ? (
          <span className="spin" aria-label="Loading picture" />
        ) : src === "" ? (
          <div className="pv-msg"><ImageOff size={28} /> Couldn’t load this picture.</div>
        ) : (
          <img
            src={src}
            alt={cur.name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={zoom ? { maxWidth: "none", maxHeight: "none", width: `${zoom * 100}%` } : undefined}
          />
        )}
      </div>
    </div>
  );
}
