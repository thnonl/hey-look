import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, Node as TipNode, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BadgeCheck, Bold, CalendarClock, CalendarPlus, ChevronDown, FileText, ImagePlus, Info, Italic, Link2, List, ListOrdered, Lock, LockOpen, Paperclip, Save, Send, ShieldAlert, ShieldCheck, Sparkles, Trash2,
  TriangleAlert, Underline as UIcon, X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, Att, Contact, Draft, DraftSecurity, errorCode, InlineImage, MessageFull, OwnKeyStatus, RecipientStatus, Signature, Template } from "../api";
import { eff } from "../prefs";
import { kbd } from "../platform";
import { ComposeInit, friendlyError, useStore } from "../store";
import type { ComposeProbe, SavedDraft } from "../leaveCompose";
import { extractSignature, fillSignature, normalizeHtml, SIG_MARK } from "../signature";
import { repairSignature, signatureGuard } from "../signatureGuard";
import { fitInWindow } from "../fitInWindow";
import { placePictureTools } from "../pictureToolsLayout";
import type { PictureToolsInput } from "../pictureToolsLayout";
import { blockedAttachmentExt, dataUriBytes, fileToBase64, fmtIn, fmtSize, fmtWhen, htmlToText, imageSize, PICTURE_TYPES, playSent, resizeImage, sanitizeHtml, shortKey, userName } from "../util";
import { calTz } from "../calendar";
import { defaultMeeting, MeetingState, MeetingStrip, meetingToDraft } from "./Calendar";
import { isEmail, singleLabelHostsOf } from "../addresses";
import { askUnlock } from "./Pgp";
import { useContentProtection } from "../protect";
import { editLink, editorKeyHandlers, isAltGraph } from "../composeKeys";
import { SchedulePicker } from "./SchedulePicker";
import { AccountPicker, Dropdown, MenuList, useFitInWindow, useOutside } from "./ui";
import type { Key } from "../i18n";
import { t as tNow } from "../i18n";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
/** Whether this is an address the composer accepts (see addresses.ts: `qa@localhost` and the account hosts count). */
const EMAIL = { test: (a: string) => isEmail(a, singleLabelHostsOf(useStore.getState().accounts)) };
const bareAddress = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();
const approxBytes = (a: Att) => Math.floor((a.dataBase64.length * 3) / 4);
const MEDIUM = 480;
const SIZES: [Key, number | null][] = [["compose.pic.small", 240], ["compose.pic.medium", MEDIUM], ["compose.pic.large", 720], ["compose.pic.original", null]];
const LARGE_PICTURE = 1024 * 1024;

