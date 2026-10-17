import { guardFrame } from "../contextGuard";
import { listen } from "@tauri-apps/api/event";
import {
  Archive, Calendar, Check, ChevronLeft, ChevronRight, Download, ExternalLink, File, FileCode, FileSpreadsheet, FileText, Film, FolderDown,
  FolderOpen, Image as ImageIcon, ImageOff, KeyRound, MoreHorizontal, Music, Paperclip, Presentation, ShieldAlert, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, AttMeta, errorCode, MessageFull } from "../api";
import { t, type Key } from "../i18n";
import { useT } from "../i18n/react";
import { eff } from "../prefs";
import { denyIfConfidential, imageLock } from "../protect";
import { friendlyError, useStore } from "../store";
import { fmtSize } from "../util";
import riskyExt from "../riskyExt.json";
import { kbd, osNow } from "../platform";
import { pdfPreview } from "../pdfFrame";
import { importKeyFromMessage, isKeyAttachment } from "./Pgp";
import { Dropdown, FOCUSABLE } from "./ui";

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
  if (mime.startsWith("image/")) return t("reading.att.typeImage", { type: mime.slice(6).toUpperCase().replace("JPG", "JPEG") });
  if (k === "ics") return t("reading.att.typeCalendar");
  if (k === "key") return t("reading.att.typeKey");
  if (k === "exe") return t("reading.att.typeProgram");
  if (k === "code") return ext(name) ? t("reading.att.typeExt", { ext: ext(name).toUpperCase() }) : t("reading.att.typeText");
  return ext(name) ? t("reading.att.typeExt", { ext: ext(name).toUpperCase() }) : t("reading.att.typeFile");
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

/**
 * Preview is offered for pictures, PDFs and small text files. A PDF is shown by the browser's own viewer, whose Save / Print /
 * right-click menu no lock of ours reaches, so confidential mail has no PDF preview (pictures and text are drawn by the app).
 */
export function previewable(a: Pick<AttMeta, "name" | "mime" | "size">, confidential = false): "image" | "pdf" | "text" | null {
  const e = ext(a.name);
  if (a.mime.startsWith("image/") && a.size <= 25 * 1024 * 1024 && !["heic", "heif", "tif", "tiff"].includes(e)) return "image";
  // WebKitGTK has no PDF viewer inside the page: on Linux a PDF opens with the default app instead; a confidential message has no preview
  if (a.mime === "application/pdf" || e === "pdf") return a.size <= 25 * 1024 * 1024 && osNow() !== "linux" && !confidential ? "pdf" : null;
  const textExt = ["txt", "log", "csv", "json", "xml", "md", "eml"];
  if ((a.mime.startsWith("text/") || textExt.includes(e)) && !RISKY_EXT.includes(e) && a.size <= 1024 * 1024) return "text";
  return null;
}

const noCopy = (e: { preventDefault: () => void }) => e.preventDefault();

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
  label?: "saving" | "opening";
  error?: string;
  path?: string;
}

/** Ask before running a program/script; returns true when the user chose "Open anyway". */
async function confirmRisky(name: string, sender: string): Promise<"open" | "save" | "cancel"> {
  const choice = await useStore.getState().choose({
    title: t("reading.att.riskyTitle", { name }),
    body: t("reading.att.riskyBody", { sender: sender || t("reading.att.theSender") }),
    choices: [
      { id: "cancel", label: t("common.cancel") },
      { id: "save", label: t("reading.att.saveInstead") },
      { id: "open", label: t("reading.att.openAnyway"), kind: "danger" },
    ],
  });
  return choice === "open" ? "open" : choice === "save" ? "save" : "cancel";
}

/** Hooks of a caller that shows progress (the attachment card). */
interface OpenHooks {
  onError?: (msg: string) => void;
  /** a question is shown (risky file): the card is not "opening" while it waits, nor after Cancel */
  onAsk?: () => void;
  /** the answer was "Open anyway": the open is running again */
  onResume?: () => void;
  /** "Save instead" saved the file here */
  onSaved?: (path: string) => void;
}

