import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, Node as TipNode, useEditor, type Editor } from "@tiptap/react";
import {
  AlignCenter, AlignLeft, AlignRight, BadgeCheck, CalendarClock, CalendarPlus, ChevronDown, ExternalLink, FileText, ImagePlus, Info, Link2, Lock, LockOpen, MoreHorizontal, Paperclip, Save, Send, ShieldAlert, ShieldCheck, Sparkles, Trash2,
  TriangleAlert, X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, Att, Contact, Draft, DraftSecurity, errorCode, InlineImage, MessageFull, OwnKeyStatus, RecipientStatus, Signature, Template } from "../api";
import { eff } from "../prefs";
import { kbd } from "../platform";
import { ComposeInit, friendlyError, useStore } from "../store";
import { useAiSlot } from "../useAiSlot";
import { aiReady, leaveAiContext, showAiNotSetUp, showAiProblem } from "../aiGuide";
import type { ComposeProbe, SavedDraft } from "../leaveCompose";
import { PreviewBg, previewVars, rememberPreview, startPreview } from "../composePreview";
import { setDarkRegion } from "../composePreviewDom";
import { extractSignature, normalizeHtml, SIG_MARK } from "../signature";
import { baseExtensions } from "../editor/extensions";
import { useKit } from "../editor/kit";
import { FormatBar, type FormatBarApi } from "../editor/FormatBar";
import { PreviewSwitch } from "../editor/PreviewSwitch";
import { setPreviewMode } from "../editor/previewColors";
import { messageHtml, nameInlinePicture } from "../editor/messageBody";
import { unwrapBase, type BaseFont } from "../editor/emailHtml";
import { extractQuote, quotePictureBytes } from "../editor/quoteBlock";
import { baseFromPrefs } from "../editor/baseFont";
import { repairSignature, signatureGuard } from "../signatureGuard";
import { fitInWindow } from "../fitInWindow";
import { BAR_ROW_MAX, isCompact } from "../composeFit";
import { autosaveDue, snapshotDue, timing, type AutosaveWhy } from "../autosave";
import { RecoveryWriter, type RecoveryForm } from "../recovery";
import { cleanPastedHtml, stripRemotePictures } from "../pastedHtml";
import { fromAccountFor } from "../fromAccount";
import { askFreshBeforeSend, isSizeRefusal, sendLimit, showSizeToast, wireSize } from "../sendSize";
import { outgoingName, outgoingNames } from "../attachName";
import { placePictureTools } from "../pictureToolsLayout";
import type { PictureToolsInput } from "../pictureToolsLayout";
import { blockedAttachmentExt, dataUriBytes, fileToBase64, fmtClock, fmtIn, fmtSize, fmtWhen, htmlToText, imageSize, PICTURE_TYPES, playSent, resizeImage, sanitizeHtml, shortKey, userName } from "../util";
import { calTz } from "../calendar";
import { defaultMeeting, MeetingState, MeetingStrip, meetingToDraft } from "./Calendar";
import { isEmail, singleLabelHostsOf } from "../addresses";
import { addRecipients, addressOf, chipLabel, formatRecipient, hasRecipient, isImeEvent, openAtEnd, placeRecipients, recipientKey, splitRecipients, type RcptField } from "../recipients";
import { askUnlock } from "./Pgp";
import { composeSeam } from "../popout/composeSeam";
import { focusDraftWindow, startCompose, wantsWindow, type StartOpts } from "../popout/composeOpen";
import { draftKey } from "../popout/entry";
import { shiftNow } from "../popout/modifier";
import { openPopout } from "../popout/open";
import { useContentProtection } from "../protect";
import { editorKeyHandlers, isAltGraph } from "../composeKeys";
import { useLinkEditor } from "./LinkPopover";
import { SchedulePicker } from "./SchedulePicker";
import { ImportanceButtons, ImportanceMark } from "./Importance";
import { draftImportance, initialImportance, pressImportance, type Importance } from "../importance";
import { AccountPicker, Dropdown, FloatingMenu, usePinnedBelow, useOutside, type MenuItem } from "./ui";
import type { Key } from "../i18n";
import { t as tNow } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";

/** Whether this is an address the composer accepts (see addresses.ts: `qa@localhost` and the account hosts count). */
const EMAIL = { test: (a: string) => isEmail(a, singleLabelHostsOf(useStore.getState().accounts)) };
const bareAddress = addressOf;
const approxBytes = (a: Att) => Math.floor((a.dataBase64.length * 3) / 4);
const MEDIUM = 480;
const SIZES: [Key, number | null][] = [["compose.pic.small", 240], ["compose.pic.medium", MEDIUM], ["compose.pic.large", 720], ["compose.pic.original", null]];
const LARGE_PICTURE = 1024 * 1024;


/**
 * The signature region of a message: an atom the user cannot type into or break. Its header holds the signature picker (React
 * portal into the element reported through `mount`), its body is filled from the chosen signature without touching the document,
 * so changing the signature or the From account never alters the typed text. `buildDraft` turns it into the signature HTML.
 */
const SignatureBlock = (cb: { mount: (el: HTMLElement) => void; unmount: (el: HTMLElement) => void }) =>
  TipNode.create({
    name: "signatureBlock",
    group: "block",
    atom: true,
    selectable: false,
    draggable: false,
    parseHTML: () => [{ tag: "div[data-sig-block]" }],
    renderHTML: () => ["div", { "data-sig-block": "" }],
    addProseMirrorPlugins: () => [signatureGuard("signatureBlock")],
    addNodeView: () => () => {
      const dom = document.createElement("div");
      dom.className = "sig-block none";
      dom.contentEditable = "false";
      dom.innerHTML = '<div class="sig-head"></div><div class="sig-body"></div>';
      const head = dom.querySelector<HTMLElement>(".sig-head")!;
      queueMicrotask(() => cb.mount(head));
      return { dom, ignoreMutation: () => true, stopEvent: () => true, destroy: () => queueMicrotask(() => cb.unmount(head)) };
    },
  });