/** An inline picture: the same node as tiptap's image, plus the width and the file name we keep. */
const PictureNode = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute("width")) || null,
        renderHTML: (a: Record<string, unknown>) => (a.width ? { width: a.width } : {}),
      },
      "data-name": {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-name"),
        renderHTML: (a: Record<string, unknown>) => (a["data-name"] ? { "data-name": a["data-name"] } : {}),
      },
    };
  },
}).configure({ inline: false, allowBase64: true });

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
  label, values, onChange, autoFocus, onTouch, keys, onKeyAction, hideLabel,
}: {
  label: string;
  /** the label is only for screen readers (the caller shows its own) */
  hideLabel?: boolean;
  values: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  onTouch?: () => void;
  /** PGP key status per address (lower case); shown on the chips while Encrypt is on */
  keys?: Record<string, RecipientStatus>;
  onKeyAction?: (a: "import" | "paste") => void;
}) {
  const t = useT();
  const [keyPop, setKeyPop] = useState<string | null>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  useOutside(popRef, () => setKeyPop(null), keyPop !== null);
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [hi, setHi] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const commit = (raw: string) => {
    const parts = raw.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return;
    onChange([...values, ...parts.filter((p) => !values.includes(p))]);
    onTouch?.();
    setText("");
    setSugg([]);
    setHi(-1);
  };
  const pick = (c: Contact) => commit(c.name ? `${c.name.replace(/[<>,;]/g, "")} <${c.email}>` : c.email);

  const onInput = (v: string) => {
    if (/[,;]\s*$/.test(v)) return commit(v);
    setText(v);
    setHi(-1);
    if (v.trim().length >= 2) void api.suggestContacts(v.trim()).then(setSugg).catch(() => setSugg([]));
    else setSugg([]);
  };

  return (
    <div className="cf-field rcpt" onClick={() => input.current?.focus()}>
      {!hideLabel && <label>{label}</label>}
      <div className="chips">
        {values.map((v) => {
          const addr = bareAddress(v).toLowerCase();
          const ks = keys?.[addr];
          const noKey = !!ks && ks.status !== "ok";
          return (
          <span key={v} className={`rchip ${EMAIL.test(bareAddress(v)) ? "" : "bad"} ${noKey ? "nokey" : ""}`} title={EMAIL.test(bareAddress(v)) ? (noKey ? t("compose.rcpt.noUsableKey", { addr }) : v) : t("compose.rcpt.notAddress")}>
            {ks && (ks.status === "ok" ? (
              <span className="rchip-key ok" title={t("compose.rcpt.keyFound")} role="img" aria-label={t("compose.rcpt.keyFoundFor", { addr })}><Lock size={11} /></span>
            ) : (
              <button type="button" className="rchip-key missing" aria-label={t("compose.rcpt.noKeyOptions", { addr })} aria-haspopup="dialog" aria-expanded={keyPop === addr} onClick={(e) => (e.stopPropagation(), setKeyPop(keyPop === addr ? null : addr))}>
                <LockOpen size={11} />
              </button>
            ))}
            <span className="ellipsis">{v}</span>
            <button
              type="button"
              aria-label={t("compose.rcpt.remove", { name: v })}
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
          onChange={(e) => onInput(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          onBlur={() => {
            setTimeout(() => setSugg([]), 120);
            commit(text);
          }}
          onKeyDown={(e) => {
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
        <span className="suggest popover" role="dialog" aria-label={t("compose.rcpt.keyDialog", { addr: keyPop })} ref={popRef} style={{ width: 340, right: "auto", left: 62, padding: 12, gap: 8, display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
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
        <div className="suggest" role="listbox">
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
      if (a.cid && html?.includes(`cid:${a.cid}`)) {
        const d = await api.attachmentData(m.id, a.index).catch(() => null);
        if (d) html = html.split(`cid:${a.cid}`).join(`data:${d.mime};base64,${d.dataBase64}`);
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
 * Returns whether Compose was opened.
 */
export async function openDraftThread(threadId: string, wait = false): Promise<boolean> {
  const st = useStore.getState();
  let msgs = await api.getThread(threadId, "drafts");
  for (let i = 0; wait && !msgs.some((x) => x.folder === "drafts") && i < 4; i++) {
    await useStore.getState().sync();
    msgs = await api.getThread(threadId, "drafts");
    if (!msgs.some((x) => x.folder === "drafts")) await new Promise((r) => setTimeout(r, 1200));
  }
  let m = msgs.filter((x) => x.folder === "drafts").pop() ?? msgs[msgs.length - 1];
  if (!m) {
    if (wait) st.showToast(tNow("compose.leave.draftNotFound"), undefined, "error");
    return false;
  }
  // a draft that was encrypted to your own key needs the key (and its passphrase) to be opened again
  if (m.security?.encrypted && m.security.decryption !== "ok") {
    if (m.security.decryption === "locked" && m.security.lockedKey && (await askUnlock(m.security.lockedKey, "draft", m.security.lockedLabel ?? undefined))) {
      m = await api.pgpDecryptMessage(m.id).catch(() => m);
    }
    if (m.security?.decryption !== "ok") {
      if (m.security?.decryption !== "locked") st.showToast(tNow("mail.draft.cannotOpen", { error: friendlyError(m.security?.error ?? tNow("mail.draft.keyMissing")) }), undefined, "error");
      return false;
    }
  }
  // restore pictures and attachments so saving or sending the draft does not silently drop them
  const { html, attachments } = await messageToEditor(m);
  // the recipients as they were typed (names, Bcc) come from the draft's own headers; the synced copy has bare To / Cc and no Bcc
  const rc = await api.draftRecipients(m.id).catch(() => null);
  const bare = (v: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  await st.openCompose({
    accountId: m.accountId,
    to: rc?.to ?? bare(m.to),
    cc: rc?.cc ?? bare(m.cc),
    bcc: rc?.bcc,
    subject: m.subject === "(no subject)" ? "" : m.subject,
    bodyHtml: html ?? `<p>${(m.text ?? "").replace(/\n/g, "<br>")}</p>`,
    replaces: threadId,
    attachments,
    security: m.security?.encrypted ? { encrypt: true, sign: false, attachPublicKey: false } : undefined,
    confidential: m.confidential,
  });
  return true;
}

/** Replace cid: references with the pictures' data: URIs (used when a sent or scheduled draft is reopened). */
export function picturesToEditor(html: string, pics: InlineImage[]): string {
  return pics.reduce((h, p) => h.split(`cid:${p.cid}`).join(`data:${p.mime};base64,${p.dataBase64}`), html);
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
  /** where the picture is in the scrolling body (see pictureToolsLayout.ts); the toolbar is placed from it once it is measured */
  geo: Omit<PictureToolsInput, "width" | "height">;
}

export function Compose({ init }: { init: ComposeInit }) {
  const t = useT();
  const { accounts, openCompose, showToast, prefs, refresh, confirm, choose, setComposeDirty, setComposeSaver, setComposeProbe, aiConfigured, setDialog, beginSend } = useStore();
  const [accountId, setAccountId] = useState(accounts.some((a) => a.id === init.accountId) ? init.accountId! : accounts.some((a) => a.id === prefs.defaultAccount) ? prefs.defaultAccount : accounts[0]?.id || init.accountId || "");
  const isFresh = !init.replaces && !init.isReply && !init.outboxId && !init.restore;
  // an opened draft / scheduled message / message that failed to send: its body already holds the signature, shown as the region again
  const editing = !!(init.replaces || init.outboxId || init.restore);
  const autoCc = (id: string) => (isFresh ? eff(prefs, id, "autoCc").trim() : "");
  const autoBcc = (id: string) => (isFresh ? eff(prefs, id, "autoBcc").trim() : "");
  const [to, setTo] = useState<string[]>(init.to ?? []);
  const [cc, setCc] = useState<string[]>([...(init.cc ?? []), ...(autoCc(accountId) ? [autoCc(accountId)] : [])]);
  const [bcc, setBcc] = useState<string[]>([...(init.bcc ?? []), ...(autoBcc(accountId) ? [autoBcc(accountId)] : [])]);
  const [showCc, setShowCc] = useState(cc.length > 0 || bcc.length > 0);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [atts, setAtts] = useState<Att[]>(init.attachments ?? []);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sigs, setSigs] = useState<Signature[]>([]);
  // the message of an opened draft carries its signature as stored text: it is shown as the signature region again
  const startDoc = useRef<{ html: string; sig: string | null } | null>(null);
  if (editing && !startDoc.current) startDoc.current = extractSignature(init.bodyHtml ?? "");
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
  const [aiBusy, setAiBusy] = useState(false);
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
  // PGP: Encrypt is "on", "off", or "auto" (on while every recipient has a key); Sign is a plain switch
  const keysRev = useStore((s) => s.keysRev);
  const startMode = eff(prefs, accountId, "pgpEncrypt");
  // Outlook's Sensitivity: Confidential. An answer to confidential mail starts that way, and keeps the window out of screen capture
  // while it quotes the mail (init.confidential), as the reading pane does.
  const [confidential, setConfidential] = useState(!!init.confidential);
  useContentProtection(!!init.confidential);
  const [encIntent, setEncIntent] = useState<"on" | "off" | "auto">(init.restore ? init.restore.encrypt : init.security ? (init.security.encrypt ? "on" : "off") : startMode === "always" ? "on" : startMode === "possible" ? "auto" : "off");
  const [signOn, setSignOn] = useState(init.restore ? init.restore.sign : init.security ? init.security.sign : eff(prefs, accountId, "pgpSign"));
  const [attachKey, setAttachKey] = useState(init.restore ? init.restore.attachKey : init.security ? init.security.attachPublicKey : eff(prefs, accountId, "pgpAttachKey"));
  const [signMenu, setSignMenu] = useState(false);
  const [secDetails, setSecDetails] = useState(false);
  const [ks, setKs] = useState<{ own: OwnKeyStatus | null; recipients: Record<string, RecipientStatus> } | null>(null);
  const signRef = useRef<HTMLDivElement>(null);
  useOutside(signRef, () => setSignMenu(false), signMenu);
  const touched = useRef(false);
  const ccTouched = useRef(false);
  const savedRef = useRef(false); // an outbox item was saved, moved or sent from here (nothing to release)
  const fileRef = useRef<HTMLInputElement>(null);
  const picRef = useRef<HTMLInputElement>(null);
  const schedRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useOutside(schedRef, () => setSchedOpen(false), schedOpen);
  const schedPopRef = useRef<HTMLDivElement>(null);
  useFitInWindow(schedPopRef, schedOpen);

  const revRef = useRef(0); // up with every edit: a save that was running while the person typed knows it
  const attachingRef = useRef(0); // files / pictures being read into the message
  const savedTid = useRef<string | null>(null); // the draft a "leave" save made: a second save replaces it instead of adding another
  const baseline = useRef<{ text: string; pics: number } | null>(null); // the body as Compose opened it (a reply: the quote)

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
    });
    setPics({ count, bytes });
  };

  // Ctrl/Cmd+K in the body and the toolbar button open the same link UI (set after the editor exists)
  const linkRef = useRef<() => void>(() => undefined);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: t("compose.editor.placeholder"), showOnlyCurrent: false }),
      PictureNode,
      SignatureBlock({ mount: (el) => setSigHeads((h) => [...h, el]), unmount: (el) => setSigHeads((h) => h.filter((x) => x !== el)) }),
    ],
    // the accessible name belongs on the contenteditable node ProseMirror renders
    editorProps: {
      attributes: { "aria-label": t("compose.editor.body") },
      // one key, one action: Ctrl+Shift+B / Ctrl+Enter / Ctrl+Alt+... (AltGr) never reach the editor shortcuts, Ctrl+K is the link UI
      handleDOMEvents: editorKeyHandlers(() => linkRef.current()),
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
    content: editing ? startDoc.current!.html : `<p></p>${SIG_MARK}${init.bodyHtml ?? "<p></p>"}`,
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
    if (editor && !baseline.current) baseline.current = { text: editor.getText().trim(), pics: bodyPictures(editor) };
  }, [editor]);

  linkRef.current = () => {
    if (editor) editLink(editor, (cur) => prompt(t("compose.fmt.linkPrompt"), cur));
  };

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
    const doc = new DOMParser().parseFromString(editor?.getHTML() ?? "", "text/html");
    fillSignature(doc, chosenSig?.html ?? null);
    const inline: InlineImage[] = [];
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      const parts = dataUriParts(src);
      if (!parts) return;
      const cid = `${crypto.randomUUID()}@heylook`;
      const name = img.getAttribute("data-name") || `picture-${inline.length + 1}.${parts.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "img"}`;
      inline.push({ cid, filename: name, mime: parts.mime, dataBase64: parts.b64 });
      img.setAttribute("src", `cid:${cid}`);
      img.removeAttribute("data-name");
    });
    const body = doc.body.innerHTML;
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
      meeting: md && "meeting" in md ? md.meeting : undefined,
    };
  };

  const reopen = (d: Draft) => {
    // the draft's pictures go back to data: URIs so the editor shows them again
    const bodyHtml = picturesToEditor(d.html, d.inline ?? []);
    void useStore.getState().openCompose({
      ...init,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyHtml,
      accountId: d.accountId,
      attachments: d.attachments,
      replaces: init.replaces,
      isReply: false,
      security: d.security,
      confidential: d.confidential,
      // the toggles as they were when Send was pressed (the draft only knows what is active), the body with its one signature region
      restore: { encrypt: encIntent, sign: signOn, attachKey },
      meeting: d.meeting ? { ...d.meeting, on: true } : undefined,
    });
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

  const attBytes = atts.reduce((n, a) => n + approxBytes(a), 0);
  const totalBytes = attBytes + pics.bytes;
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

  const sendNowFromEditor = async () => {
    if (!init.outboxId) return;
    const d = await secureDraft(buildDraft());
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
      showToast(t("compose.toast.sendFailed", { error: friendlyError(e) }), undefined, "error");
      reopen(d);
    }
  };

  const send = async (sendAt?: number) => {
    let d = buildDraft();
    if (d.to.length === 0) return showToast(t("compose.err.noRecipient"), undefined, "error");
    const bad = [...d.to, ...d.cc, ...d.bcc].filter((a) => !EMAIL.test(bareAddress(a)));
    if (bad.length) return showToast(t("compose.err.checkAddress", { addr: bad[0] }), undefined, "error");
    if (meeting) {
      const md = meetingToDraft(meeting, calTz(prefs));
      if ("error" in md) return showToast(md.error, undefined, "error");
      if (d.bcc.length) return showToast(t("compose.err.meetingBcc"), undefined, "error");
      if (!d.subject.trim()) return showToast(t("compose.err.meetingSubject"), undefined, "error");
    }
    if (!accountId) return showToast(t("compose.err.noAccount"), undefined, "error");
    if (totalBytes > MAX_ATTACH_BYTES) return showToast(t("compose.att.tooBig", { size: fmtSize(totalBytes) }), undefined, "error");
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
    if (d.to.length === 0) return showToast(t("compose.err.noRecipient"), undefined, "error");

    if (sendAt) {
      if (sendAt * 1000 < Date.now() - 60_000) return showToast(t("compose.schedule.passed"), undefined, "error");
      setBusy(true);
      setComposeDirty(false);
      void openCompose(null);
      try {
        if (init.outboxId) {
          await api.outboxUpdate(init.outboxId, d, sendAt);
          savedRef.current = true;
          showToast(t("compose.toast.rescheduled", { when: fmtWhen(sendAt) }), undefined, "success");
        } else {
          const done = beginSend();
          const res = await api.sendMessage(d, sendAt, init.replaces).finally(done);
          savedRef.current = true;
          const id = res.startsWith("scheduled:") ? res.slice("scheduled:".length) : null;
          const st = useStore.getState();
          showToast(
            t("compose.toast.scheduled", { when: fmtWhen(sendAt) }),
            id
              ? () => {
                  void api.cancelOutbox(id).then(() => reopen(d)).catch((e) => showToast(friendlyError(e), undefined, "error"));
                }
              : undefined,
            "success",
            [{ label: t("compose.toast.view"), run: () => void st.setView("scheduled") }],
          );
        }
        void refresh();
      } catch (e) {
        const code = errorCode(e);
        showToast(code === "SCHEDULE_IN_PAST" ? friendlyError(e) : t("compose.toast.scheduleFailed", { error: friendlyError(e) }), undefined, "error");
        reopen(d);
      }
      return;
    }

    setBusy(true);
    setComposeDirty(false);
    void openCompose(null);
    const wait = eff(prefs, accountId, "undoSeconds");
    let cancelled = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // With an Undo time the message is in the local outbox from now on (REQ-49): a quit, a kill or an installer that ends the app in the
    // Undo time no longer loses it, the next start sends it. Without one it is sent at once as before.
    let heldId: string | null = null;
    if (wait > 0) {
      try {
        heldId = await api.outboxHold(d, Math.floor(Date.now() / 1000) + wait, init.replaces);
      } catch (e) {
        showToast(t("compose.toast.sendFailed", { error: friendlyError(e) }), undefined, "error");
        reopen(d);
        return;
      }
    }
    const run = async () => {
      if (cancelled || started) return;
      started = true;
      clearTimeout(timer);
      const quitting = useStore.getState().quitting;
      try {
        if (heldId) await api.outboxHoldSend(heldId, quitting);
        else await api.sendMessage(d, null, init.replaces);
        if (useStore.getState().prefs.sentSound) playSent();
        showToast(t("compose.toast.sent"), undefined, "success");
        void useStore.getState().sync();
      } catch (e) {
        // quitting: the message stays in the outbox and goes out at the next start (REQ-48 c), nothing is reopened
        if (quitting) return;
        showToast(t("compose.toast.sendFailed", { error: friendlyError(e) }), undefined, "error");
        reopen(d);
      } finally {
        done();
      }
    };
    // counted as "being sent" from the start of the undo window until the server answered (an update restart waits for it; a quit sends it at once)
    const done = beginSend(() => void run());
    timer = setTimeout(() => void run(), wait * 1000);
    if (wait > 0) {
      showToast(
        t("compose.toast.sending"),
        () => {
          // Undo: the message leaves the outbox (if it is already being sent it cannot be taken back)
          if (heldId) {
            void api.cancelOutbox(heldId).then(
              () => {
                cancelled = true;
                clearTimeout(timer);
                done();
                reopen(d);
              },
              (e) => showToast(friendlyError(e), undefined, "error"),
            );
            return;
          }
          cancelled = true;
          clearTimeout(timer);
          done();
          reopen(d);
        },
        "info",
      );
    }
  };

  const saveDraft = useCallback(
    // `onSaved`: the caller (leaving this message, F-21) makes the toast itself, with an Edit button, once the pane is closed
    async (close: boolean, quiet = false, onSaved?: (d: SavedDraft) => void): Promise<boolean> => {
      if (init.outboxId) return true; // a scheduled message is not a draft; "Move to Drafts" does that
      const rev = revRef.current;
      try {
        const d = buildDraft();
        // a draft is only ever encrypted to your own key (no passphrase needed), and never signed
        const keepPrivate = !!d.security?.encrypt && eff(prefs, accountId, "pgpEncryptDrafts");
        const tid = await api.saveDraft({ ...d, security: keepPrivate ? { encrypt: true, sign: false, attachPublicKey: false } : undefined }, savedTid.current ?? init.replaces);
        useStore.setState({ draftError: "" });
        const plain = !!d.security?.encrypt && !keepPrivate;
        if (onSaved) {
          if (tid) savedTid.current = tid;
          onSaved({
            plain,
            edit: () => {
              if (!tid) return showToast(tNow("compose.leave.draftNotFound"), undefined, "error");
              void openDraftThread(tid, true).catch((e) => showToast(friendlyError(e), undefined, "error"));
            },
          });
        } else {
          showToast(plain ? t("compose.toast.draftSavedPlain") : t("compose.toast.draftSaved"), undefined, plain ? "info" : "success");
        }
        // typed while the draft was on its way: it is not saved yet
        if (revRef.current === rev) setComposeDirty(false);
        if (close) void openCompose(null);
        void useStore.getState().sync();
        return true;
      } catch (e) {
        // `quiet`: the caller (an update restart, a quit) tells the user itself
        useStore.setState({ draftError: friendlyError(e).replace(/\.$/, "") });
        if (!quiet) showToast(t("compose.toast.saveFailed", { error: friendlyError(e) }), undefined, "error");
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [to, cc, bcc, subject, atts, accountId, sigId, editor, encOn, signActive, attachKey, confidential],
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
      showToast(t("compose.toast.moveFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };

  // let the store save this draft when another message is opened over it
  useEffect(() => {
    setComposeSaver((o) => saveDraft(false, o?.quiet, o?.onSaved));
  }, [saveDraft, setComposeSaver]);
  // what leaving this message needs to know: did the person write anything, are files still coming in
  const probe = (): ComposeProbe => {
    const b = baseline.current;
    const text = editor?.getText().trim() ?? "";
    const base = init.to ?? [];
    const hasContent =
      touched.current &&
      (text !== (b?.text ?? "") ||
        (editor ? bodyPictures(editor) : 0) !== (b?.pics ?? 0) ||
        to.length !== base.length || to.some((x, i) => x !== base[i]) ||
        subject.trim() !== (init.subject ?? "").trim() ||
        atts.length !== (init.attachments?.length ?? 0));
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
        showToast(friendlyError(e), undefined, "error");
      }
      return;
    }
    const dirty = touched.current && ((editor?.getText().trim().length ?? 0) > 0 || to.length > 0 || subject.trim() || atts.length > 0);
    if (dirty && !(await confirm({ title: t("compose.dlg.discardTitle"), body: t("compose.dlg.discardBody"), confirmLabel: t("compose.dlg.discard"), danger: true }))) return;
    setComposeDirty(false);
    void openCompose(null);
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
    for (const f of Array.from(files)) list.push({ filename: f.name || "pasted-image.png", mime: f.type || "application/octet-stream", dataBase64: await fileToBase64(f) });
    setAtts((a) => {
      const next = [...a, ...list];
      const bytes = next.reduce((n, x) => n + approxBytes(x), 0) + pics.bytes;
      if (bytes > MAX_ATTACH_BYTES) showToast(t("compose.att.totalTooBig", { size: fmtSize(bytes) }), undefined, "error");
      return next;
    });
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
        showToast(t("compose.pic.unsupported", { name: f.name }), undefined, "error");
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
            t("compose.pic.askResize", { size: fmtSize(f.size), w: size.w, h: size.h }),
            undefined,
            "info",
            [{ label: t("compose.pic.resize"), run: () => void resizeInEditor(original, f.type, f.name) }],
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
      setAtts((a) => [...a, { filename: picSel.name !== "picture" ? picSel.name : `picture.${ext}`, mime: parts.mime, dataBase64: parts.b64 }]);
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
    setAiBusy(true);
    try {
      // i18n-ok: the prompt for the model, not UI text
      const context = init.isReply ? `\n\nThe email being replied to:\n${htmlToText(init.bodyHtml ?? "").slice(0, 6000)}` : "";
      const out = await api.aiComplete(
        // i18n-ok: a prompt for the language model, not text the person reads
        "You write email bodies. Output only the email body text (no subject line, no preamble). Match the language of the user's request and the tone requested.",
        `Subject: ${subject}\nExisting draft:\n${editor?.getText() ?? ""}${context}\n\nInstruction: ${aiPrompt}`,
      );
      editor?.commands.insertContentAt(0, out.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;")}</p>`).join(""));
      setAiOpen(false);
      setAiPrompt("");
      touch();
    } catch (e) {
      showToast(friendlyError(e), undefined, "error");
    } finally {
      setAiBusy(false);
    }
  };

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

  return (
    <div
      className={`compose-pane ${dragging ? "dragging" : ""}`}
      onKeyDown={(e) => {
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
      <div className="cp-bar">
        <div className="split-btn" ref={schedRef}>
          <button className="btn primary" disabled={busy} onClick={() => void (init.outboxId ? send(init.sendAt) : send())} title={init.outboxId ? t("compose.bar.scheduleTip") : kbd(t("compose.bar.sendTip"))}>
            {init.outboxId ? <><CalendarClock size={14} /> {t("compose.bar.schedule")}</> : meeting ? <><CalendarPlus size={14} /> {t("compose.bar.sendInvite")}</> : <><Send size={14} /> {t("compose.bar.send")}</>}
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
            <div className="popover up sched-pop" ref={schedPopRef}>
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
        <button className="rb" onClick={() => void discard()}><Trash2 size={15} /><span>{t("compose.bar.discard")}</span></button>
        <button className="rb" onClick={() => fileRef.current?.click()}><Paperclip size={15} /><span>{t("compose.bar.attach")}</span></button>
        <button className="rb" onClick={() => picRef.current?.click()} title={kbd(t("compose.bar.insertPictureTip"))}><ImagePlus size={15} /><span>{t("compose.bar.picture")}</span></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ""))} />
        <input
          ref={picRef}
          type="file"
          accept={PICTURE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => (e.target.files && void insertPictures(Array.from(e.target.files)), (e.target.value = ""))}
        />
        <button
          className={`rb ${meeting ? "on" : ""}`}
          aria-pressed={!!meeting}
          title={t("compose.bar.meetingTip")}
          onClick={() => {
            if (meeting) setMeeting(null);
            else {
              if (bcc.length) {
                setBcc([]);
                showToast(t("compose.meeting.bccRemoved"), undefined, "info");
              }
              setMeeting(defaultMeeting(calTz(prefs)));
            }
            touch();
          }}
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
          <button className="rb caret" aria-label={t("compose.bar.signOptions")} aria-haspopup="menu" aria-expanded={signMenu} title={t("compose.bar.signOptions")} onClick={() => setSignMenu((o) => !o)}>
            <ChevronDown size={12} />
          </button>
          {signMenu && (
            <div className="dd-pop left" style={{ width: 300 }}>
              <MenuList
                onDone={() => setSignMenu(false)}
                items={[
                  { label: t("compose.bar.signThis"), checked: signOn, hint: kbd("Ctrl+Shift+G"), disabled: !own, onClick: toggleSign },
                  { label: t("compose.bar.attachPublicKey"), checked: attachKey, disabled: !own, onClick: () => (setAttachKey(!attachKey), touch()) },
                  { divider: true },
                  ...(own ? [{ label: t("compose.bar.signingKey", { key: shortKey(own.fingerprint) }), icon: <ShieldCheck size={14} />, onClick: () => setDialog({ type: "pgp-key", fingerprint: own.fingerprint }) }] : [{ label: t("compose.bar.noKeyYet"), disabled: true }]),
                  { label: own ? t("compose.bar.manageKeys") : t("compose.bar.setUpEncryption"), onClick: () => (own ? setDialog({ type: "settings", tab: "pgp" }) : setDialog({ type: "pgp-generate", accountId })) },
                ]}
              />
            </div>
          )}
        </div>
        <button
          className={`rb ${confidential ? "on" : ""}`}
          aria-pressed={confidential}
          title={confidential ? t("compose.bar.confidentialOnTip") : t("compose.bar.confidentialOffTip")}
          onClick={() => (setConfidential(!confidential), touch())}
        >
          <ShieldAlert size={15} /><span>{t("compose.bar.confidential")}</span>
        </button>
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
          onClick={() => (aiConfigured ? setAiOpen((o) => !o) : setDialog({ type: "settings", tab: "ai" }))}
          title={init.confidential ? t("compose.bar.aiConfidentialTip") : aiConfigured ? t("compose.bar.aiTip") : t("compose.bar.aiSetupTip")}
        >
          <Sparkles size={15} /><span>{t("compose.bar.writeWithAi")}</span>
        </button>
        <div className="grow" />
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
          <button className="btn primary" disabled={aiBusy} onClick={() => void letAiWrite()}>{aiBusy ? t("compose.ai.writing") : t("compose.ai.write")}</button>
        </div>
      )}

      <div className="cp-fields">
        <div className="cf-field">
          <label>{t("compose.from")}</label>
          <AccountPicker value={accountId} accounts={accounts} onChange={changeAccount} label={t("compose.from")} />
        </div>
        <RecipientField label={t("compose.to")} values={to} onChange={setTo} autoFocus={to.length === 0 && !init.replaces} onTouch={touch} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
        {showCc ? (
          <>
            <RecipientField label={t("compose.cc")} values={cc} onChange={setCc} onTouch={() => ((ccTouched.current = true), touch())} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
            {!meeting && <RecipientField label={t("compose.bcc")} values={bcc} onChange={setBcc} onTouch={() => ((ccTouched.current = true), touch())} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />}
          </>
        ) : (
          <div className="cf-links">
            {/* tabIndex -1: Tab from To goes to Subject (QA BUG-9); the keys are Ctrl/Cmd+Shift+C and B */}
            <button className="link" tabIndex={-1} title={kbd(t("compose.addCc"))} onClick={() => setShowCc(true)}>{t("compose.cc")}</button>
            {!meeting && <button className="link" tabIndex={-1} title={kbd(t("compose.addBcc"))} onClick={() => setShowCc(true)}>{t("compose.bcc")}</button>}
          </div>
        )}
        <div className="cf-field">
          <label>{t("compose.subject")}</label>
          <input value={subject} onChange={(e) => (setSubject(e.target.value), touch())} placeholder={t("compose.subject.placeholder")} aria-label={t("compose.subject")} />
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

      <div className="cp-fmt" role="toolbar" aria-label={t("compose.fmt.toolbar")}>
        <button className="icon-btn" title={kbd(t("compose.fmt.boldTip"))} aria-label={t("compose.fmt.bold")} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></button>
        <button className="icon-btn" title={kbd(t("compose.fmt.italicTip"))} aria-label={t("compose.fmt.italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></button>
        <button className="icon-btn" title={kbd(t("compose.fmt.underlineTip"))} aria-label={t("compose.fmt.underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UIcon size={14} /></button>
        <button className="icon-btn" title={t("compose.fmt.bulleted")} aria-label={t("compose.fmt.bulleted")} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></button>
        <button className="icon-btn" title={t("compose.fmt.numbered")} aria-label={t("compose.fmt.numbered")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></button>
        <button
          className="icon-btn"
          title={t("compose.fmt.link")}
          aria-label={t("compose.fmt.link")}
          onClick={() => linkRef.current()}
        >
          <Link2 size={14} />
        </button>
        <button className="icon-btn" title={kbd(t("compose.bar.insertPictureTip"))} aria-label={t("compose.fmt.insertPicture")} onClick={() => picRef.current?.click()}><ImagePlus size={14} /></button>
      </div>

      <div className="cp-editor" ref={bodyRef} onScroll={() => editor && syncPicSel(editor)}>
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

      {pics.count > 0 && (
        <div className="cp-size muted small cp-atts" aria-live="polite">
          {t("compose.pic.count", { n: pics.count, size: fmtSize(totalBytes) })}
          <div className={`progress ${totalBytes > MAX_ATTACH_BYTES ? "over" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={25 * 1024 * 1024} aria-valuenow={totalBytes}>
            <i style={{ width: `${Math.min(100, (totalBytes / MAX_ATTACH_BYTES) * 100)}%` }} />
          </div>
          {totalBytes > MAX_ATTACH_BYTES && <span className="inline-err">{t("compose.pic.overLimit", { size: fmtSize(totalBytes) })}</span>}
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
          <span className={`muted small ${attBytes > MAX_ATTACH_BYTES ? "err" : ""}`}>{t("compose.att.total", { size: fmtSize(attBytes) })}</span>
          {blockedAtts.length > 0 && (
            <span className="att-warn" role="alert">
              <TriangleAlert size={14} aria-hidden /> {t(blockedAtts.length === 1 ? "compose.att.blockedWarningOne" : "compose.att.blockedWarningMany", { types: [...new Set(blockedAtts.map((a) => a.ext))].join(", ") })}
            </span>
          )}
        </div>
      )}
      {draftsHint && !init.outboxId && <div className="muted small cp-foot">{t("compose.banner.editingDraft")}</div>}
      {init.outboxId && <div className="muted small cp-foot">{t("compose.banner.keepsSchedule")}</div>}
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