/** Open a saved attachment with the default app (temp copy). */
export async function openAttachment(m: Pick<MessageFull, "id" | "fromEmail">, a: AttMeta, hooks: OpenHooks | ((msg: string) => void) = {}): Promise<void> {
  const h: OpenHooks = typeof hooks === "function" ? { onError: hooks } : hooks;
  const st = useStore.getState();
  const fail = (key: Key, e: unknown, retry: () => void) => {
    const msg = () => t(key, { name: a.name, error: friendlyError(e) });
    if (h.onError) h.onError(msg()); // (a caller that shows it itself gets the text as it is now)
    else st.showToast(msg, undefined, "error", [{ label: () => t("common.retry"), run: retry }]);
  };
  const attempt = async (confirmed: boolean): Promise<void> => {
    try {
      denyIfConfidential(m.id);
      await api.attachmentOpen(m.id, a.index, confirmed);
    } catch (e) {
      if (errorCode(e) === "ATT_RISKY" && st.prefs.warnExecutables) {
        h.onAsk?.();
        const c = await confirmRisky(a.name, m.fromEmail);
        if (c === "open") {
          h.onResume?.();
          return attempt(true);
        }
        if (c === "save") {
          try {
            await saveQuick(m, a, (path) => {
              h.onSaved?.(path);
              savedToast(path, a.name);
            });
          } catch (er) {
            fail("reading.att.couldntSave", er, () => void openAttachment(m, a));
          }
        }
        return;
      }
      fail("reading.att.couldntOpen", e, () => void openAttachment(m, a));
    }
  };
  await attempt(false);
}

/** Quick save to the download folder (or the Save as dialog when that is the setting). */
async function saveQuick(m: Pick<MessageFull, "id">, a: AttMeta, onDone: (path: string) => void): Promise<void> {
  denyIfConfidential(m.id);
  const st = useStore.getState();
  if (st.prefs.askWhereToSave) return saveAs(m, a, onDone);
  const paths = await api.saveAttachments(m.id, a.index);
  if (paths[0]) onDone(paths[0]);
}

export async function saveAs(m: Pick<MessageFull, "id">, a: AttMeta, onDone: (path: string) => void): Promise<void> {
  denyIfConfidential(m.id);
  const path = await api.attachmentSaveAs(m.id, a.index);
  if (path) onDone(path);
}

const folderName = (path: string) => {
  const folder = path.replace(/[\/][^\/]*$/, "");
  return folder.split(/[\/]/).filter(Boolean).pop() ?? folder;
};

/** Plain "saved" toast (no automatic open: used after a risky file was saved instead of opened, and by the preview's Save as). */
function savedToast(path: string, name: string) {
  useStore.getState().showToast(() => t("reading.att.savedTo", { name, folder: folderName(path) }), undefined, "success", [{ label: () => t("reading.att.showInFolder"), run: () => void api.attachmentReveal(path).catch(() => undefined) }]);
}

/** Toast after a save, following the "After saving" setting. */
function afterSave(path: string, name: string, m: Pick<MessageFull, "id" | "fromEmail">, a: AttMeta) {
  const st = useStore.getState();
  const reveal = { label: t("reading.att.showInFolder"), run: () => void api.attachmentReveal(path).catch(() => undefined) };
  const open = { label: t("reading.att.open"), run: () => void openAttachment(m, a) };
  if (st.prefs.afterSave === "reveal") return void api.attachmentReveal(path).catch(() => undefined);
  if (st.prefs.afterSave === "open") return void openAttachment(m, a);
  st.showToast(() => t("reading.att.savedTo", { name, folder: folderName(path) }), undefined, "success", [open, reveal]);
}

// ---------------------------------------------------------------- card