/** Recipient input with chips, address validation and keyboard-friendly suggestions. */
export function RecipientField({
  label, values, onChange, autoFocus, onTouch, onPending, keys, onKeyAction, hideLabel,
}: {
  label: string;
  /** the label is only for screen readers (the caller shows its own) */
  hideLabel?: boolean;
  values: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  onTouch?: () => void;
  /** what is typed in the box and not yet a chip (tells the crash-recovery snapshot about an address that was typed and not confirmed) */
  onPending?: (text: string) => void;
  /** PGP key status per address (lower case); shown on the chips while Encrypt is on */
  keys?: Record<string, RecipientStatus>;
  onKeyAction?: (a: "import" | "paste") => void;
}) {
  const t = useT();
  const [keyPop, setKeyPop] = useState<string | null>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  useOutside(popRef, () => setKeyPop(null), keyPop !== null);
  const [text, setText] = useState("");
  const pendingRef = useRef(onPending);
  pendingRef.current = onPending;
  useEffect(() => {
    pendingRef.current?.(text);
  }, [text]);
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const suggRef = useRef<HTMLDivElement>(null);
  // the popovers of the field are fixed: the header of the compose pane scrolls in a low window, and a scroll box would cut off an absolute one
  usePinnedBelow(popRef, fieldRef, keyPop !== null, { inset: 62 });
  usePinnedBelow(suggRef, fieldRef, sugg.length > 0, { inset: 62, match: true }, sugg);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  // many recipients: the box has a height of its own (App.css .chips) and shows the end, where the next one is typed
  useEffect(() => {
    const c = chipsRef.current;
    if (c && document.activeElement === input.current) c.scrollTop = c.scrollHeight;
  }, [values.length]);

  const commit = (raw: string) => {
    // one parser for typing, paste and drop (recipients.ts): a comma inside a quoted name does not end the recipient
    const parts = splitRecipients(raw);
    if (parts.length === 0) return /^[\s,;]*$/.test(raw) ? setText("") : undefined; // nothing but separators: the box is emptied
    onChange(addRecipients(values, parts)); // each address once, upper / lower case alike; the first spelling stays
    onTouch?.();
    setText("");
    setSugg([]);
    setHi(-1);
  };
  const pick = (c: Contact) => commit(formatRecipient(c.name ?? "", c.email));

  const onInput = (v: string, composing: boolean) => {
    // not while an input method is composing (its punctuation is part of the word), and not inside a quoted name
    if (!composing && /[,;]\s*$/.test(v) && !openAtEnd(v.replace(/[,;]\s*$/, ""))) return commit(v);
    setText(v);
    setHi(-1);
    if (v.trim().length >= 2) void api.suggestContacts(v.trim()).then(setSugg).catch(() => setSugg([]));
    else setSugg([]);
  };

  return (
    <div className="cf-field rcpt" ref={fieldRef} onClick={() => input.current?.focus()}>
      {!hideLabel && <label>{label}</label>}
      <div className="chips" ref={chipsRef}>
        {values.map((v) => {
          const addr = bareAddress(v).toLowerCase();
          const ks = keys?.[addr];
          const noKey = !!ks && ks.status !== "ok";
          return (
          <span key={v} data-email={EMAIL.test(bareAddress(v)) ? bareAddress(v) : undefined} className={`rchip ${EMAIL.test(bareAddress(v)) ? "" : "bad"} ${noKey ? "nokey" : ""}`} title={EMAIL.test(bareAddress(v)) ? (noKey ? t("compose.rcpt.noUsableKey", { addr }) : v) : t("compose.rcpt.notAddress")}>
            {ks && (ks.status === "ok" ? (
              <span className="rchip-key ok" title={t("compose.rcpt.keyFound")} role="img" aria-label={t("compose.rcpt.keyFoundFor", { addr })}><Lock size={11} /></span>
            ) : (
              <button type="button" className="rchip-key missing" aria-label={t("compose.rcpt.noKeyOptions", { addr })} aria-haspopup="dialog" aria-expanded={keyPop === addr} onClick={(e) => (e.stopPropagation(), setKeyPop(keyPop === addr ? null : addr))}>
                <LockOpen size={11} />
              </button>
            ))}
            <span className="ellipsis">{chipLabel(v)}</span>
            <button
              type="button"
              aria-label={t("compose.rcpt.remove", { name: chipLabel(v) })}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((x) => x !== v));
                onTouch?.();
              }}
            >
              <X size={11} />
            </button>
          </span>
          );
        })}
        <input
          ref={input}
          value={text}
          aria-label={label}
          placeholder={values.length === 0 ? "name@example.com" : undefined}
          onChange={(e) => onInput(e.target.value, !!(e.nativeEvent as InputEvent).isComposing)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n\r\t<]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          onDrop={(e) => {
            // text dragged into the box (a list of addresses from another program) becomes chips like a paste
            const dropped = e.dataTransfer.getData("text");
            if (dropped && /[,;\n\r\t<@]/.test(dropped)) {
              e.preventDefault();
              e.stopPropagation();
              commit(text + dropped);
            }
          }}
          onBlur={() => {
            setTimeout(() => setSugg([]), 120);
            commit(text);
          }}
          onKeyDown={(e) => {
            // Enter / Tab / `,` that belong to an input method (it confirms a half-converted word) do not make a chip
            if (isImeEvent(e)) return;
            if (e.key === "ArrowDown" && sugg.length) {
              e.preventDefault();
              setHi((h) => Math.min(h + 1, sugg.length - 1));
            } else if (e.key === "ArrowUp" && sugg.length) {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" || e.key === "Tab" || e.key === ";" || e.key === ",") {
              // Tab turns what is typed into a recipient and then moves on to the next field as usual (it used to stay here, so the
              // subject was typed into this box: QA BUG-M2); Enter, `;` and `,` keep the focus here for the next address
              const moveOn = e.key === "Tab";
              if (hi >= 0 && sugg[hi]) {
                if (!moveOn) e.preventDefault();
                pick(sugg[hi]);
              } else if (text.trim()) {
                // a `,` or `;` typed inside a quoted name is part of the name
                if ((e.key === "," || e.key === ";") && openAtEnd(text)) return;
                if (!moveOn) e.preventDefault();
                commit(text);
              }
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
              onTouch?.();
            } else if (e.key === "Escape") setSugg([]);
          }}
        />
      </div>
      {keyPop && keys?.[keyPop] && (
        <span className="suggest pinned popover" role="dialog" aria-label={t("compose.rcpt.keyDialog", { addr: keyPop })} ref={popRef} style={{ width: 340, padding: 12, gap: 8, display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}><TriangleAlert size={15} className="warn-ico" /><b>{keys[keyPop].status === "expired" ? t("compose.rcpt.keyExpired", { addr: keyPop }) : keys[keyPop].status === "revoked" ? t("compose.rcpt.keyRevoked", { addr: keyPop }) : t("compose.rcpt.keyMissing", { addr: keyPop })}</b></span>
          <span className="muted small">
            {keys[keyPop].status === "missing"
              ? t("compose.rcpt.missingHelp")
              : t("compose.rcpt.unusableHelp")}
          </span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn small primary" onClick={() => (setKeyPop(null), onKeyAction?.("import"))}>{t("compose.rcpt.importKey")}</button>
            <button className="btn small" onClick={() => (setKeyPop(null), onKeyAction?.("paste"))}>{t("compose.rcpt.pasteKey")}</button>
            <button className="btn small" onClick={() => { const a = keyPop; setKeyPop(null); onChange(values.filter((x) => bareAddress(x).toLowerCase() !== a)); onTouch?.(); }}>{t("compose.rcpt.removeRecipient")}</button>
          </span>
        </span>
      )}
      {sugg.length > 0 && (
        <div className="suggest pinned" role="listbox" ref={suggRef}>
          {sugg.map((c, i) => (
            <div key={c.email} role="option" aria-selected={i === hi} className={i === hi ? "hl" : ""} onMouseDown={(e) => (e.preventDefault(), pick(c))} onMouseEnter={() => setHi(i)}>
              {c.name ? `${c.name} ` : ""}
              <span className="muted">&lt;{c.email}&gt;</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pictures: stored <-> editor

/** Pictures of a stored message as data: URIs for the editor, and the attachments that stay attachments. */
export async function messageToEditor(m: MessageFull): Promise<{ html: string | null; attachments: Att[] }> {
  let html = m.html;
  const attachments: Att[] = [];
  for (const a of m.attachments) {
    if (a.inline && a.referenced) {
      // embedded at sync time already, or still a cid: reference that is fetched now
      const d = html && a.cid ? await api.attachmentData(m.id, a.index).catch(() => null) : null;
      if (d && html) {
        if (html.includes(`cid:${a.cid}`)) html = html.split(`cid:${a.cid}`).join(`data:${d.mime};base64,${d.dataBase64}`);
        // (the part knows the file name the picture was added with; the HTML does not)
        html = nameInlinePicture(html, d.dataBase64, a.name || d.name);
      }
      continue;
    }
    // one unreadable attachment must not stop the draft from opening
    const d = await api.attachmentData(m.id, a.index).catch(() => null);
    if (d) attachments.push({ filename: d.name, mime: d.mime, dataBase64: d.dataBase64 });
  }
  return { html, attachments };
}

/**
 * Open a draft (a conversation of the Drafts folder) in Compose, with its pictures and attachments, asking for the key of an encrypted
 * one. `wait`: the draft was only just saved, so the local copy may not be there yet: the sync is asked for it a few times.
 * Returns whether Compose was opened. It opens in the pane or in a window of its own like any message (the setting and Shift, or `o.window`);
 * a draft is open in one editor only: when a window shows it already, that window comes forward and nothing is opened (REQ-C9).
 */
export async function openDraftThread(threadId: string, wait = false, o: StartOpts = {}): Promise<boolean> {
  const shift = o.shift ?? shiftNow(); // (read now: the draft is fetched first)
  const key = draftKey(threadId);
  const mine = ++latestDraftOpen;
  if (await focusDraftWindow(key)) return true;
  const st = useStore.getState();
  let msgs = await api.getThread(threadId, "drafts");
  for (let i = 0; wait && !msgs.some((x) => x.folder === "drafts") && i < 4; i++) {
    await useStore.getState().sync();
    msgs = await api.getThread(threadId, "drafts");
    if (!msgs.some((x) => x.folder === "drafts")) await new Promise((r) => setTimeout(r, 1200));
  }
  let m = msgs.filter((x) => x.folder === "drafts").pop() ?? msgs[msgs.length - 1];
  if (!m) {
    if (wait) st.showToast(() => tNow("compose.leave.draftNotFound"), undefined, "error");
    return false;
  }
  // a draft that was encrypted to your own key needs the key (and its passphrase) to be opened again
  if (m.security?.encrypted && m.security.decryption !== "ok") {
    if (m.security.decryption === "locked" && m.security.lockedKey && (await askUnlock(m.security.lockedKey, "draft", m.security.lockedLabel ?? undefined))) {
      m = await api.pgpDecryptMessage(m.id).catch(() => m);
    }
    if (m.security?.decryption !== "ok") {
      if (m.security?.decryption !== "locked") st.showToast(() => tNow("mail.draft.cannotOpen", { error: friendlyError(m.security?.error ?? tNow("mail.draft.keyMissing")) }), undefined, "error");
      return false;
    }
  }
  // restore pictures and attachments so saving or sending the draft does not silently drop them
  const { html, attachments } = await messageToEditor(m);
  if (mine !== latestDraftOpen) return false; // another draft was asked for meanwhile (the second click of a double click): only the last one opens
  // the recipients as they were typed (names, Bcc) come from the draft's own headers; the synced copy has bare To / Cc and no Bcc
  const rc = await api.draftRecipients(m.id).catch(() => null);
  // without the draft's own headers the Bcc recipients are unknown: say so, a send would leave them out
  if (!rc) st.showToast(() => tNow("compose.draft.bccUnread"), undefined, "error");
  await startCompose({
    accountId: m.accountId,
    to: rc?.to ?? (m.to ? splitRecipients(m.to) : []),
    cc: rc?.cc ?? (m.cc ? splitRecipients(m.cc) : []),
    bcc: rc?.bcc,
    // the threading headers of the saved draft: an answer that was saved goes out threaded as it would have before
    inReplyTo: rc?.inReplyTo ?? null,
    references: rc?.references ?? [],
    subject: m.subject === "(no subject)" ? "" : m.subject,
    bodyHtml: html ?? `<p>${(m.text ?? "").replace(/\n/g, "<br>")}</p>`,
    replaces: `m:${m.id}`, // the message that was opened: saving or sending replaces that one, not other drafts of the conversation
    attachments,
    security: m.security?.encrypted ? { encrypt: true, sign: false, attachPublicKey: false } : undefined,
    confidential: m.confidential,
    importance: m.importance,
  }, { ...o, shift, key });
  // the draft is open in the pane (not in a window): a double click moves it to a window instead of opening it twice (openDraftInWindow)
  if (!wantsWindow({ window: o.window, shift })) inlineDraft = { threadId, composeKey: useStore.getState().composeKey };
  return true;
}

/** The draft that was last opened in the pane, and which opening of the pane it was. */
let inlineDraft: { threadId: string; composeKey: number } | null = null;
/** Counts the openings of a draft: one that is overtaken by a newer one gives up. */
let latestDraftOpen = 0;

/**
 * A draft in a window of its own (double click or Shift+Enter on a row of the Drafts folder, REQ-C1). The first click of a double click has
 * opened it in the pane: when that is the draft still untouched it is closed first, so it is never open in two editors.
 */
export async function openDraftInWindow(threadId: string): Promise<boolean> {
  const st = useStore.getState();
  if (inlineDraft?.threadId === threadId && st.compose && st.composeKey === inlineDraft.composeKey && !st.composeDirty) await st.openCompose(null, { restore: false });
  return openDraftThread(threadId, false, { window: true });
}

/** Replace cid: references with the pictures' data: URIs (used when a sent or scheduled draft is reopened). */
export function picturesToEditor(html: string, pics: InlineImage[]): string {
  // (the file name each picture was added with goes back on it, so the reopened message sends it under that name)
  return pics.reduce((h, p) => nameInlinePicture(h.split(`cid:${p.cid}`).join(`data:${p.mime};base64,${p.dataBase64}`), p.dataBase64, p.filename), html);
}

const dataUriParts = (uri: string) => {
  const m = uri.match(/^data:([^;,]+);base64,(.*)$/);
  return m ? { mime: m[1], b64: m[2] } : null;
};

function readDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

// ---------------------------------------------------------------- compose

interface PictureSel {
  pos: number;
  width: number | null;
  alt: string;
  name: string;
  /** "center" / "right", else left; the address of the link on the picture, "" for none */
  align: string | null;
  href: string;
  /** where the picture is in the scrolling body (see pictureToolsLayout.ts); the toolbar is placed from it once it is measured */
  geo: Omit<PictureToolsInput, "width" | "height">;
}

export function Compose({ init }: { init: ComposeInit }) {
  // the table and picture nodes come in a chunk of their own (editor/kit.ts); the editor is made once they are there (fetched at start-up: no wait in practice)
  return useKit() ? <ComposeBody init={init} /> : null;
}

function ComposeBody({ init }: { init: ComposeInit }) {
  const t = useT();
  const { accounts, openCompose, showToast, prefs, refresh, confirm, choose, setComposeDirty, setComposeSaver, setComposeProbe, aiConfigured, setDialog, beginSend } = useStore();
  const [accountId, setAccountId] = useState(fromAccountFor(accounts, init.accountId, prefs.defaultAccount));
  const isFresh = !init.replaces && !init.isReply && !init.outboxId && !init.restore;
  // an opened draft / scheduled message / message that failed to send: its body already holds the signature, shown as the region again
  const editing = !!(init.replaces || init.outboxId || init.restore);
  const autoCc = (id: string) => (isFresh ? eff(prefs, id, "autoCc").trim() : "");
  const autoBcc = (id: string) => (isFresh ? eff(prefs, id, "autoBcc").trim() : "");
  const [to, setTo] = useState<string[]>(init.to ?? []);
  const [cc, setCc] = useState<string[]>([...(init.cc ?? []), ...(autoCc(accountId) ? [autoCc(accountId)] : [])]);
  const [bcc, setBcc] = useState<string[]>([...(init.bcc ?? []), ...(autoBcc(accountId) ? [autoBcc(accountId)] : [])]);
  /**
   * What was typed, pasted, dropped or picked in a recipient field. An address lives in ONE field, the first of To, Cc, Bcc that has it
   * (R19A-2): one that is already in an earlier field is not added again (a note says where it is), one that is in a later field moves up.
   */
  const changeField = (field: RcptField) => (next: string[]) => {
    const r = placeRecipients({ to, cc, bcc }, field, next);
    setTo(r.fields.to);
    setCc(r.fields.cc);
    setBcc(r.fields.bcc);
    const name = (f: RcptField) => t(`compose.${f}`);
    for (const x of r.skipped.slice(0, 3)) showToast(t("compose.rcpt.alreadyIn", { addr: x.addr, field: name(x.in) }), undefined, "info");
    for (const x of r.moved.slice(0, 3)) showToast(t("compose.rcpt.movedUp", { addr: x.addr, from: name(x.from), to: name(field) }), undefined, "info");
  };
  const [showCc, setShowCc] = useState(cc.length > 0 || bcc.length > 0);
  // the sender asked for answers to go to another address than From (Reply-To): said under To, with a way back to From
  const [replyNote, setReplyNote] = useState(init.replyNote ?? null);
  const noteKeys = replyNote ? replyNote.replyTo.map(recipientKey) : [];
  const noteShown = !!replyNote && to.some((x) => noteKeys.includes(recipientKey(x)));
  const replyToFrom = () => {
    if (!replyNote) return;
    setTo(addRecipients([replyNote.from], to.filter((x) => !noteKeys.includes(recipientKey(x)))));
    setReplyNote(null);
    touch();
  };
  const [subject, setSubject] = useState(init.subject ?? "");
  // the attachments of an opened draft / forward are shown (and sent) under a clean name: no folder, no hidden characters (O-05)
  const [atts, setAtts] = useState<Att[]>(() => {
    const names = outgoingNames((init.attachments ?? []).map((a) => a.filename));
    return (init.attachments ?? []).map((a, i) => ({ ...a, filename: names[i] }));
  });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sigs, setSigs] = useState<Signature[]>([]);
  // the message of an opened draft carries its signature as stored text: it is shown as the signature region again
  const startDoc = useRef<{ html: string; sig: string | null; base: BaseFont | null } | null>(null);
  if (editing && !startDoc.current) {
    // the stored message is one box with the default font it was written in (editor/emailHtml.ts): the draft keeps that font
    const u = unwrapBase(init.bodyHtml ?? "");
    // the quoted original of a reply / forward is a block of its own again (editor/quoteBlock.ts), then the signature region
    startDoc.current = { ...extractSignature(extractQuote(u.html).html), base: u.base };
  }
  // the default font of THIS message: the one the draft was written in, else the Settings > Composing choice at the time it was opened
  const [base] = useState<BaseFont>(() => startDoc.current?.base ?? baseFromPrefs(prefs));
  const baseRef = useRef(base);
  const barApi = useRef<FormatBarApi>(null);
  const draftSig = useMemo<Signature | null>(
    () => (startDoc.current?.sig ? { id: "draft-signature", name: "", html: startDoc.current.sig, isDefault: false, accountId: null } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [sigId, setSigId] = useState<string>(editing ? (draftSig ? "draft-signature" : "none") : "");
  const sigManual = useRef(false); // the user picked a signature: it stays until it stops being valid for the From account
  const [sigHeads, setSigHeads] = useState<HTMLElement[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const ai = useAiSlot("write");
  const [busy, setBusy] = useState(false);
  // a meeting: To = required attendees, Cc = optional; sent as a calendar invitation
  const [meeting, setMeeting] = useState<MeetingState | null>(init.meeting ? defaultMeeting(calTz(prefs), init.meeting) : null);
  const [schedOpen, setSchedOpen] = useState(!!init.openSchedule);
  const [dragging, setDragging] = useState(false);
  const [dragImages, setDragImages] = useState(false);
  const [hotZone, setHotZone] = useState<"top" | "bottom" | null>(null);
  const [pics, setPics] = useState({ count: 0, bytes: 0 });
  const [picSel, setPicSel] = useState<PictureSel | null>(null);
  const [altOpen, setAltOpen] = useState(false);
  const [altText, setAltText] = useState("");
  // "Preview as recipient": which background the body is shown on. A view-layer choice only (buildDraft never reads it)
  const [pv, setPv] = useState<PreviewBg>(() => startPreview(prefs.mailCanvas));
  const choosePreview = (p: PreviewBg) => {
    rememberPreview(p);
    setPv(p);
  };
  // PGP: Encrypt is "on", "off", or "auto" (on while every recipient has a key); Sign is a plain switch
  const keysRev = useStore((s) => s.keysRev);
  const startMode = eff(prefs, accountId, "pgpEncrypt");
  // Outlook's Sensitivity: Confidential. An answer to confidential mail starts that way, and keeps the window out of screen capture
  // while it quotes the mail (init.confidential), as the reading pane does.
  const [confidential, setConfidential] = useState(!!init.confidential);
  // Outlook's Importance (High / Low / Normal): per message, Normal unless a reopened draft or scheduled message was High / Low
  const [importance, setImportance] = useState<Importance>(initialImportance(init));
  useContentProtection(!!init.confidential);
  const [encIntent, setEncIntent] = useState<"on" | "off" | "auto">(init.restore ? init.restore.encrypt : init.security ? (init.security.encrypt ? "on" : "off") : startMode === "always" ? "on" : startMode === "possible" ? "auto" : "off");
  const [signOn, setSignOn] = useState(init.restore ? init.restore.sign : init.security ? init.security.sign : eff(prefs, accountId, "pgpSign"));
  const [attachKey, setAttachKey] = useState(init.restore ? init.restore.attachKey : init.security ? init.security.attachPublicKey : eff(prefs, accountId, "pgpAttachKey"));
  const [signMenu, setSignMenu] = useState(false);
  // how much room the pane has (composeFit.ts): a small one shows the actions as icons and More; the measure is the pane, not the window
  const paneRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [barWraps, setBarWraps] = useState(false); // the actions did not fit in one row (a long name of Send, a scheduled message): then the row scrolls away with the fields instead of staying put
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const bar = el.querySelector<HTMLElement>(".cp-bar");
    const measure = () => {
      setCompact(isCompact(el.clientWidth, el.clientHeight));
      setBarWraps(!!bar && bar.offsetHeight > BAR_ROW_MAX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (bar) ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  const [secDetails, setSecDetails] = useState(false);
  const [ks, setKs] = useState<{ own: OwnKeyStatus | null; recipients: Record<string, RecipientStatus> } | null>(null);
  const signRef = useRef<HTMLDivElement>(null);
  const signCaretRef = useRef<HTMLButtonElement>(null);
  const touched = useRef(false);
  /** the address typed in To / Cc / Bcc and not yet confirmed as a chip (a crash right then still keeps it, in the snapshot) */
  const pendingRcpt = useRef({ to: "", cc: "", bcc: "" });
  const pending = (k: "to" | "cc" | "bcc") => (v: string) => {
    if (pendingRcpt.current[k] === v) return;
    pendingRcpt.current[k] = v;
    if (v.trim()) touch();
  };
  const ccTouched = useRef(false);
  const savedRef = useRef(false); // an outbox item was saved, moved or sent from here (nothing to release)
  const fileRef = useRef<HTMLInputElement>(null);
  const picRef = useRef<HTMLInputElement>(null);
  const schedRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useOutside(schedRef, () => setSchedOpen(false), schedOpen);
  const schedPopRef = useRef<HTMLDivElement>(null);
  usePinnedBelow(schedPopRef, schedRef, schedOpen); // fixed: the header scrolls in a low window, and a scroll box would cut off an absolute popover

  const revRef = useRef(0); // up with every edit: a save that was running while the person typed knows it
  const attachingRef = useRef(0); // files / pictures being read into the message
  const savedTid = useRef<string | null>(null); // the conversation of the draft a save made (the "Draft saved" toast opens it with Edit)
  const savedDraftRef = useRef<string | null>(null); // that draft as a reference: a second save, a send or a discard replaces / removes exactly it
  const replacesRef = () => savedDraftRef.current ?? init.replaces ?? null; // the draft this message takes the place of
  const baseline = useRef<{ text: string; pics: number } | null>(null); // the body as Compose opened it (a reply: the quote)

  // Autosave and crash recovery (autosave.ts, recovery.ts). A changed message is saved to Drafts about every 30 s, replacing the draft the earlier
  // save made; and its form is written to a local snapshot every few seconds, which stays until the message is sent, discarded or saved, so a
  // kill or a crash loses nothing: the next start offers it back.
  const recoveryId = useRef<string>(init.recoveryId ?? crypto.randomUUID()).current;
  const writerRef = useRef<RecoveryWriter | null>(null);
  writerRef.current ??= new RecoveryWriter(recoveryId, { save: (s) => api.recoverySave(s), clear: (id, why) => api.recoveryClear(id, why) });
  const writer = writerRef.current;
  const savingRef = useRef(0); // saves that are running (autosave, Save draft, leaving)
  const savedRevRef = useRef(0); // the revision the last successful save covered
  const changedAtRef = useRef(0); // when the first change after that save was made
  const lastTryRef = useRef(0); // when the last autosave started
  const failuresRef = useRef(0); // autosaves that failed in a row
  const snapRevRef = useRef(-1); // the revision the last snapshot covered
  const snapAtRef = useRef(0);
  const sendingRef = useRef(false); // the message is on its way out: its snapshot stays until the send is safe
  const poppingRef = useRef(false); // the message is being moved to a window of its own: the window that opens must not make this pane autosave it
  const filesKeyRef = useRef<{ atts: Att[]; key: string } | null>(null);
  const [autosavedAt, setAutosavedAt] = useState<number | null>(null);

  // The picture toolbar is placed after it has been laid out: it wraps to more rows in a narrow pane, so its size is measured, then it
  // goes above / below the picture and inside the pane (pictureToolsLayout.ts). The alt text popover opens under it, also inside the pane.
  const toolsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = toolsRef.current;
    if (!picSel || !anchor) return;
    const box = anchor.firstElementChild as HTMLElement;
    const { geo } = picSel;
    box.style.marginLeft = "";
    const { left, top } = placePictureTools({ ...geo, width: box.offsetWidth, height: box.offsetHeight });
    box.style.marginLeft = `${left}px`;
    anchor.style.top = `${top}px`;
    const pop = box.querySelector<HTMLElement>(".alt-pop");
    if (pop) {
      pop.style.maxWidth = `${Math.max(0, geo.paneWidth - 16)}px`;
      pop.style.marginLeft = "";
      const at = left + pop.offsetLeft;
      pop.style.marginLeft = `${fitInWindow({ left: at, right: at + pop.offsetWidth, top: 0, bottom: 0 }, geo.paneWidth, Infinity).shift}px`;
    }
  });

  const touch = useCallback(() => {
    touched.current = true;
    revRef.current++;
    if (!changedAtRef.current) changedAtRef.current = Date.now();
    setComposeDirty(true);
  }, [setComposeDirty]);

  // key status of every recipient (and of the From account's own key), refreshed 250 ms after a change
  const allAddrs = useMemo(
    () => Array.from(new Set([...to, ...cc, ...bcc].map((a) => bareAddress(a).toLowerCase()).filter((a) => EMAIL.test(a)))),
    [to, cc, bcc],
  );
  const addrKey = allAddrs.join(",");
  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .pgpRecipientStatus(accountId, allAddrs)
        .then((r) => live && setKs({ own: r.own, recipients: Object.fromEntries(r.recipients.map((x) => [x.address.toLowerCase(), x])) }))
        .catch(() => live && setKs({ own: null, recipients: {} }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, addrKey, keysRev]);

  const own = ks?.own ?? null;
  const noKeyAddrs = ks ? allAddrs.filter((a) => ks.recipients[a] && ks.recipients[a].status !== "ok") : [];
  const canEnc = !!own && own.canEncrypt;
  const encOn = !!own && (encIntent === "on" || (encIntent === "auto" && canEnc && noKeyAddrs.length === 0));
  const signActive = signOn && !!own;
  const autoOff = encIntent === "auto" && !!own && noKeyAddrs.length > 0;
  const fromEmail = accounts.find((a) => a.id === accountId)?.email ?? "";
  const encTitle = !own
    ? t("compose.bar.noPgpKey", { email: fromEmail })
    : encOn && noKeyAddrs.length > 0
      ? kbd(t("compose.bar.encryptTipMissing", { n: noKeyAddrs.length }))
      : kbd(t("compose.bar.encryptTip"));
  const toggleEncrypt = () => {
    if (!own) return setDialog({ type: "pgp-generate", accountId });
    setEncIntent(encOn ? "off" : "on");
    touch();
  };
  const toggleSign = () => {
    if (!own) return setDialog({ type: "pgp-generate", accountId });
    setSignOn(!signOn);
    touch();
  };
  const toggleMeeting = () => {
    if (meeting) setMeeting(null);
    else {
      if (bcc.length) {
        setBcc([]);
        showToast(t("compose.meeting.bccRemoved"), undefined, "info");
      }
      setMeeting(defaultMeeting(calTz(prefs)));
    }
    touch();
  };
  /** The rows of the menu at the Sign button: sign this message, attach the public key, the signing key, the keys. */
  const signItems: MenuItem[] = [
    { label: t("compose.bar.signThis"), checked: signOn, hint: kbd("Ctrl+Shift+G"), disabled: !own, onClick: toggleSign },
    { label: t("compose.bar.attachPublicKey"), checked: attachKey, disabled: !own, onClick: () => (setAttachKey(!attachKey), touch()) },
    { divider: true },
    ...(own ? [{ label: t("compose.bar.signingKey", { key: shortKey(own.fingerprint) }), icon: <ShieldCheck size={14} />, onClick: () => setDialog({ type: "pgp-key", fingerprint: own.fingerprint }) }] : [{ label: t("compose.bar.noKeyYet"), disabled: true }]),
    { label: own ? t("compose.bar.manageKeys") : t("compose.bar.setUpEncryption"), onClick: () => (own ? setDialog({ type: "settings", tab: "pgp" }) : setDialog({ type: "pgp-generate", accountId })) },
  ];
  /** What this message will do, as sent to the backend. */
  const currentSecurity = (): DraftSecurity | undefined =>
    encOn || signActive ? { encrypt: encOn, sign: signActive, attachPublicKey: attachKey && (encOn || signActive) } : undefined;

  const addFilesRef = useRef<(files: File[]) => Promise<void>>(async () => undefined);

  /** Where the picture tools float: above the selected picture, below it when there is no room. */
  const syncPicSel = (ed: Editor) => {
    const sel = ed.state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return setPicSel(null);
    const dom = ed.view.nodeDOM(sel.from) as HTMLElement | null;
    const box = bodyRef.current?.getBoundingClientRect();
    if (!dom || !box) return setPicSel(null);
    const r = dom.getBoundingClientRect();
    const body = bodyRef.current!;
    const scroll = body.scrollTop;
    setPicSel({
      pos: sel.from,
      width: (sel.node.attrs.width as number | null) ?? null,
      alt: (sel.node.attrs.alt as string | null) ?? "",
      name: (sel.node.attrs["data-name"] as string | null) ?? "picture",
      align: (sel.node.attrs.align as string | null) ?? null,
      href: (sel.node.attrs.href as string | null) ?? "",
      geo: {
        imgLeft: r.left - box.left,
        imgWidth: r.width,
        imgTop: r.top - box.top + scroll,
        imgBottom: r.bottom - box.top + scroll,
        scrollTop: scroll,
        paneWidth: body.clientWidth,
        paneHeight: body.clientHeight,
      },
    });
  };

  const countPictures = (ed: Editor) => {
    let count = 0;
    let bytes = 0;
    ed.state.doc.descendants((n) => {
      if (n.type.name === "image" && typeof n.attrs.src === "string" && n.attrs.src.startsWith("data:")) {
        count++;
        bytes += dataUriBytes(n.attrs.src);
      }
      // the pictures inside the quoted original travel with the message too (they count toward its size, not toward the number of pictures)
      if (n.type.name === "quoteBlock") bytes += quotePictureBytes(String(n.attrs.html ?? ""));
    });
    setPics({ count, bytes });
  };

  // Ctrl/Cmd+K in the body and the toolbar button open the same link UI (set after the editor exists)
  const linkRef = useRef<() => void>(() => undefined);
  const pasteNote = useRef(false); // the "pictures from the web are not pasted" notice is shown once per message
  const startContent = useRef<string | null>(null); // the editor's first content, made once (a big quote is not scanned again at every render)
  const editor = useEditor({
    extensions: [
      ...baseExtensions({
        placeholder: t("compose.editor.placeholder"), showOnlyCurrent: false, getBase: () => baseRef.current, focusToolbar: () => barApi.current?.focus(), openStyles: () => barApi.current?.openStyles(), pictures: true,
        // the quoted original of a reply / forward: a protected block; "Edit quoted text" asks first (editor/quoteNode.ts)
        quote: { base: () => baseRef.current, ask: () => confirm({ title: tNow("compose.quote.editTitle"), body: tNow("compose.quote.editBody"), confirmLabel: tNow("compose.quote.editConfirm") }) },
      }),
      SignatureBlock({ mount: (el) => setSigHeads((h) => [...h, el]), unmount: (el) => setSigHeads((h) => h.filter((x) => x !== el)) }),
    ],
    // the accessible name belongs on the contenteditable node ProseMirror renders
    editorProps: {
      attributes: { "aria-label": t("compose.editor.body") },
      // one key, one action: Ctrl+Shift+B / Ctrl+Enter / Ctrl+Alt+... (AltGr) never reach the editor shortcuts, Ctrl+K is the link UI
      handleDOMEvents: editorKeyHandlers(() => linkRef.current()),
      // pasted / dropped HTML loses its remote pictures BEFORE the editor reads it: a tracking pixel or a UNC / file: picture is never requested
      transformPastedHTML: (html: string) => {
        const r = cleanPastedHtml(html);
        if (r.removed && !pasteNote.current) {
          pasteNote.current = true;
          showToast(tNow("compose.paste.picturesRemoved"), undefined, "info");
        }
        return r.html;
      },
      handlePaste: (_view, event) => {
        const all = Array.from(event.clipboardData?.files ?? []);
        const images = all.filter((f) => PICTURE_TYPES.includes(f.type));
        if (images.length === 0 || useStore.getState().prefs.inlinePictures !== "inline") return false;
        // the picture goes into the body, so the Compose-wide paste handler must not attach it as well
        event.preventDefault();
        event.stopPropagation();
        void insertPictures(images);
        const others = all.filter((f) => !PICTURE_TYPES.includes(f.type));
        if (others.length) void addFilesRef.current(others);
        return true;
      },
    },
    // a new message: typed text, then the signature region, then (reply / forward) the quoted message
    // a quoted or reopened body never brings a remote picture into the editor (the reader's "Load pictures" is the only place they load)
    content: (startContent.current ??= stripRemotePictures(editing ? startDoc.current!.html : `<p></p>${SIG_MARK}${extractQuote(init.bodyHtml ?? "<p></p>").html}`).html),
    autofocus: (init.to?.length ?? 0) > 0 ? "start" : false,
    // a body from an older build may lack the paragraph above the signature region: add it without counting as an edit
    onCreate: ({ editor: ed }) => {
      const fix = repairSignature(ed.state, "signatureBlock", null);
      if (fix) ed.view.dispatch(fix.setMeta("addToHistory", false).setMeta("signatureInit", true));
    },
    // the signature region itself cannot be deleted or moved by accident: signatureGuard (signatureGuard.ts) repairs it in place
    onUpdate: ({ editor: ed, transaction }) => {
      if (!transaction.getMeta("signatureInit")) touch();
      countPictures(ed);
      syncPicSel(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => syncPicSel(ed),
  });

  // the dark preview shows the picked colours the way the reading pane would (a view change: the document keeps what was picked)
  useEffect(() => {
    if (editor) setPreviewMode(editor, pv);
  }, [editor, pv]);

  // a resized window changes the pane the picture toolbar has to fit in, and a picture that has just loaded gets its real height
  useEffect(() => {
    if (!editor) return;
    const onResize = () => syncPicSel(editor);
    const dom = editor.view.dom;
    window.addEventListener("resize", onResize);
    dom.addEventListener("load", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      dom.removeEventListener("load", onResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // pictures that were already in the draft (or a scheduled message) are counted once the editor exists
  useEffect(() => {
    if (editor) countPictures(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const bodyPictures = (ed: Editor) => {
    let n = 0;
    ed.state.doc.descendants((x) => { if (x.type.name === "image") n++; });
    return n;
  };
  // the body as it opened (a reply: the quote), to tell what the person wrote from what Compose put there
  useEffect(() => {
    // (a restored message has nothing "as it opened": everything in it was written by the person, so it is content to keep)
    if (editor && !baseline.current) baseline.current = init.recoveryId || init.carried ? { text: "", pics: 0 } : { text: editor.getText().trim(), pics: bodyPictures(editor) };
  }, [editor]);

  // the link popover (LinkPopover.tsx): the same one for the toolbar button and Ctrl/Cmd+K, drawn under the button
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const link = useLinkEditor(editor, linkBtnRef);
  linkRef.current = link.open;

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void Promise.all([api.listTemplates(), api.listSignatures()]).then(([tpls, s]) => {
      setTemplates(tpls);
      setSigs(s);
      setLoaded(true);
    });
  }, []);

  // only what applies to the sending account: its own items plus those shared by all accounts
  const mySigs = sigs.filter((s) => !s.accountId || s.accountId === accountId);
  const myTemplates = templates.filter((tpl) => !tpl.accountId || tpl.accountId === accountId);
  // the signature stored in an opened draft is offered too (as the saved one, unless it is one of the user's signatures)
  const sigChoices = useMemo(
    () => (draftSig && !mySigs.some((s) => normalizeHtml(s.html) === normalizeHtml(draftSig.html)) ? [...mySigs, draftSig] : mySigs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sigs, accountId, draftSig],
  );
  const chosenSig = sigChoices.find((x) => x.id === sigId) ?? null;

  /** Explicit choice for the account (or All accounts), else the default of the narrowest scope that has one. */
  const defaultSig = useCallback(() => {
    const pick = eff(prefs, accountId, "signatureId");
    if (pick === "none") return "none";
    return (
      mySigs.find((x) => x.id === pick)?.id ??
      mySigs.find((x) => x.isDefault && x.accountId === accountId)?.id ??
      mySigs.find((x) => x.isDefault && !x.accountId)?.id ??
      ""
    );
  }, [prefs, accountId, mySigs]);

  useEffect(() => {
    if (!loaded) return;
    if (editing) {
      // an opened draft: the stored signature maps to the user's signature with the same content, else it stays as saved
      if (draftSig && sigId === "draft-signature") {
        const same = mySigs.find((s) => normalizeHtml(s.html) === normalizeHtml(draftSig.html));
        if (same) setSigId(same.id);
      } else if (sigId !== "none" && !sigChoices.some((s) => s.id === sigId)) setSigId(defaultSig() || "none"); // From changed to an account the signature does not belong to
      return;
    }
    // the From account changed (or the signatures arrived): a picked signature stays while it applies to that account, anything else follows the account's default
    if (sigManual.current && sigId && (sigId === "none" || mySigs.some((s) => s.id === sigId))) return;
    sigManual.current = false;
    setSigId(init.isReply && !eff(prefs, accountId, "signatureOnReply") ? "none" : defaultSig());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, accountId]);

  // the region shows the chosen signature right away; the document (what the user typed) is not touched
  useEffect(() => {
    const root = editor?.view.dom;
    if (!root) return;
    const html = chosenSig ? sanitizeHtml(chosenSig.html, true).html : "";
    root.querySelectorAll<HTMLElement>(".sig-block").forEach((blk) => {
      const body = blk.querySelector<HTMLElement>(".sig-body");
      if (body && body.innerHTML !== html) body.innerHTML = html;
      blk.classList.toggle("none", !html);
    });
  }, [editor, chosenSig, sigHeads]);

  // the signature region is a mail's own colours: on the dark preview it gets the reading pane's dark recolouring (after the fill above)
  useEffect(() => {
    const regions = Array.from(editor?.view.dom.querySelectorAll<HTMLElement>(".sig-block .sig-body") ?? []);
    regions.forEach((r) => setDarkRegion(r, pv === "dark"));
    return () => regions.forEach((r) => setDarkRegion(r, false));
  }, [editor, chosenSig, sigHeads, pv]);

  // switching the From account re-applies that account's Auto Cc/Bcc until the user edits those fields
  const changeAccount = (id: string) => {
    setAccountId(id);
    if (!ccTouched.current && isFresh) {
      setCc(autoCc(id) ? [autoCc(id)] : []);
      setBcc(autoBcc(id) ? [autoBcc(id)] : []);
      if (autoCc(id) || autoBcc(id)) setShowCc(true);
    }
    touch();
  };

  /**
   * The draft to store or send. Pictures in the body (data: URIs) become cid: references with their own part,
   * so they travel as related parts and are not listed as attachments.
   */
  const buildDraft = (): Draft => {
    // the editor's document -> the email HTML (editor/emailHtml.ts), the signature in place of its region, pictures as cid: parts, all in the default font's box
    const m = messageHtml(editor?.getJSON() ?? { type: "doc", content: [] }, {
      sig: chosenSig?.html ?? null,
      base,
      pictures: "cid",
      newCid: () => `${crypto.randomUUID()}@heylook`,
      fileName: (mime, n) => `picture-${n}.${mime.split("/")[1]?.replace("jpeg", "jpg") ?? "img"}`,
    });
    const inline: InlineImage[] = m.inline.map((i) => ({ cid: i.cid, filename: i.name, mime: i.mime, dataBase64: i.dataBase64 }));
    const body = m.html;
    const md = meeting ? meetingToDraft(meeting, calTz(prefs)) : null;
    return {
      accountId,
      to,
      cc,
      bcc,
      subject,
      html: body,
      text: htmlToText(body),
      inReplyTo: init.inReplyTo ?? null,
      references: init.references ?? [],
      attachments: atts,
      inline,
      security: currentSecurity(),
      confidential: confidential || undefined,
      importance: draftImportance(importance),
      meeting: md && "meeting" in md ? md.meeting : undefined,
    };
  };

  /** The message as Compose opens it: the draft (its pictures back to data: URIs so the editor shows them), the toggles as they were. */
  const initOf = (d: Draft, o: { replaces?: string; isReply: boolean; carried: boolean }): ComposeInit => {
    const bodyHtml = picturesToEditor(d.html, d.inline ?? []);
    return {
      ...init,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyHtml,
      accountId: d.accountId,
      attachments: d.attachments,
      replaces: o.replaces,
      recoveryId: undefined, // (a new message: it gets a snapshot of its own)
      isReply: o.isReply,
      carried: o.carried || undefined,
      security: d.security,
      confidential: d.confidential,
      importance: d.importance,
      // the toggles as they were when Send was pressed (the draft only knows what is active), the body with its one signature region
      restore: { encrypt: encIntent, sign: signOn, attachKey },
      meeting: d.meeting ? { ...d.meeting, on: true } : undefined,
    };
  };
  // (in a window of its own the message that comes back after Undo or a failed send counts as changed: closing the window asks, it never loses it)
  const reopen = (d: Draft) => void useStore.getState().openCompose(initOf(d, { replaces: init.replaces, isReply: false, carried: !!composeSeam() }));

  /** Move this message to a window of its own (REQ-C3, C4): all of it as it is, nothing saved, nothing asked; the pane closes once the window exists. */
  const popOut = async () => {
    if (init.outboxId || composeSeam() || busy) return;
    const moved = initOf(buildDraft(), { replaces: replacesRef() ?? undefined, isReply: !!init.isReply, carried: true });
    poppingRef.current = true; // (the new window takes the focus: this pane losing it must not save a draft of what is moving)
    if (!(await openPopout("compose", null, moved))) {
      poppingRef.current = false;
      return; // the pane stays as it is (the toast said why)
    }
    setComposeDirty(false);
    void openCompose(null);
  };

  /**
   * Before anything is sent or scheduled: ask what to do about recipients without a key, and unlock the signing
   * key. Returns the draft to send, or null when the user backed out.
   */
  const secureDraft = async (d: Draft): Promise<Draft | null> => {
    let sec = d.security;
    if (!sec || (!sec.encrypt && !sec.sign)) return d;
    let out = d;
    const r = await api.pgpRecipientStatus(d.accountId, [...d.to, ...d.cc, ...d.bcc].map((a) => bareAddress(a).toLowerCase())).catch(() => null);
    if (sec.encrypt && r) {
      const miss = r.recipients.filter((x) => x.status !== "ok").map((x) => x.address);
      if (miss.length) {
        const one = miss.length === 1 ? miss[0] : null;
        const label = one ? userName(d.to.concat(d.cc, d.bcc).find((a) => bareAddress(a).toLowerCase() === one) ?? one) : "";
        const choice = await choose({
          title: t("compose.dlg.noEncryptTitle"),
          body: one
            ? t("compose.dlg.noKeyOne", { addr: one })
            : miss.length > 3
              ? t("compose.dlg.noKeyManyMore", { list: miss.slice(0, 3).join(", "), n: miss.length - 3 })
              : t("compose.dlg.noKeyMany", { list: miss.join(", ") }),
          choices: [
            { id: "cancel", label: t("common.cancel") },
            ...(one && d.to.length + d.cc.length + d.bcc.length > 1 ? [{ id: "remove", label: t("compose.dlg.removeAndSend", { name: label }), kind: "primary" as const }] : []),
            { id: "plain", label: t("compose.dlg.sendUnencrypted"), kind: "danger" as const },
          ],
        });
        if (choice === "cancel") return null;
        if (choice === "remove" && one) {
          const keep = (list: string[]) => list.filter((a) => bareAddress(a).toLowerCase() !== one);
          out = { ...out, to: keep(out.to), cc: keep(out.cc), bcc: keep(out.bcc) };
        } else sec = { ...sec, encrypt: false };
      }
    }
    if (sec.sign && r?.own && !r.own.unlocked) {
      if (!(await askUnlock(r.own.fingerprint, "sign", fromEmail))) return null;
    }
    const final: DraftSecurity | undefined = sec.encrypt || sec.sign ? sec : undefined;
    return { ...out, security: final };
  };

  // What the server gets is the base64 text of every file in lines of 76 + part headers (about 4/3 more than the files): that is what the limit
  // is checked against and what is shown (G-07). The limit is the smaller of the usual 25 MB and the server's SIZE (smtpsize.rs); the server is
  // asked when the message is opened, when the account or the attachments change and before Send (the backend remembers the answer for a while).
  const [serverMax, setServerMax] = useState<Record<string, number | null>>({});
  const askingLimit = useRef<Partial<Record<string, Promise<number | null>>>>({});
  const askServerLimit = (id: string, refresh = false): Promise<number | null> => {
    if (!id) return Promise.resolve(null);
    // (one question at a time per account; a refresh after a refused send is always a new one)
    if (!refresh && askingLimit.current[id]) return askingLimit.current[id];
    const asked = api
      .smtpSizeLimit(id, refresh)
      .catch(() => null)
      .then((v) => (setServerMax((m) => ({ ...m, [id]: v })), v))
      .finally(() => {
        if (askingLimit.current[id] === asked) delete askingLimit.current[id];
      });
    askingLimit.current[id] = asked;
    return asked;
  };
  const limit = sendLimit(serverMax[accountId]);
  /** The one sentence for a message that is over the limit: "Attachments total 5.2 MB when sent; the limit for this account's server is 4.8 MB" (the server's own number), else the usual 25 MB wording. */
  const tooBigText = (size: number, lim: { bytes: number; fromServer: boolean }) =>
    t(lim.fromServer ? "compose.att.tooBigServer" : "compose.att.totalTooBig", { size: fmtSize(size), limit: fmtSize(lim.bytes) });
  /** Shows it as THE size toast: an earlier one (files were added, then Send was pressed) goes, so one message is on the screen, never two (QA round 20 BUG-02). */
  const lastSizeToast = useRef<{ id: number | null }>({ id: null });
  const showSizeError = (text: string | (() => string)) =>
    showSizeToast(
      { showToast, dismissToast: useStore.getState().dismissToast, lastToastId: () => {
          const ts = useStore.getState().toasts;
          return ts.length ? ts[ts.length - 1].id : null;
        } },
      lastSizeToast.current,
      text,
    );
  const wireOf = (files: Att[], picBytes: number, picCount: number) =>
    wireSize({ attachments: files.map((a) => ({ filename: a.filename, base64Length: a.dataBase64.length })), pictures: picCount ? [picBytes] : [], encrypted: encOn });
  const attBytes = wireOf(atts, 0, 0);
  const totalBytes = wireOf(atts, pics.bytes, pics.count);
  // going over the limit by adding files or pictures says so once (and again after the message was back under it)
  const overShown = useRef(false);
  const over = totalBytes > limit.bytes;
  useEffect(() => {
    if (over && !overShown.current && touched.current) showSizeError(() => tooBigText(totalBytes, limit));
    overShown.current = over;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  // (BUG-16: it used to be asked only for a message above 8 MiB, so a server that takes 5 MB was never found)
  useEffect(() => {
    void askServerLimit(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, atts.length, pics.count]);
  /** attachments whose type Gmail, Outlook and Yahoo reject */
  const blockedAtts = atts.map((a) => ({ name: a.filename, ext: blockedAttachmentExt(a.filename) })).filter((a) => a.ext);

  /** A scheduled message opened for editing keeps its pause until it is saved, moved, sent or released. */
  useEffect(
    () => () => {
      if (init.outboxId && !savedRef.current) void api.outboxRelease(init.outboxId).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Bytes of a finished draft on the wire (headers, text, files and pictures). */
  const draftWire = (d: Draft) =>
    wireSize({
      attachments: d.attachments.map((a) => ({ filename: a.filename, base64Length: a.dataBase64.length })),
      pictures: (d.inline ?? []).map((i) => Math.floor((i.dataBase64.length * 3) / 4)),
      htmlLength: d.html.length,
      textLength: d.text.length,
      encrypted: !!d.security?.encrypt,
    });

  /**
   * The error text when the message, as it goes on the wire (base64 + headers + the body), is over what the server takes; null when it
   * fits. The server is asked for its SIZE first (smtpsize.rs; for a message with files always afresh, else from the backend's minute of memory); without an
   * answer within 10 seconds the limit known so far applies (the usual 25 MB).
   */
  const sizeProblem = async (d: Draft): Promise<(() => string) | null> => {
    const wire = draftWire(d);
    const fresh = askFreshBeforeSend(d.attachments.length, (d.inline ?? []).length);
    const max = await Promise.race([askServerLimit(d.accountId, fresh), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    const lim = sendLimit(max ?? serverMax[d.accountId]);
    return wire > lim.bytes ? () => tooBigText(wire, lim) : null;
  };

  /**
   * The toast for a send that failed. A refusal for the size says the same clear sentence as the check before Send, with the size of the
   * message and the limit of the server (asked again, a refused send is the moment to know it); any other error keeps its own text.
   */
  const sendFailedText = async (e: unknown, d: Draft): Promise<() => string> => {
    if (isSizeRefusal(e)) {
      const wire = draftWire(d);
      const lim = sendLimit(await askServerLimit(d.accountId, true));
      // the server refused although the limit is unknown or bigger than the estimate: its own reply (translated) says it
      if (wire > lim.bytes) return () => tooBigText(wire, lim);
    }
    return () => t("compose.toast.sendFailed", { error: friendlyError(e) });
  };

  const sendNowFromEditor = async () => {
    if (!init.outboxId) return;
    const built = buildDraft();
    const tooBig = await sizeProblem(built);
    if (tooBig) return showSizeError(tooBig);
    const d = await secureDraft(built);
    if (!d) return;
    setBusy(true);
    try {
      await api.cancelOutbox(init.outboxId);
      savedRef.current = true;
      setComposeDirty(false);
      void openCompose(null);
      const done = beginSend();
      try {
        await api.sendMessage(d, null, null);
      } finally {
        done();
      }
      if (useStore.getState().prefs.sentSound) playSent();
      showToast(t("compose.toast.sent"), undefined, "success");
      void refresh();
    } catch (e) {
      setBusy(false);
      showToast(await sendFailedText(e, d), undefined, "error"); // i18n-ok: sendFailedText gives a function
      reopen(d);
    }
  };

  /** The message is safe (in the outbox, handed to the server) or came back to Compose: its snapshot is not needed any more. */
  const finishSend = () => {
    sendingRef.current = false;
    void writer.clear();
  };

  const send = async (sendAt?: number) => {
    let d = buildDraft();
    // To may stay empty when Cc or Bcc has someone (Gmail and Outlook allow it; a Bcc-only message shows undisclosed-recipients)
    if (!hasRecipient(d)) return showToast(() => t("compose.err.noRecipient"), undefined, "error");
    const bad = [...d.to, ...d.cc, ...d.bcc].filter((a) => !EMAIL.test(bareAddress(a)));
    if (bad.length) return showToast(() => t("compose.err.checkAddress", { addr: bad[0] }), undefined, "error");
    if (meeting) {
      const md = meetingToDraft(meeting, calTz(prefs));
      if ("error" in md) return showToast(() => t(md.errorKey), undefined, "error"); // (the key, so the toast follows a language switch)
      if (d.bcc.length) return showToast(() => t("compose.err.meetingBcc"), undefined, "error");
      if (!d.subject.trim()) return showToast(() => t("compose.err.meetingSubject"), undefined, "error");
    }
    if (!accountId) return showToast(() => t("compose.err.noAccount"), undefined, "error");
    const tooBig = await sizeProblem(d);
    if (tooBig) return showSizeError(tooBig);
    if (!d.subject && !(await confirm({ title: t("compose.dlg.noSubject"), confirmLabel: t("compose.dlg.sendAnyway") }))) return;
    if (
      blockedAtts.length &&
      !(await confirm({
        title: t(blockedAtts.length === 1 ? "compose.dlg.blockedTitleOne" : "compose.dlg.blockedTitleMany"),
        body: t("compose.dlg.blockedBody", { names: [...new Set(blockedAtts.map((a) => a.name))].slice(0, 3).join(", "), types: [...new Set(blockedAtts.map((a) => a.ext))].join(", ") }),
        confirmLabel: t("compose.dlg.sendAnyway"),
      }))
    )
      return;
    const secured = await secureDraft(d);
    if (!secured) return;
    d = secured;
    if (!hasRecipient(d)) return showToast(() => t("compose.err.noRecipient"), undefined, "error");

    if (sendAt) {
      if (sendAt * 1000 < Date.now() - 60_000) return showToast(() => t("compose.schedule.passed"), undefined, "error");
      await settleSaves(); // (an autosave that is running tells which draft this message replaces)
      sendingRef.current = true; // the snapshot stays until the message is in the queue
      setBusy(true);
      setComposeDirty(false);
      void openCompose(null, { sending: 0 });
      try {
        if (init.outboxId) {
          await api.outboxUpdate(init.outboxId, d, sendAt);
          savedRef.current = true;
          showToast(t("compose.toast.rescheduled", { when: fmtWhen(sendAt) }), undefined, "success");
        } else {
          const done = beginSend();
          const res = await api
            .sendMessage(d, sendAt, replacesRef())
            // (a window of its own ends now: the main window, which owns the outbox, makes the toast with Undo and View)
            .then((r) => (r.startsWith("scheduled:") && composeSeam()?.scheduled(r.slice("scheduled:".length), sendAt), r))
            .finally(done);
          savedRef.current = true;
          const id = res.startsWith("scheduled:") ? res.slice("scheduled:".length) : null;
          const st = useStore.getState();
          if (!(id && composeSeam()))
            showToast(
              () => t("compose.toast.scheduled", { when: fmtWhen(sendAt) }),
              id
                ? () => {
                    void api.cancelOutbox(id).then(() => reopen(d)).catch((e) => showToast(() => friendlyError(e), undefined, "error"));
                  }
                : undefined,
              "success",
              [{ label: () => t("compose.toast.view"), run: () => void st.setView("scheduled") }],
            );
        }
        void refresh();
      } catch (e) {
        const code = errorCode(e);
        showToast(() => code === "SCHEDULE_IN_PAST" ? friendlyError(e) : t("compose.toast.scheduleFailed", { error: friendlyError(e) }), undefined, "error");
        reopen(d);
      } finally {
        finishSend();
      }
      return;
    }

    await settleSaves();
    sendingRef.current = true; // the snapshot stays until the message is in the outbox (Undo time) or was handed to the server
    setBusy(true);
    setComposeDirty(false);
    const wait = eff(prefs, accountId, "undoSeconds");
    void openCompose(null, { sending: wait });
    let cancelled = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // With an Undo time the message is in the local outbox from now on (REQ-49): a quit, a kill or an installer that ends the app in the
    // Undo time no longer loses it, the next start sends it. Without one it is sent at once as before.
    let heldId: string | null = null;
    if (wait > 0) {
      try {
        heldId = await api.outboxHold(d, Math.floor(Date.now() / 1000) + wait, replacesRef());
      } catch (e) {
        showToast(() => t("compose.toast.sendFailed", { error: friendlyError(e) }), undefined, "error");
        finishSend();
        reopen(d);
        return;
      }
      finishSend(); // it is in the local outbox now: a kill no longer loses it
    }
    const run = async () => {
      if (cancelled || started) return;
      started = true;
      clearTimeout(timer);
      const quitting = useStore.getState().quitting;
      try {
        if (heldId) await api.outboxHoldSend(heldId, quitting);
        else await api.sendMessage(d, null, replacesRef());
        if (useStore.getState().prefs.sentSound) playSent();
        showToast(t("compose.toast.sent"), undefined, "success");
        void useStore.getState().sync();
      } catch (e) {
        // quitting: the message stays in the outbox and goes out at the next start (REQ-48 c), nothing is reopened
        if (quitting) return;
        showToast(await sendFailedText(e, d), undefined, "error"); // i18n-ok: sendFailedText gives a function // i18n-ok: sendFailedText gives a function
        reopen(d);
      } finally {
        done();
        finishSend();
      }
    };
    // counted as "being sent" from the start of the undo window until the server answered (an update restart waits for it; a quit sends it at once)
    const done = beginSend(() => void run());
    timer = setTimeout(() => void run(), wait * 1000);
    if (wait > 0) {
      const undoSend = () => {
        // Undo: the message leaves the outbox (if it is already being sent it cannot be taken back)
        if (heldId) {
          void api.cancelOutbox(heldId).then(
            () => {
              cancelled = true;
              clearTimeout(timer);
              done();
              reopen(d);
            },
            (e) => showToast(() => friendlyError(e), undefined, "error"),
          );
          return;
        }
        cancelled = true;
        clearTimeout(timer);
        done();
        reopen(d);
      };
      // in a window of its own the Undo button of the window's card takes the message back; in the main window it is the toast's
      const seam = composeSeam();
      if (seam) seam.undoOffer(undoSend);
      else showToast(() => t("compose.toast.sending"), undoSend, "info");
    }
  };

  const saveDraft = useCallback(
    // `onSaved`: the caller (leaving this message, F-21) makes the toast itself, with an Edit button, once the pane is closed
    // `auto`: the autosave. It makes no toast, does not close the pane, does not count as "saved" for the leave / quit / restart flows (they save
    // once more, which replaces this draft) and leaves the error line of those flows alone.
    async (close: boolean, quiet = false, onSaved?: (d: SavedDraft) => void, auto = false): Promise<boolean> => {
      if (init.outboxId) return true; // a scheduled message is not a draft; "Move to Drafts" does that
      const rev = revRef.current;
      savingRef.current++;
      try {
        const d = buildDraft();
        // a draft is only ever encrypted to your own key (no passphrase needed), and never signed
        const keepPrivate = !!d.security?.encrypt && eff(prefs, accountId, "pgpEncryptDrafts");
        const saved = await api.saveDraft({ ...d, security: keepPrivate ? { encrypt: true, sign: false, attachPublicKey: false } : undefined }, replacesRef());
        const tid = saved.threadId;
        if (tid) {
          savedTid.current = tid;
          composeSeam()?.draftSaved(tid);
        }
        if (saved.draftRef) savedDraftRef.current = saved.draftRef;
        // the draft on the server holds everything up to `rev`: the snapshot is not needed for it any more
        savedRevRef.current = rev;
        changedAtRef.current = revRef.current === rev ? 0 : Date.now();
        if (revRef.current === rev) {
          snapRevRef.current = rev;
          void writer.release();
        }
        if (auto) {
          failuresRef.current = 0;
          setAutosavedAt(Date.now());
          return true;
        }
        useStore.setState({ draftError: "" });
        const plain = !!d.security?.encrypt && !keepPrivate;
        if (onSaved) {
          onSaved({
            plain,
            edit: () => {
              if (!tid) return showToast(() => tNow("compose.leave.draftNotFound"), undefined, "error");
              void openDraftThread(tid, true).catch((e) => showToast(() => friendlyError(e), undefined, "error"));
            },
          });
        } else {
          showToast(() => plain ? t("compose.toast.draftSavedPlain") : t("compose.toast.draftSaved"), undefined, plain ? "info" : "success");
        }
        // typed while the draft was on its way: it is not saved yet
        if (revRef.current === rev) setComposeDirty(false);
        if (close) void openCompose(null);
        void useStore.getState().sync();
        return true;
      } catch (e) {
        if (auto) return false; // (the next try is later, see autosaveDue; the snapshot keeps the text meanwhile)
        // `quiet`: the caller (an update restart, a quit) tells the user itself
        useStore.setState({ draftError: friendlyError(e).replace(/\.$/, "") });
        if (!quiet) showToast(() => t("compose.toast.saveFailed", { error: friendlyError(e) }), undefined, "error");
        return false;
      } finally {
        savingRef.current--;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [to, cc, bcc, subject, atts, accountId, sigId, editor, encOn, signActive, attachKey, confidential, importance],
  );

  const moveToDrafts = async () => {
    if (!init.outboxId) return;
    try {
      await api.outboxToDraft(init.outboxId);
      savedRef.current = true;
      setComposeDirty(false);
      showToast(t("compose.toast.movedToDrafts"), undefined, "success");
      void openCompose(null);
      void refresh();
    } catch (e) {
      showToast(() => t("compose.toast.moveFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };

  // let the store save this draft when another message is opened over it
  useEffect(() => {
    setComposeSaver((o) => saveDraft(false, o?.quiet, o?.onSaved));
  }, [saveDraft, setComposeSaver]);

  /** The form of this message for the crash-recovery snapshot: the body as the editor has it (signature included, pictures as data: URIs). */
  const snapshotForm = () => {
    if (!editor) return null;
    const html = messageHtml(editor.getJSON(), { sig: chosenSig?.html ?? null, base, pictures: "data" }).html;
    // an address typed and not yet confirmed is kept too (the snapshot is the safety net for a crash, not a message to send)
    const withPending = (list: string[], k: "to" | "cc" | "bcc") => addRecipients(list, splitRecipients(pendingRcpt.current[k]));
    const form: RecoveryForm = {
      v: 1, to: withPending(to, "to"), cc: withPending(cc, "cc"), bcc: withPending(bcc, "bcc"), subject, html,
      inReplyTo: init.inReplyTo ?? null, references: init.references ?? [], replaces: replacesRef(), isReply: !!init.isReply,
      encrypt: encIntent, sign: signOn, attachKey, confidential, importance: draftImportance(importance),
      ...(composeSeam() ? { win: true as const } : {}),
    };
    return { accountId, subject, preview: editor.getText().trim().slice(0, 160), payload: JSON.stringify(form) };
  };
  /** What names these attachments, worked out once per change of the list (they can be megabytes): equal key = equal attachments. */
  const attachmentsKey = () => {
    if (filesKeyRef.current?.atts !== atts) {
      const fnv = (str: string) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
        return (h >>> 0).toString(16);
      };
      filesKeyRef.current = { atts, key: atts.map((a) => `${a.filename}|${a.mime}|${a.dataBase64.length}|${fnv(a.dataBase64)}`).join(";") };
    }
    return filesKeyRef.current.key;
  };
  const writeSnapshot = (force = false) => {
    // anything in To / Cc / Bcc / Subject / the body is worth a snapshot: it is a local file, nothing goes to the server for it
    const p = { ...probe(), hasContent: probe().hasContent || !!(pendingRcpt.current.to + pendingRcpt.current.cc + pendingRcpt.current.bcc).trim() };
    const size = (editor?.state.doc.content.size ?? 0) + (pics.bytes ?? 0);
    const due = force
      ? p.hasContent && !init.outboxId && !encOn && revRef.current !== snapRevRef.current
      : snapshotDue({ now: Date.now(), rev: revRef.current, snapRev: snapRevRef.current, lastWriteAt: snapAtRef.current, size, hasContent: p.hasContent, scheduled: !!init.outboxId, encrypted: encOn }, timing().snapshotMs);
    if (!due) return;
    const form = snapshotForm();
    if (!form) return;
    snapRevRef.current = revRef.current;
    snapAtRef.current = Date.now();
    writer.write(form, attachmentsKey(), () => atts);
  };
  const autosaveFacts = (why: AutosaveWhy) => {
    const p = probe();
    return {
      now: Date.now(), why, rev: revRef.current, savedRev: savedRevRef.current, changedAt: changedAtRef.current, lastTryAt: lastTryRef.current,
      failures: failuresRef.current, hasContent: p.hasContent, attaching: p.attaching, saving: savingRef.current > 0, sending: sendingRef.current || poppingRef.current,
      scheduled: !!init.outboxId, plainWouldLeak: encOn && !eff(prefs, accountId, "pgpEncryptDrafts"),
    };
  };
  const autosave = async (why: AutosaveWhy) => {
    if (!autosaveDue(autosaveFacts(why), timing().autosaveMs)) return;
    lastTryRef.current = Date.now();
    const ok = await saveDraft(false, true, undefined, true);
    if (!ok) failuresRef.current++;
  };
  // a second by second look (the timers of autosave.ts decide), and the moments the person leaves the window
  const tickRef = useRef<() => void>(() => undefined);
  tickRef.current = () => {
    writeSnapshot();
    void autosave("tick");
  };
  const awayRef = useRef<(why: AutosaveWhy) => void>(() => undefined);
  awayRef.current = (why) => {
    writeSnapshot(true);
    void autosave(why);
  };
  useEffect(() => {
    if (init.outboxId) return;
    const timer = setInterval(() => tickRef.current(), 1000);
    const away = () => awayRef.current(document.visibilityState === "hidden" ? "hidden" : "blur");
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", away);
    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", away);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a restored message is something the person has not saved: it counts as changed from the start
  useEffect(() => {
    if (init.recoveryId || init.carried) touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the subject is the title of a window of its own
  useEffect(() => {
    composeSeam()?.title(subject);
  }, [subject]);

  /** Wait until the saves that are running have finished (a send / discard must know which draft the last one made). */
  const settleSaves = async () => {
    for (let i = 0; i < 200 && savingRef.current > 0; i++) await new Promise((r) => setTimeout(r, 50));
  };
  // The message in this pane is over without a send (the store tells us): no snapshot, and for Discard no draft an autosave made of a new message
  useEffect(() => {
    useStore.getState().setComposeEnd(async (o) => {
      await settleSaves();
      if (o?.dropDraft) await dropSavedCopy();
      await writer.clear();
    });
    return () => useStore.getState().setComposeEnd(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The pane goes away: the snapshot goes with it, unless the message is on its way out (then it stays until the send is safe, see `send`).
  // A kill or a crash does not run this: that is what the snapshot is for.
  useEffect(() => {
    writer.open();
    return () => {
      if (!sendingRef.current) void writer.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // what leaving this message needs to know: did the person write anything, are files still coming in
  const probe = (): ComposeProbe => {
    const b = baseline.current;
    const text = editor?.getText().trim() ?? "";
    const restored = !!init.recoveryId || !!init.carried;
    const base = restored ? [] : init.to ?? [];
    const hasContent =
      touched.current &&
      (text !== (b?.text ?? "") ||
        (editor ? bodyPictures(editor) : 0) !== (b?.pics ?? 0) ||
        to.length !== base.length || to.some((x, i) => x !== base[i]) ||
        cc.length > (restored ? 0 : init.cc?.length ?? 0) || bcc.length > (restored ? 0 : init.bcc?.length ?? 0) ||
        subject.trim() !== (restored ? "" : init.subject ?? "").trim() ||
        atts.length !== (restored ? 0 : init.attachments?.length ?? 0));
    return { hasContent, attaching: attachingRef.current > 0, rev: revRef.current };
  };
  const probeRef = useRef(probe);
  probeRef.current = probe;
  useEffect(() => {
    setComposeProbe(() => probeRef.current());
    return () => setComposeProbe(null);
  }, [setComposeProbe]);
  // only when the composer goes away: forget the saver and the "unsaved" flag
  useEffect(
    () => () => {
      setComposeSaver(null);
      setComposeDirty(false);
    },
    [setComposeSaver, setComposeDirty],
  );

  const discard = async () => {
    if (init.outboxId) {
      const choice = await choose({
        title: t("compose.dlg.cancelScheduledTitle"),
        body: t("compose.dlg.cancelScheduledBody", { subject: subject || t("compose.noSubject") }),
        choices: [
          { id: "keep", label: t("compose.dlg.keepScheduled") },
          { id: "drafts", label: t("compose.dlg.moveToDrafts") },
          { id: "delete", label: t("common.delete"), kind: "danger" },
        ],
      });
      if (choice === "keep") {
        setComposeDirty(false);
        return void openCompose(null);
      }
      try {
        if (choice === "delete") await api.cancelOutbox(init.outboxId);
        else await api.outboxToDraft(init.outboxId);
        savedRef.current = true;
        setComposeDirty(false);
        showToast(choice === "delete" ? t("compose.toast.scheduleCancelled") : t("compose.toast.movedToDrafts"), undefined, "success");
        void openCompose(null);
        void refresh();
      } catch (e) {
        showToast(() => friendlyError(e), undefined, "error");
      }
      return;
    }
    const dirty = touched.current && ((editor?.getText().trim().length ?? 0) > 0 || to.length > 0 || subject.trim() || atts.length > 0);
    if (dirty && !(await confirm({ title: t("compose.dlg.discardTitle"), body: t("compose.dlg.discardBody"), confirmLabel: t("compose.dlg.discard"), danger: true }))) return;
    await dropSavedCopy();
    setComposeDirty(false);
    void openCompose(null);
  };

  /** A new message that a save made a draft of (a Save draft that was not closed, a later save of a leave): discarding it takes that draft away too. */
  const dropSavedCopy = async () => {
    const ref = savedDraftRef.current;
    if (!ref || init.replaces) return; // a draft that was opened stays: it existed before this message was written
    savedDraftRef.current = null;
    await api.discardDraft(ref).catch(() => undefined);
  };

  /** Files and pictures are read in the background: leaving this message (F-21) waits for the ones still coming in. */
  const reading = async <T,>(job: () => Promise<T>): Promise<T> => {
    attachingRef.current++;
    try {
      return await job();
    } finally {
      attachingRef.current--;
    }
  };

  const addFiles = (files: FileList | File[] | null) => reading(() => addFilesNow(files));
  const addFilesNow = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list: Att[] = [];
    for (const f of Array.from(files)) list.push({ filename: outgoingName(f.name || "pasted-image.png"), mime: f.type || "application/octet-stream", dataBase64: await fileToBase64(f) });
    setAtts((a) => [...a, ...list]); // (the size warning is the effect below: a state updater must not show toasts)
    touch();
  };
  addFilesRef.current = async (files: File[]) => addFiles(files);

  /** A picture file into the body at the caret (Medium size), or attached when the format is not supported. */
  const insertPictures = (files: File[]) => reading(() => insertPicturesNow(files));
  const insertPicturesNow = async (files: File[]) => {
    const st = useStore.getState();
    const attach: File[] = [];
    for (const f of files) {
      if (!PICTURE_TYPES.includes(f.type)) {
        attach.push(f);
        continue;
      }
      let src: string;
      let size: { w: number; h: number };
      try {
        src = await readDataUrl(f);
        size = await imageSize(src);
      } catch {
        showToast(() => t("compose.pic.unsupported", { name: f.name }), undefined, "error");
        attach.push(f);
        continue;
      }
      let finalSrc = src;
      if (f.size > LARGE_PICTURE) {
        if (st.prefs.autoResizePictures) {
          const r = await resizeImage(src, f.type, 1600);
          finalSrc = r.dataUrl;
          showToast(t("compose.pic.resized", { name: f.name, size: fmtSize(dataUriBytes(finalSrc)) }), undefined, "success");
        } else {
          const original = src;
          showToast(
            () => t("compose.pic.askResize", { size: fmtSize(f.size), w: size.w, h: size.h }),
            undefined,
            "info",
            [{ label: () => t("compose.pic.resize"), run: () => void resizeInEditor(original, f.type, f.name) }],
          );
        }
      }
      editor?.chain().focus().insertContent({ type: "image", attrs: { src: finalSrc, alt: "", "data-name": f.name, width: size.w > MEDIUM ? MEDIUM : null } }).run();
    }
    if (attach.length) {
      await addFiles(attach);
      if (files.length > attach.length) showToast(t("compose.pic.filesAttached", { n: attach.length }), undefined, "info");
    }
    touch();
  };

  /** Replace the picture (matched by its data: URI) with a 1600 px version. */
  const resizeInEditor = async (original: string, mime: string, name: string) => {
    if (!editor) return;
    const r = await resizeImage(original, mime, 1600);
    let at: number | null = null;
    editor.state.doc.descendants((n, pos) => {
      if (at === null && n.type.name === "image" && n.attrs.src === original) at = pos;
    });
    if (at === null) return;
    editor.chain().setNodeSelection(at).updateAttributes("image", { src: r.dataUrl }).run();
    showToast(t("compose.pic.resized", { name, size: fmtSize(dataUriBytes(r.dataUrl)) }), undefined, "success");
  };

  const setPictureSize = (w: number | null) => {
    if (!picSel || !editor) return;
    editor.chain().setNodeSelection(picSel.pos).updateAttributes("image", { width: w }).run();
  };

  const setPictureAlign = (a: "center" | "right" | null) => {
    if (!picSel || !editor) return;
    editor.chain().focus().setNodeSelection(picSel.pos).updateAttributes("image", { align: a }).run(); // (the editor has the focus again: Ctrl+K links the picture next)
  };

  const savePictureAlt = () => {
    if (!picSel || !editor) return;
    editor.chain().setNodeSelection(picSel.pos).updateAttributes("image", { alt: altText.trim() }).run();
    setAltOpen(false);
    touch();
  };

  /** A picture from the body becomes a plain attachment. */
  const pictureAsAttachment = () => {
    if (!picSel || !editor) return;
    const src = (editor.state.doc.nodeAt(picSel.pos)?.attrs.src as string | undefined) ?? "";
    const parts = dataUriParts(src);
    editor.chain().setNodeSelection(picSel.pos).deleteSelection().run();
    if (parts) {
      const ext = parts.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "img";
      setAtts((a) => [...a, { filename: outgoingName(picSel.name !== "picture" ? picSel.name : `picture.${ext}`), mime: parts.mime, dataBase64: parts.b64 }]);
    }
    setPicSel(null);
    touch();
  };

  const removePicture = () => {
    if (!picSel || !editor) return;
    editor.chain().setNodeSelection(picSel.pos).deleteSelection().run();
    setPicSel(null);
    setAltOpen(false);
  };

  /** Drop on the top zone = into the message, bottom zone = attach. Other files never go into the body. */
  const dropOn = (zone: "top" | "bottom", files: FileList | null) => {
    setDragging(false);
    setDragImages(false);
    setHotZone(null);
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    if (zone === "top") {
      const images = all.filter((f) => PICTURE_TYPES.includes(f.type));
      const rest = all.filter((f) => !PICTURE_TYPES.includes(f.type));
      if (images.length) void insertPictures(images);
      if (rest.length) {
        void addFiles(rest);
        showToast(t("compose.pic.filesAttached", { n: rest.length }), undefined, "info");
      }
      return;
    }
    void addFiles(all);
  };

  const applyTemplate = (tpl: Template) => {
    if (tpl.subject && !subject) setSubject(tpl.subject);
    editor?.commands.insertContent(tpl.body);
    touch();
  };

  const letAiWrite = async () => {
    if (!aiPrompt.trim()) return;
    // the draft and the reply context quote confidential mail
    if (init.confidential) return showToast(t("compose.ai.confidential"), undefined, "info");
    // i18n-ok: the prompt for the model, not UI text
    const context = init.isReply ? `\n\nThe email being replied to:\n${htmlToText(init.bodyHtml ?? "").slice(0, 6000)}` : "";
    const out = await ai.run(
      // i18n-ok: a prompt for the language model, not text the person reads
      "You write email bodies. Output only the email body text (no subject line, no preamble). Match the language of the user's request and the tone requested.",
      `Subject: ${subject}\nExisting draft:\n${editor?.getText() ?? ""}${context}\n\nInstruction: ${aiPrompt}`,
    );
    if (!out) return; // a click while one is under way, Cancel, or this window closed: nothing to apply
    if ("error" in out) {
      showAiProblem(out.error, { feature: "write", retry: () => void letAiWrite(), tied: true });
      return;
    }
    editor?.commands.insertContentAt(0, out.text.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;")}</p>`).join(""));
    setAiOpen(false);
    setAiPrompt("");
    touch();
  };

  /** The "Write with AI" button: closing the bar while a text is being written drops the request (the bar is where Cancel is). */
  const toggleAi = () => {
    if (!aiConfigured) {
      // not set up: the toast says so and leads to Settings (the flag is read again first: it may have been set in another window)
      void aiReady().then((ok) => (ok ? setAiOpen(true) : showAiNotSetUp("write")));
      return;
    }
    if (aiOpen) ai.cancel();
    setAiOpen((o) => !o);
  };
  // the "Try again" of a failed text is for this message: it goes when the message is closed
  useEffect(() => () => leaveAiContext("write"), []);

  const keyAction = (a: "import" | "paste") => setDialog({ type: "pgp-import", paste: a === "paste" });

  // the security strip: what will happen to this message on Send, and why Encrypt may have turned itself off
  const ownExpired = !!own && own.expired;
  const nUnique = allAddrs.length;
  const firstMissing = noKeyAddrs[0];
  const strip: { cls: string; icon: React.ReactNode; body: React.ReactNode; actions?: React.ReactNode } | null = (() => {
    if (!own) return null;
    if ((encOn || signActive) && (ownExpired || (encOn && !canEnc))) {
      return { cls: "warn", icon: <TriangleAlert size={15} />, body: <>{t("compose.sec.keyExpired")}</>, actions: <button className="link" onClick={() => setDialog({ type: "settings", tab: "pgp" })}>{t("compose.sec.openSettings")}</button> };
    }
    if (encOn && noKeyAddrs.length > 0) {
      const st = ks?.recipients[firstMissing]?.status;
      return {
        cls: "warn",
        icon: <TriangleAlert size={15} />,
        body: <>{st === "expired" ? tx("compose.sec.theirExpired", { addr: <b>{firstMissing}</b> }) : st === "revoked" ? tx("compose.sec.theirRevoked", { addr: <b>{firstMissing}</b> }) : noKeyAddrs.length > 1 ? tx("compose.sec.noKeyMore", { addr: <b>{firstMissing}</b> }, { n: noKeyAddrs.length - 1 }) : tx("compose.sec.noKey", { addr: <b>{firstMissing}</b> })}</>,
        actions: (
          <>
            <button className="link" onClick={() => keyAction("import")}>{t("compose.rcpt.importKey")}</button><span className="muted">·</span>
            <button className="link" onClick={() => (setEncIntent("off"), touch())}>{t("compose.sec.turnOffEncrypt")}</button>
          </>
        ),
      };
    }
    if (encOn) {
      return {
        cls: "",
        icon: <ShieldCheck size={15} />,
        body: nUnique === 0
          ? <>{t(signActive ? "compose.sec.willBeEncryptedSigned" : "compose.sec.willBeEncrypted")}</>
          : <>{t(signActive ? "compose.sec.encryptedSigned" : "compose.sec.encrypted", { n: nUnique })}</>,
        actions: <button className="link" onClick={() => setSecDetails((o) => !o)} aria-expanded={secDetails}>{t("compose.sec.details")}</button>,
      };
    }
    if (autoOff) {
      return {
        cls: "off",
        icon: <Info size={15} />,
        body: <>{tx(signActive ? "compose.sec.autoOffSigned" : "compose.sec.autoOff", { addr: <b>{firstMissing}</b> })}</>,
        actions: <button className="link" onClick={() => (setEncIntent("on"), touch())}>{t("compose.sec.encryptAnyway")}</button>,
      };
    }
    if (signActive) return { cls: "", icon: <ShieldCheck size={15} />, body: <>{t("compose.sec.signedOnly")}</> };
    return null;
  })();

  const draftsHint = init.replaces;
  const schedInitial = init.sendAt;
  const pastDue = !!init.outboxId && !!init.sendAt && init.sendAt * 1000 < Date.now() - 60_000;
  const imgSelected = !!picSel;

  // a small pane (composeFit.ts) keeps these actions in "More actions" (the row of buttons has no room for them); a dot on the button says one is on
  const moreOn = !!meeting || encOn || signActive || confidential || importance !== "normal" || aiOpen;
  const moreItems: MenuItem[] = [
    { label: t("compose.bar.picture"), icon: <ImagePlus size={14} />, hint: kbd("Ctrl+Shift+P"), title: kbd(t("compose.bar.insertPictureTip")), onClick: () => picRef.current?.click() },
    { divider: true },
    { label: t("compose.bar.meeting"), icon: <CalendarPlus size={14} />, checked: !!meeting, title: t("compose.bar.meetingTip"), onClick: toggleMeeting },
    { label: t("compose.bar.encrypt"), icon: encOn ? <Lock size={14} /> : <LockOpen size={14} />, checked: encOn, hint: kbd("Ctrl+Shift+E"), title: encTitle, onClick: toggleEncrypt },
    { label: t("compose.bar.sign"), icon: <BadgeCheck size={14} />, checked: signActive, hint: kbd("Ctrl+Shift+G"), title: own ? kbd(t("compose.bar.signTip")) : encTitle, onClick: toggleSign },
    ...signItems.slice(1), // (the first row is the Sign row above)
    { divider: true },
    { label: t("compose.bar.confidential"), icon: <ShieldAlert size={14} />, checked: confidential, title: confidential ? t("compose.bar.confidentialOnTip") : t("compose.bar.confidentialOffTip"), onClick: () => (setConfidential(!confidential), touch()) },
    { label: t("mail.importance.high"), checked: importance === "high", onClick: () => (setImportance(pressImportance(importance, "high")), touch()) },
    { label: t("mail.importance.low"), checked: importance === "low", onClick: () => (setImportance(pressImportance(importance, "low")), touch()) },
    { divider: true },
    ...(init.outboxId ? [] : [{ label: t("compose.bar.saveDraft"), icon: <Save size={14} />, onClick: () => void saveDraft(true) }]),
    { label: t("compose.bar.templates"), icon: <FileText size={14} />, disabled: true },
    ...(myTemplates.length ? myTemplates.map((tpl) => ({ label: tpl.name, onClick: () => applyTemplate(tpl) })) : [{ label: t("compose.bar.noTemplates"), disabled: true }]),
    { divider: true },
    { label: t("compose.bar.writeWithAi"), icon: <Sparkles size={14} />, checked: aiOpen, disabled: !!init.confidential, title: init.confidential ? t("compose.bar.aiConfidentialTip") : aiConfigured ? t("compose.bar.aiTip") : t("compose.bar.aiSetupTip"), onClick: toggleAi },
  ];

  return (
    <div
      ref={paneRef}
      className={`compose-pane ${dragging ? "dragging" : ""} ${compact ? "compact" : ""} ${compact && barWraps ? "bar-wraps" : ""}`}
      onKeyDown={(e) => {
        if (isImeEvent(e)) return; // a key that belongs to an input method (Subject, To, Cc, Bcc): no app shortcut
        if (isAltGraph(e)) return; // AltGr (Ctrl+Alt) types a character: no app shortcut
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          setSchedOpen(true);
          return;
        }
        // Cc / Bcc are not in the Tab order (Tab from To goes to Subject); Ctrl/Cmd+Shift+C / B show and focus them
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key.toLowerCase() === "c" || (e.key.toLowerCase() === "b" && !meeting))) {
          e.preventDefault();
          const label = e.key.toLowerCase() === "c" ? t("compose.cc") : t("compose.bcc");
          setShowCc(true);
          setTimeout(() => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.focus(), 0);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void (init.outboxId ? send(init.sendAt) : send());
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
          e.preventDefault();
          picRef.current?.click();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o" && !init.outboxId && !composeSeam()) {
          e.preventDefault();
          void popOut();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
          e.preventDefault();
          toggleEncrypt();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "g") {
          e.preventDefault();
          toggleSign();
          return;
        }
        if (imgSelected && (e.ctrlKey || e.metaKey) && ["1", "2", "3", "0"].includes(e.key)) {
          e.preventDefault();
          const sizeFor: Record<string, number | null> = { "1": 240, "2": MEDIUM, "3": 720, "0": null };
          setPictureSize(sizeFor[e.key]);
          return;
        }
        if (imgSelected && e.altKey && e.key === "Enter") {
          e.preventDefault();
          setAltText(picSel?.alt ?? "");
          setAltOpen((o) => !o);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
          const hasImg = Array.from(e.dataTransfer.items).some((i) => i.kind === "file" && PICTURE_TYPES.includes(i.type));
          setDragImages(hasImg);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && (setDragging(false), setDragImages(false), setHotZone(null))}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        // the drop zones handle drops on the pane; this is only the fallback
        dropOn("bottom", e.dataTransfer.files);
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length) {
          e.preventDefault();
          void addFiles(files);
        }
      }}
    >
      {/* the header (actions, banners, fields, strips) is the part that gives way: App.css `.cp-head` scrolls when the pane is low, so the formatting row and the body below are never pushed out of view */}
      <div className="cp-head">
      <div className="cp-bar">
        <div className="split-btn" ref={schedRef}>
          <button className="btn primary" disabled={busy} onClick={() => void (init.outboxId ? send(init.sendAt) : send())} title={init.outboxId ? t("compose.bar.scheduleTip") : kbd(t("compose.bar.sendTip"))}>
            {init.outboxId ? <><CalendarClock size={14} /> <span className="btn-lbl">{t("compose.bar.schedule")}</span></> : meeting ? <><CalendarPlus size={14} /> <span className="btn-lbl">{t("compose.bar.sendInvite")}</span></> : <><Send size={14} /> <span className="btn-lbl">{t("compose.bar.send")}</span></>}
          </button>
          <button
            className="btn primary split-caret"
            aria-label={t("compose.bar.sendLaterOptions")}
            aria-haspopup="dialog"
            aria-expanded={schedOpen}
            title={kbd(t("compose.bar.sendLaterTip"))}
            onClick={() => setSchedOpen((o) => !o)}
          >
            <ChevronDown size={14} />
          </button>
          {schedOpen && (
            <div className="popover up sched-pop pinned" ref={schedPopRef}>
              <SchedulePicker
                initial={schedInitial}
                primaryLabel={t("compose.bar.schedule")}
                busy={busy}
                onPick={(ts) => (setSchedOpen(false), void send(ts))}
                onSendNow={init.outboxId ? () => (setSchedOpen(false), void sendNowFromEditor()) : () => (setSchedOpen(false), void send())}
                onCancel={() => setSchedOpen(false)}
              />
            </div>
          )}
        </div>
        {init.outboxId ? (
          <button className="rb" onClick={() => void moveToDrafts()}><Save size={15} /><span>{t("compose.bar.moveToDrafts")}</span></button>
        ) : null}
        <button className="rb" title={compact ? t("compose.bar.discard") : undefined} onClick={() => void discard()}><Trash2 size={15} /><span>{t("compose.bar.discard")}</span></button>
        <button className="rb" title={compact ? t("compose.bar.attach") : undefined} onClick={() => fileRef.current?.click()}><Paperclip size={15} /><span>{t("compose.bar.attach")}</span></button>
        {!compact && <button className="rb" onClick={() => picRef.current?.click()} title={kbd(t("compose.bar.insertPictureTip"))}><ImagePlus size={15} /><span>{t("compose.bar.picture")}</span></button>}
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ""))} />
        <input
          ref={picRef}
          type="file"
          accept={PICTURE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => (e.target.files && void insertPictures(Array.from(e.target.files)), (e.target.value = ""))}
        />
        {compact ? (
          // a small pane: the rest of the actions in one menu (a dot says that one of them is on)
          <Dropdown className="rb more" caret={false} title={t("compose.bar.more")} items={moreItems}>
            <MoreHorizontal size={15} />
            {moreOn && <i className="more-dot" aria-hidden />}
          </Dropdown>
        ) : (
        <>
        <button
          className={`rb ${meeting ? "on" : ""}`}
          aria-pressed={!!meeting}
          title={t("compose.bar.meetingTip")}
          onClick={toggleMeeting}
        >
          <CalendarPlus size={15} /><span>{t("compose.bar.meeting")}</span>
        </button>
        <button
          className={`rb ${encOn && noKeyAddrs.length === 0 && canEnc ? "on" : encOn ? "warn" : ""}`}
          aria-pressed={encOn}
          aria-disabled={!own}
          title={encTitle}
          onClick={toggleEncrypt}
        >
          {encOn ? <Lock size={15} /> : <LockOpen size={15} />}<span>{t("compose.bar.encrypt")}</span>
        </button>
        <div className="dd" ref={signRef}>
          <button className={`rb ${signActive ? "on" : ""}`} aria-pressed={signActive} aria-disabled={!own} title={own ? kbd(t("compose.bar.signTip")) : encTitle} onClick={toggleSign}>
            <BadgeCheck size={15} /><span>{t("compose.bar.sign")}</span>
          </button>
          <button ref={signCaretRef} className="rb caret" aria-label={t("compose.bar.signOptions")} aria-haspopup="menu" aria-expanded={signMenu} title={t("compose.bar.signOptions")} onClick={() => setSignMenu((o) => !o)}>
            <ChevronDown size={12} />
          </button>
          {/* a menu of its own layer: the header scrolls in a low window and would cut off one that is inside it */}
          {signMenu && <FloatingMenu anchor={signRef} trigger={signCaretRef} minWidth={300} items={signItems} onClose={() => setSignMenu(false)} />}
        </div>
        <button
          className={`rb ${confidential ? "on" : ""}`}
          aria-pressed={confidential}
          title={confidential ? t("compose.bar.confidentialOnTip") : t("compose.bar.confidentialOffTip")}
          onClick={() => (setConfidential(!confidential), touch())}
        >
          <ShieldAlert size={15} /><span>{t("compose.bar.confidential")}</span>
        </button>
        <ImportanceButtons value={importance} onChange={(v) => (setImportance(v), touch())} />
        {!init.outboxId && <button className="rb" onClick={() => void saveDraft(true)}><Save size={15} /><span>{t("compose.bar.saveDraft")}</span></button>}
        <Dropdown
          className="rb"
          items={myTemplates.length ? myTemplates.map((tpl) => ({ label: tpl.name, onClick: () => applyTemplate(tpl) })) : [{ label: t("compose.bar.noTemplates"), disabled: true }]}
        >
          <FileText size={15} /><span>{t("compose.bar.templates")}</span>
        </Dropdown>
        <button
          className={`rb ${aiOpen ? "on" : ""}`}
          disabled={!!init.confidential}
          onClick={toggleAi}
          title={init.confidential ? t("compose.bar.aiConfidentialTip") : aiConfigured ? t("compose.bar.aiTip") : t("compose.bar.aiSetupTip")}
        >
          <Sparkles size={15} /><span>{t("compose.bar.writeWithAi")}</span>
        </button>
        </>
        )}
        <div className="grow" />
        {!init.outboxId && !composeSeam() && (
          <button className="icon-btn" aria-label={t("compose.popout.popOut")} title={kbd(t("compose.popout.popOutTip"))} onClick={() => void popOut()}>
            <ExternalLink size={16} />
          </button>
        )}
      </div>

      {init.outboxId && (
        <div className={`cp-banner ${init.outboxError ? "bad" : ""}`} role="status">
          <CalendarClock size={15} aria-hidden />
          {init.outboxError ? (
            <span>{t("compose.banner.failed", { error: init.outboxError })}</span>
          ) : (
            <span>
              {tx("compose.banner.scheduled", { when: <b>{fmtWhen(init.sendAt ?? Date.now() / 1000)}</b> }, { in: fmtIn(init.sendAt ?? Date.now() / 1000) })}
            </span>
          )}
          <span className="grow" />
          <button className="link" onClick={() => setSchedOpen(true)}>{t("compose.banner.changeTime")}</button>
          <button className="link" onClick={() => void sendNowFromEditor()} disabled={busy}>{t("compose.banner.sendNow")}</button>
          {pastDue && <span className="muted small">{t("compose.banner.passed")}</span>}
        </div>
      )}

      {aiOpen && (
        <div className="cp-ai">
          <textarea
            rows={2}
            autoFocus
            placeholder={init.isReply ? t("compose.ai.placeholderReply") : t("compose.ai.placeholderNew")}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
          />
          <button className="btn primary" disabled={ai.running} onClick={() => void letAiWrite()}>{ai.running ? t("compose.ai.writing") : t("compose.ai.write")}</button>
          {ai.running && <button className="btn" onClick={ai.cancel}>{t("common.cancel")}</button>}
        </div>
      )}

      <div className="cp-fields">
        <div className="cf-field">
          <label>{t("compose.from")}</label>
          <AccountPicker value={accountId} accounts={accounts} onChange={changeAccount} label={t("compose.from")} />
        </div>
        <RecipientField label={t("compose.to")} values={to} onChange={changeField("to")} autoFocus={to.length === 0 && !init.replaces} onTouch={touch} onPending={pending("to")} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
        {noteShown && replyNote && (
          <div className="note cf-replyto" role="status">
            <Info size={13} aria-hidden />
            <span className="grow">
              {t("compose.replyTo.note", { replyTo: replyNote.replyTo.map(chipLabel).join(", "), from: replyNote.from })}{" "}
              <button className="link" onClick={replyToFrom}>{t("compose.replyTo.useFrom", { from: replyNote.from })}</button>
            </span>
          </div>
        )}
        {showCc ? (
          <>
            <RecipientField label={t("compose.cc")} values={cc} onChange={changeField("cc")} onTouch={() => ((ccTouched.current = true), touch())} onPending={pending("cc")} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
            {!meeting && <RecipientField label={t("compose.bcc")} values={bcc} onChange={changeField("bcc")} onTouch={() => ((ccTouched.current = true), touch())} onPending={pending("bcc")} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />}
          </>
        ) : (
          <div className="cf-links">
            {/* tabIndex -1: Tab from To goes to Subject (QA BUG-9); the keys are Ctrl/Cmd+Shift+C and B */}
            <button className="link" tabIndex={-1} title={kbd(t("compose.addCc"))} onClick={() => setShowCc(true)}>{t("compose.cc")}</button>
            {!meeting && <button className="link" tabIndex={-1} title={kbd(t("compose.addBcc"))} onClick={() => setShowCc(true)}>{t("compose.bcc")}</button>}
          </div>
        )}
        <div className="cf-field cf-subject">
          <label>{t("compose.subject")}</label>
          <input value={subject} onChange={(e) => (setSubject(e.target.value), touch())} placeholder={t("compose.subject.placeholder")} aria-label={t("compose.subject")} />
          <ImportanceMark level={importance} size={13} label />
        </div>
      </div>

      {meeting && (
        <>
          <MeetingStrip value={meeting} onChange={(m) => (setMeeting(m), touch())} tz={calTz(prefs)} />
          <div className="note" style={{ padding: "6px 20px 0" }}>
            <Info size={13} aria-hidden /> <span>{t("compose.meeting.note")}</span>
          </div>
        </>
      )}
      {strip && (
        <div className={`sec-strip ${strip.cls}`} role="status" aria-live="polite">
          <span className="sec-ico">{strip.icon}</span>
          <span className="grow">{strip.body}</span>
          {strip.actions}
        </div>
      )}
      {secDetails && encOn && (
        <div className="sec-strip" style={{ display: "block" }}>
          <dl className="kv">
            <dt>{t("compose.sec.encryption")}</dt><dd>{t("compose.sec.encryptionValue")}</dd>
            {signActive && own && <><dt>{t("compose.sec.signingKey")}</dt><dd className="fpr">{shortKey(own.fingerprint)}</dd></>}
            <dt>{t("compose.sec.encryptedFor")}</dt>
            <dd>{(() => {
              const list = allAddrs.map((a) => `${a}${ks?.recipients[a]?.fingerprint ? ` (${shortKey(ks.recipients[a].fingerprint!)})` : ""}`).join(", ");
              return list ? t(bcc.length ? "compose.sec.forListBcc" : "compose.sec.forList", { list }) : t(bcc.length ? "compose.sec.onlyYouBcc" : "compose.sec.onlyYou");
            })()}</dd>
          </dl>
        </div>
      )}
      </div>

      <div className="cp-fmt">
        <FormatBar
          editor={editor} base={base} variant="compose" apiRef={barApi} host={{ link: { open: () => linkRef.current(), isOpen: link.isOpen, btnRef: linkBtnRef }, insertPicture: () => picRef.current?.click() }}
          trailing={{ ids: ["pv:light", "pv:dark"], render: (rove) => <PreviewSwitch pv={pv} onChoose={choosePreview} rove={rove} /> }}
        />
        {link.node}
      </div>

      <div className={`cp-editor cp-pv pv-${pv}`} style={{ ...previewVars(pv), "--cp-font": base.family, "--cp-size": `${base.size}pt` } as React.CSSProperties} ref={bodyRef} onScroll={() => editor && syncPicSel(editor)}>
        <EditorContent editor={editor} className="editor" />
        {picSel && (
          <>
            <div
              className="img-tools-anchor"
              ref={toolsRef}
              onKeyDown={(e) => {
                // Esc leaves the toolbar (or just the alt text popover) and returns to the editor, the picture still selected
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                setAltOpen(false);
                editor?.commands.focus();
              }}
            >
              <div className="img-tools-box">
                <div className="img-tools" role="toolbar" aria-label={t("compose.pic.options")}>
                  <div className="seg" role="radiogroup" aria-label={t("compose.pic.size")}>
                    {SIZES.map(([label, w]) => (
                      <button key={label} role="radio" aria-checked={picSel.width === w} className={picSel.width === w ? "on" : ""} onClick={() => setPictureSize(w)}>
                        {t(label)}
                      </button>
                    ))}
                  </div>
                  <div className="seg" role="radiogroup" aria-label={t("compose.pic.align")}>
                    {([[null, "compose.fmt.alignLeft", <AlignLeft key="l" size={14} />], ["center", "compose.fmt.alignCenter", <AlignCenter key="c" size={14} />], ["right", "compose.fmt.alignRight", <AlignRight key="r" size={14} />]] as const).map(([a, label, icon]) => (
                      <button key={label} role="radio" aria-checked={(picSel.align ?? null) === a} aria-label={t(label)} title={t(label)} className={(picSel.align ?? null) === a ? "on" : ""} onClick={() => setPictureAlign(a)}>
                        {icon}
                      </button>
                    ))}
                  </div>
                  <button className={`icon-btn${picSel.href ? " on" : ""}`} aria-label={t("compose.fmt.link")} aria-pressed={!!picSel.href} title={kbd(t("compose.pic.linkTip"))} onClick={() => linkRef.current()}><Link2 size={14} /></button>
                  <button
                    className={`tool-btn ${picSel.alt ? "" : "no-alt"}`}
                    title={picSel.alt ? t("compose.pic.editAlt") : t("compose.pic.addAlt")}
                    aria-haspopup="dialog"
                    aria-expanded={altOpen}
                    onClick={() => (setAltText(picSel.alt), setAltOpen((o) => !o))}
                  >
                    {t("compose.pic.altText")}
                  </button>
                  <button className="tool-btn" onClick={pictureAsAttachment}>{t("compose.pic.asAttachment")}</button>
                  <button className="icon-btn" aria-label={t("compose.pic.remove")} title={t("compose.pic.removeTip")} onClick={removePicture}><Trash2 size={14} /></button>
                </div>
                {altOpen && (
                  <div className="popover alt-pop" role="dialog" aria-label={t("compose.pic.altText")}>
                    <label className="small muted" htmlFor="alt-text-field">{t("compose.pic.altText")}</label>
                    <textarea id="alt-text-field" value={altText} onChange={(e) => setAltText(e.target.value)} autoFocus placeholder={t("compose.pic.altPlaceholder")} />
                    <div className="helper">{t("compose.pic.altHelp")}</div>
                    <div className="row-inline" style={{ justifyContent: "flex-end", margin: 0 }}>
                      <button className="btn small" onClick={() => setAltOpen(false)}>{t("common.cancel")}</button>
                      <button className="btn primary small" onClick={savePictureAlt}>{t("common.save")}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        {sigHeads.map((el) =>
          createPortal(
            <label className="sig-pick">
              <span>{t("compose.sig.label")}</span>
              <select
                className="sig-select"
                value={sigChoices.some((x) => x.id === sigId) || sigId === "none" ? sigId : ""}
                onChange={(e) => (sigManual.current = true, setSigId(e.target.value), touch())}
                aria-label={t("compose.sig.label")}
              >
                <option value="none">{t("compose.sig.none")}</option>
                {sigChoices.map((x) => <option key={x.id} value={x.id}>{x.id === "draft-signature" ? t("compose.sig.inDraft") : x.accountId ? x.name : accounts.length > 1 ? t("compose.sig.allAccounts", { name: x.name }) : x.name}</option>)}
                {!sigId && <option value="">{t("compose.sig.automatic")}</option>}
              </select>
            </label>,
            el,
          ),
        )}
      </div>

      {/* under the body: the pictures' size, the attachments, the notes; a box of its own height (App.css `.cp-tail`), the body keeps its room */}
      <div className="cp-tail">
      {pics.count > 0 && (
        <div className="cp-size muted small cp-atts" aria-live="polite">
          {t("compose.pic.count", { n: pics.count, size: fmtSize(totalBytes), limit: fmtSize(limit.bytes) })}
          <div className={`progress ${totalBytes > limit.bytes ? "over" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={limit.bytes} aria-valuenow={totalBytes}>
            <i style={{ width: `${Math.min(100, (totalBytes / limit.bytes) * 100)}%` }} />
          </div>
          {totalBytes > limit.bytes && <span className="inline-err">{t("compose.pic.overLimit", { size: fmtSize(totalBytes), limit: fmtSize(limit.bytes) })}</span>}
        </div>
      )}

      {atts.length > 0 && (
        <div className="atts cp-atts">
          {atts.map((a, i) => (
            <span key={i} className={`att-chip ${blockedAttachmentExt(a.filename) ? "blocked" : ""}`} title={blockedAttachmentExt(a.filename) ? t("compose.att.blockedTip") : undefined}>
              <Paperclip size={13} /> <span className="ellipsis">{a.filename}</span> <span className="muted small">{fmtSize(approxBytes(a))}</span>
              {a.mime.startsWith("image/") && (
                <button
                  className="icon-btn"
                  aria-label={t("compose.att.showInMessageAria", { name: a.filename })}
                  title={t("compose.att.showInMessage")}
                  onClick={() => {
                    const uri = `data:${a.mime};base64,${a.dataBase64}`;
                    setAtts((x) => x.filter((_, j) => j !== i));
                    editor?.chain().focus().insertContent({ type: "image", attrs: { src: uri, alt: "", "data-name": a.filename, width: null } }).run();
                  }}
                >
                  <ImagePlus size={12} />
                </button>
              )}
              <button className="icon-btn" aria-label={t("compose.att.removeAria", { name: a.filename })} onClick={() => (setAtts((x) => x.filter((_, j) => j !== i)), touch())}><X size={12} /></button>
            </span>
          ))}
          <span className={`muted small ${totalBytes > limit.bytes ? "err" : ""}`}>{t("compose.att.total", { size: fmtSize(attBytes), limit: fmtSize(limit.bytes) })}</span>
          {blockedAtts.length > 0 && (
            <span className="att-warn" role="alert">
              <TriangleAlert size={14} aria-hidden /> {t(blockedAtts.length === 1 ? "compose.att.blockedWarningOne" : "compose.att.blockedWarningMany", { types: [...new Set(blockedAtts.map((a) => a.ext))].join(", ") })}
            </span>
          )}
        </div>
      )}
      {/* always there when it is not a scheduled message (empty until there is something to say): the line appearing at the first autosave used to move what is above it */}
      {!init.outboxId && (
        <div className="muted small cp-foot">
          {draftsHint ? t("compose.banner.editingDraft") : ""}
          {draftsHint && autosavedAt ? " " : ""}
          {autosavedAt ? t("compose.autosave.saved", { time: fmtClock(Math.floor(autosavedAt / 1000)) }) : ""}
        </div>
      )}
      {init.outboxId && <div className="muted small cp-foot">{t("compose.banner.keepsSchedule")}</div>}
      </div>
      {dragging && (
        <div className="drop-zones" aria-label={t("compose.drop.label")}>
          {dragImages && (
            <div
              className={`dz ${hotZone === "top" ? "hot" : ""}`}
              data-zone="top"
              onDragOver={(e) => (e.preventDefault(), setHotZone("top"))}
              onDragLeave={() => setHotZone(null)}
              onDrop={(e) => (e.preventDefault(), e.stopPropagation(), dropOn("top", e.dataTransfer.files))}
            >
              <span>{t("compose.drop.insert")}</span>
              <small>{t("compose.drop.insertHint")}</small>
            </div>
          )}
          <div
            className={`dz ${hotZone === "bottom" ? "hot" : ""}`}
            data-zone="bottom"
            style={dragImages ? undefined : { gridRow: "1 / span 2" }}
            onDragOver={(e) => (e.preventDefault(), setHotZone("bottom"))}
            onDragLeave={() => setHotZone(null)}
            onDrop={(e) => (e.preventDefault(), e.stopPropagation(), dropOn("bottom", e.dataTransfer.files))}
          >
            <span>{t("compose.drop.attach")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