export function AttachmentCard({ m, a }: { m: MessageFull; a: AttMeta }) {
  const t = useT();
  const { prefs, showToast, openCompose } = useStore();
  const [st, setSt] = useState<CardState>({ status: "idle" });
  const [preview, setPreview] = useState(false);
  const conf = !!m.confidential; // confidential mail: preview inside the app only, nothing leaves it
  const deny = () => showToast(t("reading.att.confidentialDeny"), undefined, "info");
  const kind = fileKind(a.name, a.mime);
  const pv = previewable(a, conf);
  const sub = conf && !pv ? t("reading.att.cantPreview") : `${typeName(a.name, a.mime)} · ${fmtSize(a.size)}`;
  const saveTo = (prefs.downloadDir ? prefs.downloadDir.split(/[\\/]/).filter(Boolean).pop() : undefined) ?? t("reading.att.downloads");

  const run = async (label: "saving" | "opening", job: () => Promise<void>) => {
    setSt({ status: "busy", label });
    const end = useStore.getState().beginTransfer(); // (the support reminder waits while a file is being saved)
    try {
      await job();
      setSt({ status: "idle" });
    } catch (e) {
      const msg = friendlyError(e);
      setSt({ status: "error", error: msg });
      showToast(() => t("reading.att.saveFailed", { error: friendlyError(e) }), undefined, "error", [{ label: () => t("common.retry"), run: () => void save(false) }]);
    } finally {
      end();
    }
  };

  const save = (askWhere: boolean) =>
    conf ? deny() : run("saving", async () => {
      const done = (path: string) => {
        setSt({ status: "done", path });
        afterSave(path, a.name, m, a);
      };
      if (askWhere) await saveAs(m, a, done);
      else await saveQuick(m, a, done);
    });

  const open = () => {
    if (conf) return pv ? setPreview(true) : deny();
    setSt((s) => ({ ...s, status: "busy", label: "opening" }));
    const end = useStore.getState().beginTransfer();
    void openAttachment(m, a, {
      onError: (msg) => setSt({ status: "error", error: msg }),
      onAsk: () => setSt({ status: "idle" }),
      onResume: () => setSt((s) => ({ ...s, status: "busy", label: "opening" })),
      onSaved: (path) => setSt({ status: "done", path }),
    }).finally(() => {
      end();
      setSt((s) => (s.status === "busy" ? { status: "idle" } : s));
    });
  };

  const attachToNew = async () => {
    if (conf) return deny();
    try {
      const d = await api.attachmentData(m.id, a.index);
      void openCompose({ accountId: m.accountId, subject: "", attachments: [{ filename: d.name, mime: d.mime, dataBase64: d.dataBase64 }] });
    } catch (e) {
      showToast(() => t("reading.att.couldntAttach", { name: a.name, error: friendlyError(e) }), undefined, "error");
    }
  };

  const isKey = isKeyAttachment(a) && eff(prefs, m.accountId, "pgpImportFromMail") !== "never";
  const menu = conf ? (pv ? [{ label: t("reading.att.preview"), hint: "Space", onClick: () => setPreview(true) }] : []) : [ // i18n-ok: key name
    ...(isKey ? [{ label: t("reading.att.importKey"), onClick: () => void importKeyFromMessage(m, a.index) }, { divider: true }] : []),
    ...(pv ? [{ label: t("reading.att.preview"), hint: "Space", onClick: () => setPreview(true) }] : []), // i18n-ok: key name
    { label: t("reading.att.open"), hint: "Enter", onClick: open }, // i18n-ok: key name
    { divider: true },
    { label: t("reading.att.saveToFolder", { folder: saveTo }), onClick: () => void save(false) },
    { label: t("reading.att.saveAs"), hint: kbd("Ctrl+S"), onClick: () => void save(true) },
    { divider: true },
    { label: t("reading.att.attachToNew"), onClick: () => void attachToNew() },
  ];

  const busy = st.status === "busy";
  const busyLabel = (name: string) => t(st.label === "opening" ? "reading.att.ariaOpening" : "reading.att.ariaSaving", { name });
  const acts = (
    <div className="att-acts" onClick={(e) => e.stopPropagation()}>
      {conf ? (
        pv ? <button className="icon-btn" title={t("reading.att.preview")} aria-label={t("reading.att.previewName", { name: a.name })} onClick={() => setPreview(true)}><ExternalLink size={14} /></button> : null
      ) : busy ? (
        <button className="icon-btn" disabled aria-label={busyLabel(a.name)}><span className="spin" /></button>
      ) : st.status === "error" ? (
        <button className="btn small" onClick={() => void save(false)} aria-label={t("reading.att.retrySaving", { name: a.name })}>{t("common.retry")}</button>
      ) : st.status === "done" ? (
        <>
          <button className="icon-btn" title={t("reading.att.open")} aria-label={t("reading.att.openName", { name: a.name })} onClick={open}><ExternalLink size={14} /></button>
          <button className="icon-btn" title={t("reading.att.showInFolder")} aria-label={t("reading.att.showNameInFolder", { name: a.name })} onClick={() => st.path && void api.attachmentReveal(st.path)}><FolderOpen size={14} /></button>
        </>
      ) : isKey ? (
        <button className="btn small" onClick={() => void importKeyFromMessage(m, a.index)} aria-label={t("reading.att.importKeyFrom", { name: a.name })}>{t("reading.att.importKey")}</button>
      ) : pv ? (
        <button className="icon-btn" title={t("reading.att.saveToFolder", { folder: saveTo })} aria-label={t("reading.att.saveNameTo", { name: a.name, folder: saveTo })} onClick={() => void save(false)}><Download size={14} /></button>
      ) : (
        <button className="icon-btn" title={t("reading.att.open")} aria-label={t("reading.att.openName", { name: a.name })} onClick={open}><ExternalLink size={14} /></button>
      )}
      {menu.length > 0 && (
        <Dropdown className="icon-btn" caret={false} align="right" title={t("reading.att.moreFor", { name: a.name })} items={menu}>
          <MoreHorizontal size={15} />
        </Dropdown>
      )}
    </div>
  );

  const cls = ["att-card", st.status === "done" ? "done" : "", st.status === "error" ? "error" : ""].join(" ");
  return (
    <div
      className={cls}
      role="listitem"
      tabIndex={0}
      aria-busy={busy || undefined}
      aria-label={t("reading.att.cardLabel", { name: a.name, sub })}
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
          {st.status === "busy" ? (st.label === "opening" ? t("reading.att.opening") : t("reading.att.saving")) : st.status === "error" ? st.error : st.status === "done" ? (
            <><Check size={11} aria-hidden /> {t("reading.att.statusSavedTo", { folder: st.path ? st.path.replace(/[\\/][^\\/]*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? saveTo : saveTo })}</>
          ) : sub}
        </span>
      </div>
      {acts}
      {busy && <div className="progress indet" role="progressbar" aria-label={busyLabel(a.name)}><i /></div>}
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
  const t = useT();
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
    if (m.confidential) return showToast(t("reading.strip.confSave"), undefined, "info");
    const jobId = crypto.randomUUID();
    setSaveAll({ done: 0, total: m.attachments.length, jobId });
    const end = useStore.getState().beginTransfer();
    try {
      const r = await api.attachmentSaveAll(m.id, ask || prefs.askWhereToSave, jobId);
      if (!r) return; // cancelled
      const folder = r.dir.split(/[\\/]/).filter(Boolean).pop() ?? r.dir;
      if (r.failed.length === 0) {
        showToast(() => t("reading.strip.savedMany", { n: r.saved.length, folder }), undefined, "success", [
          { label: () => t("reading.att.showInFolder"), run: () => r.saved[0] && void api.attachmentReveal(r.saved[0]).catch(() => undefined) },
        ]);
      } else {
        const f = r.failed[0];
        showToast(() => t("reading.strip.savedPartial", { n: r.saved.length, total: m.attachments.length, name: f.name, error: f.error }), undefined, "error", [{ label: () => t("common.retry"), run: () => void runSaveAll(ask) }]);
      }
    } catch (e) {
      showToast(() => t("reading.strip.saveAllFailed", { error: friendlyError(e) }), undefined, "error", [{ label: () => t("common.retry"), run: () => void runSaveAll(ask) }]);
    } finally {
      end();
      setSaveAll(null);
    }
  };

  if (m.attachments.length === 0) return null;

  return (
    <>
      {cards.length > 0 && (
        <div className="att-strip" role="region" aria-label={t("reading.strip.label")}>
          <div className="att-strip-head">
            <Paperclip size={14} aria-hidden />
            {saveAll ? (
              <span aria-live="polite">{t("reading.strip.saving", { done: saveAll.done, total: saveAll.total, size: fmtSize(cardsTotal) })}</span>
            ) : (
              <span><b>{t("reading.strip.count", { n: cards.length })}</b> · {fmtSize(cardsTotal)}</span>
            )}
            <span className="grow" />
            {cards.length > 1 && !saveAll && !m.confidential && (
              <button className="link-btn small" title={t("reading.strip.shiftTip")} onClick={(e) => void runSaveAll(e.shiftKey)}>
                <FolderDown size={13} /> {t("reading.strip.saveAll")}
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
          <span className="att-chip inline-pics" role="group" aria-label={t("reading.strip.picsLabel")}>
            <ImageIcon size={13} aria-hidden />
            <span>{t("reading.strip.picsCount", { n: pictures.length })}</span>
            <span className="muted small">{fmtSize(picsTotal)}</span>
            <Dropdown
              className="icon-btn"
              caret
              title={t("reading.strip.picsMenu")}
              items={[
                { label: t("reading.strip.showPics"), disabled: pictureItems.length === 0, onClick: () => setLightbox({ idx: 0, items: pictureItems }) },
                { label: t("reading.strip.savePics"), disabled: !!m.confidential, onClick: () => void (async () => {
                  let n = 0;
                  for (const p of pictures) {
                    try {
                      await api.saveAttachments(m.id, p.index);
                      n++;
                    } catch {
                      /* reported below */
                    }
                  }
                  showToast(() => t("reading.strip.picsSaved", { n, total: pictures.length }), undefined, n === pictures.length ? "success" : "error");
                })() },
                { divider: true },
                { label: listPics ? t("reading.strip.hidePics") : t("reading.strip.listPics"), onClick: () => setListPics((v) => !v) },
              ]}
            >
              <MoreHorizontal size={13} />
            </Dropdown>
          </span>
          {listPics && <span className="muted small"> · {t("reading.strip.listedBelow")}</span>}
        </div>
      )}
      {lightbox && (
        <Lightbox
          items={lightbox.items.map((a) => ({ key: `att:${a.index}`, name: a.name, size: a.size, load: () => api.attachmentData(m.id, a.index).then((d) => `data:${d.mime};base64,${d.dataBase64}`) }))}
          index={lightbox.idx}
          confidential={!!m.confidential}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((l) => (l ? { ...l, idx: i } : l))}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- preview

/**
 * What both dialogs of this file share. They are drawn through a portal on <body>, not where the message is: a message of the reading pane sits in
 * a `position: sticky` block, and a sticky block is a stacking context, so a dialog inside it was painted UNDER the Reply row and the head of every
 * later message of the conversation (and the picture viewer, a child of the sticky message body, was sticky itself instead of fixed). On <body> the
 * dialog's own z-index counts against the whole window. A portal moves the DOM only: React events still bubble to the card / message that opened
 * it, and the theme variables are on :root, so nothing else changes.
 *
 * The focus goes into the dialog when it opens, Tab and Shift+Tab stay inside it, and it goes back to what opened the dialog when it closes.
 * `first` names the control that takes the focus (default: the dialog itself).
 */
function useDialogFocus<T extends HTMLElement>(first?: () => HTMLElement | null) {
  const box = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (first?.() ?? box.current)?.focus({ preventScroll: true });
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current || !box.current.contains(e.target as Node)) return;
    const list = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
    if (!list.length) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === list[0] || active === box.current)) (e.preventDefault(), list[list.length - 1].focus());
    else if (!e.shiftKey && active === list[list.length - 1]) (e.preventDefault(), list[0].focus());
  };
  return { box, trap };
}

interface PvLoaded {
  url: string;
  text?: string;
  error?: string;
  /** the bytes of a ".pdf" are not a PDF: nothing is drawn (pdfFrame.ts) */
  notPdf?: boolean;
  /** sandbox of the PDF frame, undefined = none (pdfFrame.ts says why) */
  sandbox?: string;
}

/** Modal preview of attachments (pictures, PDF, small text), with ← → between previewable items. */
export function PreviewDialog({ m, items, start, onClose }: { m: MessageFull; items: AttMeta[]; start: number; onClose: () => void }) {
  const t = useT();
  const list = items.filter((a) => previewable(a, !!m.confidential));
  const [i, setI] = useState(Math.max(0, Math.min(start, list.length - 1)));
  const [data, setData] = useState<PvLoaded | null>(null);
  const cur = list[i];
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cur) return;
    let live = true;
    setData(null);
    const kind = previewable(cur, !!m.confidential);
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
          // only bytes that start with %PDF- get a frame, typed application/pdf and, on Chromium, without a sandbox (see pdfFrame.ts)
          const pdf = pdfPreview(b64ToBytes(d.dataBase64), navigator.userAgent);
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = null;
          if (!pdf.ok) {
            setData({ url: "", notPdf: true });
            return;
          }
          const url = URL.createObjectURL(pdf.blob);
          urlRef.current = url;
          setData({ url, sandbox: pdf.sandbox ?? undefined });
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
  const lock = imageLock(!!m.confidential);
  const { box, trap } = useDialogFocus<HTMLDivElement>();
  if (!cur) return null;
  const kind = previewable(cur, !!m.confidential);
  return createPortal(
    <div className="modal-back" onMouseDown={onClose}>
      <div ref={box} tabIndex={-1} onKeyDown={trap} className="modal pv-modal" role="dialog" aria-modal="true" aria-label={t("reading.att.previewName", { name: cur.name })} onMouseDown={(e) => e.stopPropagation()}>
        <div className="pv-head">
          <b className="pv-name ellipsis">{cur.name}</b>
          {list.length > 1 && <span className="muted small">{t("reading.pv.xOfY", { i: i + 1, total: list.length })}</span>}
          {kind === "image" && (
            <span className="pv-zoom">
              <button className="icon-btn" aria-label={t("reading.pv.zoomOut")} onClick={() => setZoom((z) => (z === 2 ? 1 : "fit"))}><ZoomOut size={15} /></button>
              <button className="link-btn small" onClick={() => setZoom("fit")}>{zoom === "fit" ? t("reading.pv.fit") : `${zoom * 100}%`}</button>
              <button className="icon-btn" aria-label={t("reading.pv.zoomIn")} onClick={() => setZoom((z) => (z === "fit" ? 1 : 2))}><ZoomIn size={15} /></button>
            </span>
          )}
          {!m.confidential && <button className="btn small" onClick={() => void openAttachment(m, cur)}><ExternalLink size={13} /> {t("reading.att.open")}</button>}
          {!m.confidential && <button className="btn small" onClick={() => void saveAs(m, cur, (p) => savedToast(p, cur.name)).catch((e) => useStore.getState().showToast(() => t("reading.att.couldntSave", { name: cur.name, error: friendlyError(e) }), undefined, "error"))}><Download size={13} /> {t("reading.att.saveAs")}</button>}
          <button className="icon-btn" aria-label={t("reading.pv.close")} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="pv-stage">
          {list.length > 1 && (
            <>
              <button className="pv-nav prev" aria-label={t("reading.pv.prev")} disabled={i === 0} onClick={() => setI((x) => x - 1)}><ChevronLeft size={18} /></button>
              <button className="pv-nav next" aria-label={t("reading.pv.next")} disabled={i >= list.length - 1} onClick={() => setI((x) => x + 1)}><ChevronRight size={18} /></button>
            </>
          )}
          {!data ? (
            <div className="pv-msg"><span className="spin" /> {t("common.loading")}</div>
          ) : data.error ? (
            <div className="pv-msg"><ImageOff size={28} /><div>{t("reading.pv.showFailed", { error: data.error })}</div></div>
          ) : data.notPdf ? (
            <div className="pv-msg"><ImageOff size={28} /><div>{t("reading.pv.notPdf")}</div></div>
          ) : kind === "text" ? (
            <pre className="pv-text" {...(m.confidential ? { style: { userSelect: "none", WebkitUserSelect: "none" } as const, onCopy: noCopy, onCut: noCopy, onContextMenu: noCopy, onDragStart: noCopy } : {})}>{data.text}</pre>
          ) : kind === "pdf" ? (
            <iframe
                title={cur.name}
                src={data.url}
                sandbox={data.sandbox}
                onLoad={(e) => {
                  // no native webview menu in a text / html preview either (a PDF is drawn by the engine's own viewer, which keeps its menu)
                  const f = e.currentTarget;
                  try {
                    if (f.contentDocument) guardFrame(f, f.contentDocument);
                  } catch {
                    /* a frame we cannot reach */
                  }
                }}
              />
          ) : (
            <img
              src={data.url}
              alt={cur.name}
              {...lock}
              style={{ ...lock.style, ...(zoom === "fit" ? undefined : { maxWidth: "none", maxHeight: "none", width: `${zoom * 100}%` }) }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
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
export function Lightbox({ items, index, onClose, onIndex, confidential }: { items: LbItem[]; index: number; onClose: () => void; onIndex: (i: number) => void; confidential?: boolean }) {
  const t = useT();
  const cur = items[index];
  const lock = imageLock(!!confidential);
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0); // 0 = fit
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { box, trap } = useDialogFocus<HTMLDivElement>(() => closeRef.current);

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
  return createPortal(
    <div ref={box} onKeyDown={trap} className="lightbox" role="dialog" aria-modal="true" aria-label={t("reading.lb.label", { name: cur.name })}>
      <div className="lb-bar">
        <b className="ellipsis" style={{ minWidth: 0 }}>{cur.name}</b>
        <span className="muted small">{t("reading.pv.xOfY", { i: index + 1, total: items.length })}{cur.size ? ` · ${fmtSize(cur.size)}` : ""}{dims ? ` · ${dims.w} × ${dims.h}` : ""}</span>
        <span className="grow" style={{ flex: 1 }} />
        <button className="icon-btn" aria-label={t("reading.pv.zoomOut")} onClick={() => setZoom((z) => Math.max(0.25, (z || 1) / 1.25))}><ZoomOut size={16} /></button>
        <button className="link-btn small" onClick={() => setZoom(0)}>{zoom ? `${Math.round(zoom * 100)}%` : t("reading.pv.fit")}</button>
        <button className="icon-btn" aria-label={t("reading.pv.zoomIn")} onClick={() => setZoom((z) => Math.min(4, (z || 1) * 1.25))}><ZoomIn size={16} /></button>
        <button ref={closeRef} className="icon-btn" aria-label={t("common.close")} onClick={onClose}><X size={16} /></button>
      </div>
      <div className="lb-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {index > 0 && <button className="lb-nav prev" aria-label={t("reading.lb.prev")} onClick={() => onIndex(index - 1)}><ChevronLeft size={20} /></button>}
        {index < items.length - 1 && <button className="lb-nav next" aria-label={t("reading.lb.next")} onClick={() => onIndex(index + 1)}><ChevronRight size={20} /></button>}
        {src === null ? (
          <span className="spin" aria-label={t("reading.lb.loading")} />
        ) : src === "" ? (
          <div className="pv-msg"><ImageOff size={28} /> {t("reading.pic.failed")}</div>
        ) : (
          <img
            src={src}
            alt={cur.name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            {...lock}
            style={{ ...lock.style, ...(zoom ? { maxWidth: "none", maxHeight: "none", width: `${zoom * 100}%` } : undefined) }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
