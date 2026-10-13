import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, Node as TipNode, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BadgeCheck, Bold, CalendarClock, CalendarPlus, ChevronDown, FileText, ImagePlus, Info, Italic, Link2, List, ListOrdered, Lock, LockOpen, Paperclip, Save, Send, ShieldCheck, Sparkles, Trash2,
  TriangleAlert, Underline as UIcon, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, Att, Contact, Draft, DraftSecurity, errorCode, InlineImage, MessageFull, OwnKeyStatus, RecipientStatus, Signature, Template } from "../api";
import { eff } from "../prefs";
import { ComposeInit, friendlyError, useStore } from "../store";
import { extractSignature, fillSignature, normalizeHtml, SIG_MARK } from "../signature";
import { blockedAttachmentExt, dataUriBytes, fileToBase64, fmtIn, fmtSize, fmtWhen, htmlToText, imageSize, PICTURE_TYPES, playSent, resizeImage, sanitizeHtml, shortKey, userName } from "../util";
import { calTz } from "../calendar";
import { defaultMeeting, MeetingState, MeetingStrip, meetingToDraft } from "./Calendar";
import { askUnlock } from "./Pgp";
import { SchedulePicker } from "./SchedulePicker";
import { AccountPicker, Dropdown, MenuList, useOutside } from "./ui";

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const bareAddress = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();
const approxBytes = (a: Att) => Math.floor((a.dataBase64.length * 3) / 4);
const MEDIUM = 480;
const SIZES: [string, number | null][] = [["Small", 240], ["Medium", MEDIUM], ["Large", 720], ["Original", null]];
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
          <span key={v} className={`rchip ${EMAIL.test(bareAddress(v)) ? "" : "bad"} ${noKey ? "nokey" : ""}`} title={EMAIL.test(bareAddress(v)) ? (noKey ? `No usable public key for ${addr}` : v) : "This does not look like an email address"}>
            {ks && (ks.status === "ok" ? (
              <span className="rchip-key ok" title="Public key found" role="img" aria-label={`Public key found for ${addr}`}><Lock size={11} /></span>
            ) : (
              <button type="button" className="rchip-key missing" aria-label={`No public key for ${addr} — options`} aria-haspopup="dialog" aria-expanded={keyPop === addr} onClick={(e) => (e.stopPropagation(), setKeyPop(keyPop === addr ? null : addr))}>
                <LockOpen size={11} />
              </button>
            ))}
            <span className="ellipsis">{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
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
            const t = e.clipboardData.getData("text");
            if (/[,;\n]/.test(t)) {
              e.preventDefault();
              commit(text + t);
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
              if (hi >= 0 && sugg[hi]) {
                e.preventDefault();
                pick(sugg[hi]);
              } else if (text.trim()) {
                e.preventDefault();
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
        <span className="suggest popover" role="dialog" aria-label={`Public key for ${keyPop}`} ref={popRef} style={{ width: 340, right: "auto", left: 62, padding: 12, gap: 8, display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}><TriangleAlert size={15} className="warn-ico" /><b>{keys[keyPop].status === "expired" ? `The key for ${keyPop} expired` : keys[keyPop].status === "revoked" ? `The key for ${keyPop} was revoked` : `No public key for ${keyPop}`}</b></span>
          <span className="muted small">
            {keys[keyPop].status === "missing"
              ? "Encrypted mail can only be sent to people whose public key you have. Ask them to send it, or import it from a file."
              : "You can’t encrypt to this key any more. Ask for a new public key, or import it from a file."}
          </span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn small primary" onClick={() => (setKeyPop(null), onKeyAction?.("import"))}>Import key…</button>
            <button className="btn small" onClick={() => (setKeyPop(null), onKeyAction?.("paste"))}>Paste key</button>
            <button className="btn small" onClick={() => { const a = keyPop; setKeyPop(null); onChange(values.filter((x) => bareAddress(x).toLowerCase() !== a)); onTouch?.(); }}>Remove recipient</button>
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
  top: number;
  left: number;
}

export function Compose({ init }: { init: ComposeInit }) {
  const { accounts, openCompose, showToast, prefs, refresh, confirm, choose, setComposeDirty, setComposeSaver, aiConfigured, setDialog, beginSend } = useStore();
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
    () => (startDoc.current?.sig ? { id: "draft-signature", name: "Signature saved in this draft", html: startDoc.current.sig, isDefault: false, accountId: null } : null),
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

  const touch = useCallback(() => {
    touched.current = true;
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
    const t = setTimeout(() => {
      api
        .pgpRecipientStatus(accountId, allAddrs)
        .then((r) => live && setKs({ own: r.own, recipients: Object.fromEntries(r.recipients.map((x) => [x.address.toLowerCase(), x])) }))
        .catch(() => live && setKs({ own: null, recipients: {} }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
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
    ? `You have no PGP key for ${fromEmail}. Set up encryption… (Settings → Encryption)`
    : encOn && noKeyAddrs.length > 0
      ? `Encrypt (Ctrl+Shift+E) — ${noKeyAddrs.length} recipient${noKeyAddrs.length === 1 ? " has" : "s have"} no key`
      : "Encrypt (Ctrl+Shift+E)";
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
    const scroll = bodyRef.current?.scrollTop ?? 0;
    const above = r.top - box.top - 44 >= 0;
    setPicSel({
      pos: sel.from,
      width: (sel.node.attrs.width as number | null) ?? null,
      alt: (sel.node.attrs.alt as string | null) ?? "",
      name: (sel.node.attrs["data-name"] as string | null) ?? "picture",
      top: above ? r.top - box.top + scroll - 42 : r.bottom - box.top + scroll + 8,
      left: Math.max(8, r.left - box.left + Math.min(r.width, 360) / 2 - 150),
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

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Write your message…", showOnlyCurrent: false }),
      PictureNode,
      SignatureBlock({ mount: (el) => setSigHeads((h) => [...h, el]), unmount: (el) => setSigHeads((h) => h.filter((x) => x !== el)) }),
    ],
    // the accessible name belongs on the contenteditable node ProseMirror renders
    editorProps: {
      attributes: { "aria-label": "Message body" },
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
    onUpdate: ({ editor: ed }) => {
      // the signature region cannot be deleted by accident (Backspace, select all): it comes back at the end
      let has = false;
      ed.state.doc.descendants((n) => { if (n.type.name === "signatureBlock") has = true; return !has; });
      if (!has) ed.commands.insertContentAt(ed.state.doc.content.size, [{ type: "signatureBlock" }, { type: "paragraph" }]);
      touch();
      countPictures(ed);
      syncPicSel(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => syncPicSel(ed),
  });

  // pictures that were already in the draft (or a scheduled message) are counted once the editor exists
  useEffect(() => {
    if (editor) countPictures(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void Promise.all([api.listTemplates(), api.listSignatures()]).then(([t, s]) => {
      setTemplates(t);
      setSigs(s);
      setLoaded(true);
    });
  }, []);

  // only what applies to the sending account: its own items plus those shared by all accounts
  const mySigs = sigs.filter((s) => !s.accountId || s.accountId === accountId);
  const myTemplates = templates.filter((t) => !t.accountId || t.accountId === accountId);
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
          title: "Send without encryption?",
          body: one ? `There is no public key for ${one}, so this message can’t be encrypted for them.` : `There are no public keys for ${miss.slice(0, 3).join(", ")}${miss.length > 3 ? ` and ${miss.length - 3} more` : ""}, so this message can’t be encrypted for them.`,
          choices: [
            { id: "cancel", label: "Cancel" },
            ...(one && d.to.length + d.cc.length + d.bcc.length > 1 ? [{ id: "remove", label: `Remove ${label} and send encrypted`, kind: "primary" as const }] : []),
            { id: "plain", label: "Send unencrypted", kind: "danger" as const },
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
      showToast("Message sent", undefined, "success");
      void refresh();
    } catch (e) {
      setBusy(false);
      showToast(`Send failed: ${friendlyError(e)}`, undefined, "error");
      reopen(d);
    }
  };

  const send = async (sendAt?: number) => {
    let d = buildDraft();
    if (d.to.length === 0) return showToast("Add at least one recipient", undefined, "error");
    const bad = [...d.to, ...d.cc, ...d.bcc].filter((a) => !EMAIL.test(bareAddress(a)));
    if (bad.length) return showToast(`Check the address: ${bad[0]}`, undefined, "error");
    if (meeting) {
      const md = meetingToDraft(meeting, calTz(prefs));
      if ("error" in md) return showToast(md.error, undefined, "error");
      if (d.bcc.length) return showToast("Bcc isn’t used for meetings. Remove the Bcc recipients or turn off Meeting.", undefined, "error");
      if (!d.subject.trim()) return showToast("Add a subject: it becomes the title of the event.", undefined, "error");
    }
    if (!accountId) return showToast("No account selected", undefined, "error");
    if (totalBytes > MAX_ATTACH_BYTES) return showToast(`Attachments and pictures are ${fmtSize(totalBytes)}; most servers accept at most 25 MB`, undefined, "error");
    if (!d.subject && !(await confirm({ title: "Send without a subject?", confirmLabel: "Send anyway" }))) return;
    if (
      blockedAtts.length &&
      !(await confirm({
        title: `Send with ${blockedAtts.length === 1 ? "an attachment" : "attachments"} that mail servers block?`,
        body: `${[...new Set(blockedAtts.map((a) => a.name))].slice(0, 3).join(", ")}: Gmail, Outlook and Yahoo reject programs and scripts (${[...new Set(blockedAtts.map((a) => a.ext))].join(", ")}), even inside a zip file. The message will most likely not be delivered. Remove the file or share it as a link instead.`,
        confirmLabel: "Send anyway",
      }))
    )
      return;
    const secured = await secureDraft(d);
    if (!secured) return;
    d = secured;
    if (d.to.length === 0) return showToast("Add at least one recipient", undefined, "error");

    if (sendAt) {
      if (sendAt * 1000 < Date.now() - 60_000) return showToast("That time has passed. Pick a later time, or send now.", undefined, "error");
      setBusy(true);
      setComposeDirty(false);
      void openCompose(null);
      try {
        if (init.outboxId) {
          await api.outboxUpdate(init.outboxId, d, sendAt);
          savedRef.current = true;
          showToast(`Rescheduled for ${fmtWhen(sendAt)}`, undefined, "success");
        } else {
          const done = beginSend();
          const res = await api.sendMessage(d, sendAt, init.replaces).finally(done);
          savedRef.current = true;
          const id = res.startsWith("scheduled:") ? res.slice("scheduled:".length) : null;
          const st = useStore.getState();
          showToast(
            `Scheduled for ${fmtWhen(sendAt)}`,
            id
              ? () => {
                  void api.cancelOutbox(id).then(() => reopen(d)).catch((e) => showToast(friendlyError(e), undefined, "error"));
                }
              : undefined,
            "success",
            [{ label: "View", run: () => void st.setView("scheduled") }],
          );
        }
        void refresh();
      } catch (e) {
        const code = errorCode(e);
        showToast(code === "SCHEDULE_IN_PAST" ? friendlyError(e) : `Schedule failed: ${friendlyError(e)}`, undefined, "error");
        reopen(d);
      }
      return;
    }

    setBusy(true);
    setComposeDirty(false);
    void openCompose(null);
    const wait = eff(prefs, accountId, "undoSeconds");
    let cancelled = false;
    // counted as "being sent" from the start of the undo window until the server answered (an update restart waits for it)
    const done = beginSend();
    const t = setTimeout(async () => {
      if (cancelled) return;
      try {
        await api.sendMessage(d, null, init.replaces);
        if (useStore.getState().prefs.sentSound) playSent();
        showToast("Message sent", undefined, "success");
        void useStore.getState().sync();
      } catch (e) {
        showToast(`Send failed: ${friendlyError(e)}`, undefined, "error");
        reopen(d);
      } finally {
        done();
      }
    }, wait * 1000);
    if (wait > 0) {
      showToast(
        "Sending…",
        () => {
          cancelled = true;
          clearTimeout(t);
          done();
          reopen(d);
        },
        "info",
      );
    }
  };

  const saveDraft = useCallback(
    async (close: boolean, quiet = false): Promise<boolean> => {
      if (init.outboxId) return true; // a scheduled message is not a draft; "Move to Drafts" does that
      try {
        const d = buildDraft();
        // a draft is only ever encrypted to your own key (no passphrase needed), and never signed
        const keepPrivate = !!d.security?.encrypt && eff(prefs, accountId, "pgpEncryptDrafts");
        await api.saveDraft({ ...d, security: keepPrivate ? { encrypt: true, sign: false, attachPublicKey: false } : undefined }, init.replaces);
        showToast(d.security?.encrypt && !keepPrivate ? "Draft saved without encryption (Settings → Security)" : "Draft saved", undefined, d.security?.encrypt && !keepPrivate ? "info" : "success");
        setComposeDirty(false);
        if (close) void openCompose(null);
        void useStore.getState().sync();
        return true;
      } catch (e) {
        // `quiet`: the caller (an update restart) tells the user itself
        if (!quiet) showToast(`Save draft failed: ${friendlyError(e)}`, undefined, "error");
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [to, cc, bcc, subject, atts, accountId, sigId, editor, encOn, signActive, attachKey],
  );

  const moveToDrafts = async () => {
    if (!init.outboxId) return;
    try {
      await api.outboxToDraft(init.outboxId);
      savedRef.current = true;
      setComposeDirty(false);
      showToast("Moved to Drafts", undefined, "success");
      void openCompose(null);
      void refresh();
    } catch (e) {
      showToast(`Couldn’t move to Drafts: ${friendlyError(e)}`, undefined, "error");
    }
  };

  // let the store save this draft when another message is opened over it
  useEffect(() => {
    setComposeSaver((o) => saveDraft(false, o?.quiet));
  }, [saveDraft, setComposeSaver]);
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
        title: "Cancel this scheduled message?",
        body: `“${subject || "(no subject)"}” won’t be sent.`,
        choices: [
          { id: "keep", label: "Keep scheduled" },
          { id: "drafts", label: "Move to Drafts" },
          { id: "delete", label: "Delete", kind: "danger" },
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
        showToast(choice === "delete" ? "Scheduled send cancelled" : "Moved to Drafts", undefined, "success");
        void openCompose(null);
        void refresh();
      } catch (e) {
        showToast(friendlyError(e), undefined, "error");
      }
      return;
    }
    const dirty = touched.current && ((editor?.getText().trim().length ?? 0) > 0 || to.length > 0 || subject.trim() || atts.length > 0);
    if (dirty && !(await confirm({ title: "Discard this message?", body: "What you wrote will be lost.", confirmLabel: "Discard", danger: true }))) return;
    setComposeDirty(false);
    void openCompose(null);
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list: Att[] = [];
    for (const f of Array.from(files)) list.push({ filename: f.name || "pasted-image.png", mime: f.type || "application/octet-stream", dataBase64: await fileToBase64(f) });
    setAtts((a) => {
      const next = [...a, ...list];
      const bytes = next.reduce((n, x) => n + approxBytes(x), 0) + pics.bytes;
      if (bytes > MAX_ATTACH_BYTES) showToast(`Attachments total ${fmtSize(bytes)}; most servers accept at most 25 MB`, undefined, "error");
      return next;
    });
    touch();
  };
  addFilesRef.current = async (files: File[]) => addFiles(files);

  /** A picture file into the body at the caret (Medium size), or attached when the format is not supported. */
  const insertPictures = async (files: File[]) => {
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
        showToast(`Couldn’t insert “${f.name}”: this picture format isn’t supported. It was attached instead.`, undefined, "error");
        attach.push(f);
        continue;
      }
      let finalSrc = src;
      if (f.size > LARGE_PICTURE) {
        if (st.prefs.autoResizePictures) {
          const r = await resizeImage(src, f.type, 1600);
          finalSrc = r.dataUrl;
          showToast(`Resized ${f.name} to 1600 px (${fmtSize(dataUriBytes(finalSrc))})`, undefined, "success");
        } else {
          const original = src;
          showToast(
            `This picture is ${fmtSize(f.size)} (${size.w} × ${size.h}). Resize it to 1600 px wide?`,
            undefined,
            "info",
            [{ label: "Resize", run: () => void resizeInEditor(original, f.type, f.name) }],
          );
        }
      }
      editor?.chain().focus().insertContent({ type: "image", attrs: { src: finalSrc, alt: "", "data-name": f.name, width: size.w > MEDIUM ? MEDIUM : null } }).run();
    }
    if (attach.length) {
      await addFiles(attach);
      if (files.length > attach.length) showToast(`${attach.length} file${attach.length === 1 ? "" : "s"} attached (only pictures can go in the message)`, undefined, "info");
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
    showToast(`Resized ${name} to 1600 px (${fmtSize(dataUriBytes(r.dataUrl))})`, undefined, "success");
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
        showToast(`${rest.length} file${rest.length === 1 ? "" : "s"} attached (only pictures can go in the message)`, undefined, "info");
      }
      return;
    }
    void addFiles(all);
  };

  const applyTemplate = (t: Template) => {
    if (t.subject && !subject) setSubject(t.subject);
    editor?.commands.insertContent(t.body);
    touch();
  };

  const letAiWrite = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const context = init.isReply ? `\n\nThe email being replied to:\n${htmlToText(init.bodyHtml ?? "").slice(0, 6000)}` : "";
      const out = await api.aiComplete(
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
      return { cls: "warn", icon: <TriangleAlert size={15} />, body: <>Your key expired. Extend it in Settings → Encryption.</>, actions: <button className="link" onClick={() => setDialog({ type: "settings", tab: "pgp" })}>Open settings</button> };
    }
    if (encOn && noKeyAddrs.length > 0) {
      const st = ks?.recipients[firstMissing]?.status;
      return {
        cls: "warn",
        icon: <TriangleAlert size={15} />,
        body: <>{st === "expired" ? <>Can’t encrypt for <b>{firstMissing}</b>: their key expired.</> : st === "revoked" ? <>Can’t encrypt for <b>{firstMissing}</b>: their key was revoked.</> : <>Can’t encrypt yet: no public key for <b>{firstMissing}</b>{noKeyAddrs.length > 1 ? ` and ${noKeyAddrs.length - 1} other${noKeyAddrs.length > 2 ? "s" : ""}` : ""}.</>}</>,
        actions: (
          <>
            <button className="link" onClick={() => keyAction("import")}>Import key…</button><span className="muted">·</span>
            <button className="link" onClick={() => (setEncIntent("off"), touch())}>Turn off Encrypt</button>
          </>
        ),
      };
    }
    if (encOn) {
      return {
        cls: "",
        icon: <ShieldCheck size={15} />,
        body: nUnique === 0
          ? <>Will be {signActive ? "encrypted and signed" : "encrypted"} for the people you add, and you. Subject is not encrypted.</>
          : <>{signActive ? "Encrypted and signed" : "Encrypted"} for {nUnique} recipient{nUnique === 1 ? "" : "s"} and you. Subject is not encrypted.</>,
        actions: <button className="link" onClick={() => setSecDetails((o) => !o)} aria-expanded={secDetails}>Details</button>,
      };
    }
    if (autoOff) {
      return {
        cls: "off",
        icon: <Info size={15} />,
        body: <>Encryption turned off: no key for <b>{firstMissing}</b>.{signActive ? " Signed only." : ""}</>,
        actions: <button className="link" onClick={() => (setEncIntent("on"), touch())}>Encrypt anyway…</button>,
      };
    }
    if (signActive) return { cls: "", icon: <ShieldCheck size={15} />, body: <>Signed. Not encrypted.</> };
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
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          setSchedOpen(true);
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
          <button className="btn primary" disabled={busy} onClick={() => void (init.outboxId ? send(init.sendAt) : send())} title={init.outboxId ? "Schedule (keeps the time)" : "Send (Ctrl+Enter)"}>
            {init.outboxId ? <><CalendarClock size={14} /> Schedule</> : meeting ? <><CalendarPlus size={14} /> Send invite</> : <><Send size={14} /> Send</>}
          </button>
          <button
            className="btn primary split-caret"
            aria-label="Send later options"
            aria-haspopup="dialog"
            aria-expanded={schedOpen}
            title="Send later (Ctrl+Shift+Enter)"
            onClick={() => setSchedOpen((o) => !o)}
          >
            <ChevronDown size={14} />
          </button>
          {schedOpen && (
            <div className="popover up sched-pop">
              <SchedulePicker
                initial={schedInitial}
                primaryLabel="Schedule"
                busy={busy}
                onPick={(ts) => (setSchedOpen(false), void send(ts))}
                onSendNow={init.outboxId ? () => (setSchedOpen(false), void sendNowFromEditor()) : () => (setSchedOpen(false), void send())}
                onCancel={() => setSchedOpen(false)}
              />
            </div>
          )}
        </div>
        {init.outboxId ? (
          <button className="rb" onClick={() => void moveToDrafts()}><Save size={15} /><span>Move to Drafts</span></button>
        ) : null}
        <button className="rb" onClick={() => void discard()}><Trash2 size={15} /><span>Discard</span></button>
        <button className="rb" onClick={() => fileRef.current?.click()}><Paperclip size={15} /><span>Attach</span></button>
        <button className="rb" onClick={() => picRef.current?.click()} title="Insert picture (Ctrl+Shift+P)"><ImagePlus size={15} /><span>Picture</span></button>
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
          title="Meeting: send this message as a calendar invitation"
          onClick={() => {
            if (meeting) setMeeting(null);
            else {
              if (bcc.length) {
                setBcc([]);
                showToast("Bcc recipients were removed: Bcc isn’t used for meetings.", undefined, "info");
              }
              setMeeting(defaultMeeting(calTz(prefs)));
            }
            touch();
          }}
        >
          <CalendarPlus size={15} /><span>Meeting</span>
        </button>
        <button
          className={`rb ${encOn && noKeyAddrs.length === 0 && canEnc ? "on" : encOn ? "warn" : ""}`}
          aria-pressed={encOn}
          aria-disabled={!own}
          title={encTitle}
          onClick={toggleEncrypt}
        >
          {encOn ? <Lock size={15} /> : <LockOpen size={15} />}<span>Encrypt</span>
        </button>
        <div className="dd" ref={signRef}>
          <button className={`rb ${signActive ? "on" : ""}`} aria-pressed={signActive} aria-disabled={!own} title={own ? "Sign (Ctrl+Shift+G)" : encTitle} onClick={toggleSign}>
            <BadgeCheck size={15} /><span>Sign</span>
          </button>
          <button className="rb caret" aria-label="Signing options" aria-haspopup="menu" aria-expanded={signMenu} title="Signing options" onClick={() => setSignMenu((o) => !o)}>
            <ChevronDown size={12} />
          </button>
          {signMenu && (
            <div className="dd-pop left" style={{ width: 300 }}>
              <MenuList
                onDone={() => setSignMenu(false)}
                items={[
                  { label: "Sign this message", checked: signOn, hint: "Ctrl+Shift+G", disabled: !own, onClick: toggleSign },
                  { label: "Attach my public key", checked: attachKey, disabled: !own, onClick: () => (setAttachKey(!attachKey), touch()) },
                  { divider: true },
                  ...(own ? [{ label: `Signing key ${shortKey(own.fingerprint)}`, icon: <ShieldCheck size={14} />, onClick: () => setDialog({ type: "pgp-key", fingerprint: own.fingerprint }) }] : [{ label: "No key for this account yet", disabled: true }]),
                  { label: own ? "Manage keys…" : "Set up encryption…", onClick: () => (own ? setDialog({ type: "settings", tab: "pgp" }) : setDialog({ type: "pgp-generate", accountId })) },
                ]}
              />
            </div>
          )}
        </div>
        {!init.outboxId && <button className="rb" onClick={() => void saveDraft(true)}><Save size={15} /><span>Save draft</span></button>}
        <Dropdown
          className="rb"
          items={myTemplates.length ? myTemplates.map((t) => ({ label: t.name, onClick: () => applyTemplate(t) })) : [{ label: "No templates yet (Settings → Mailboxes → Templates)", disabled: true }]}
        >
          <FileText size={15} /><span>Templates</span>
        </Dropdown>
        <button
          className={`rb ${aiOpen ? "on" : ""}`}
          onClick={() => (aiConfigured ? setAiOpen((o) => !o) : setDialog({ type: "settings", tab: "ai" }))}
          title={aiConfigured ? "Write or rewrite with AI" : "Set up the AI Assistant first"}
        >
          <Sparkles size={15} /><span>Write with AI</span>
        </button>
        <div className="grow" />
      </div>

      {init.outboxId && (
        <div className={`cp-banner ${init.outboxError ? "bad" : ""}`} role="status">
          <CalendarClock size={15} aria-hidden />
          {init.outboxError ? (
            <span>This scheduled message failed: {init.outboxError}</span>
          ) : (
            <span>
              Scheduled for <b>{fmtWhen(init.sendAt ?? Date.now() / 1000)}</b> ({fmtIn(init.sendAt ?? Date.now() / 1000)}). Paused while you edit.
            </span>
          )}
          <span className="grow" />
          <button className="link" onClick={() => setSchedOpen(true)}>Change time</button>
          <button className="link" onClick={() => void sendNowFromEditor()} disabled={busy}>Send now</button>
          {pastDue && <span className="muted small">That time has passed. Pick a new time to schedule it again.</span>}
        </div>
      )}

      {aiOpen && (
        <div className="cp-ai">
          <textarea
            rows={2}
            autoFocus
            placeholder={init.isReply ? "Write a reply to this email saying…" : "Describe the email you want, e.g. politely decline the meeting and propose next Tuesday"}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
          />
          <button className="btn primary" disabled={aiBusy} onClick={() => void letAiWrite()}>{aiBusy ? "Writing…" : "Write"}</button>
        </div>
      )}

      <div className="cp-fields">
        <div className="cf-field">
          <label>From</label>
          <AccountPicker value={accountId} accounts={accounts} onChange={changeAccount} label="From" />
        </div>
        <RecipientField label="To" values={to} onChange={setTo} autoFocus={to.length === 0 && !init.replaces} onTouch={touch} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
        {showCc ? (
          <>
            <RecipientField label="Cc" values={cc} onChange={setCc} onTouch={() => ((ccTouched.current = true), touch())} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />
            {!meeting && <RecipientField label="Bcc" values={bcc} onChange={setBcc} onTouch={() => ((ccTouched.current = true), touch())} keys={encOn && ks ? ks.recipients : undefined} onKeyAction={keyAction} />}
          </>
        ) : (
          <div className="cf-links">
            <button className="link" onClick={() => setShowCc(true)}>Cc</button>
            {!meeting && <button className="link" onClick={() => setShowCc(true)}>Bcc</button>}
          </div>
        )}
        <div className="cf-field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => (setSubject(e.target.value), touch())} placeholder="Add a subject" aria-label="Subject" />
        </div>
      </div>

      {meeting && (
        <>
          <MeetingStrip value={meeting} onChange={(m) => (setMeeting(m), touch())} tz={calTz(prefs)} />
          <div className="note" style={{ padding: "6px 20px 0" }}>
            <Info size={13} aria-hidden /> <span>Recipients in To are required attendees, Cc are optional. Bcc isn’t used for meetings. The event is also added to My events.</span>
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
            <dt>Encryption</dt><dd>OpenPGP (PGP/MIME), AES-256</dd>
            {signActive && own && <><dt>Signing key</dt><dd className="fpr">{shortKey(own.fingerprint)}</dd></>}
            <dt>Encrypted for</dt>
            <dd>{allAddrs.map((a) => `${a}${ks?.recipients[a]?.fingerprint ? ` (${shortKey(ks.recipients[a].fingerprint!)})` : ""}`).join(", ") || "Only you"} and you{bcc.length ? ". Bcc recipients can read it too." : ""}</dd>
          </dl>
        </div>
      )}

      <div className="cp-fmt" role="toolbar" aria-label="Formatting">
        <button className="icon-btn" title="Bold (Ctrl+B)" aria-label="Bold" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></button>
        <button className="icon-btn" title="Italic (Ctrl+I)" aria-label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></button>
        <button className="icon-btn" title="Underline (Ctrl+U)" aria-label="Underline" onClick={() => editor?.chain().focus().toggleUnderline().run()}><UIcon size={14} /></button>
        <button className="icon-btn" title="Bulleted list" aria-label="Bulleted list" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></button>
        <button className="icon-btn" title="Numbered list" aria-label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered size={14} /></button>
        <button
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
        <button className="icon-btn" title="Insert picture (Ctrl+Shift+P)" aria-label="Insert picture" onClick={() => picRef.current?.click()}><ImagePlus size={14} /></button>
      </div>

      <div className="cp-editor" ref={bodyRef} onScroll={() => editor && syncPicSel(editor)}>
        <EditorContent editor={editor} className="editor" />
        {picSel && (
          <>
            <div className="img-tools" role="toolbar" aria-label="Picture options" style={{ top: picSel.top, left: picSel.left, position: "absolute" }}>
              <div className="seg" role="radiogroup" aria-label="Size">
                {SIZES.map(([label, w]) => (
                  <button key={label} role="radio" aria-checked={picSel.width === w} className={picSel.width === w ? "on" : ""} onClick={() => setPictureSize(w)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="sep" />
              <button className={`tool-btn ${picSel.alt ? "" : "dot"}`} title={picSel.alt ? "Edit alt text (Alt+Enter)" : "Add alt text (Alt+Enter)"} onClick={() => (setAltText(picSel.alt), setAltOpen((o) => !o))}>
                Alt text
              </button>
              <button className="tool-btn" onClick={pictureAsAttachment}>As attachment</button>
              <button className="icon-btn" aria-label="Remove picture" title="Remove picture (Delete)" onClick={removePicture}><Trash2 size={14} /></button>
            </div>
            {altOpen && (
              <div className="popover alt-pop" style={{ top: picSel.top + 40, left: picSel.left, position: "absolute", zIndex: 13 }} role="dialog" aria-label="Alt text">
                <label className="small muted">Alt text</label>
                <textarea value={altText} onChange={(e) => setAltText(e.target.value)} autoFocus placeholder="Describe the picture for people who can’t see it" />
                <div className="helper">Read aloud by screen readers. Leave empty for decorative pictures.</div>
                <div className="row-inline" style={{ justifyContent: "flex-end", margin: 0 }}>
                  <button className="btn small" onClick={() => setAltOpen(false)}>Cancel</button>
                  <button className="btn primary small" onClick={savePictureAlt}>Save</button>
                </div>
              </div>
            )}
          </>
        )}
        {sigHeads.map((el) =>
          createPortal(
            <label className="sig-pick">
              <span>Signature</span>
              <select
                className="sig-select"
                value={sigChoices.some((x) => x.id === sigId) || sigId === "none" ? sigId : ""}
                onChange={(e) => (sigManual.current = true, setSigId(e.target.value), touch())}
                aria-label="Signature"
              >
                <option value="none">No signature</option>
                {sigChoices.map((x) => <option key={x.id} value={x.id}>{x.name}{x.accountId ? "" : x.id !== "draft-signature" && accounts.length > 1 ? " (all accounts)" : ""}</option>)}
                {!sigId && <option value="">Automatic</option>}
              </select>
            </label>,
            el,
          ),
        )}
      </div>

      {pics.count > 0 && (
        <div className="cp-size muted small cp-atts" aria-live="polite">
          {pics.count} picture{pics.count === 1 ? "" : "s"} in message · {fmtSize(totalBytes)} of 25 MB
          <div className={`progress ${totalBytes > MAX_ATTACH_BYTES ? "over" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={25 * 1024 * 1024} aria-valuenow={totalBytes}>
            <i style={{ width: `${Math.min(100, (totalBytes / MAX_ATTACH_BYTES) * 100)}%` }} />
          </div>
          {totalBytes > MAX_ATTACH_BYTES && <span className="inline-err">Message is {fmtSize(totalBytes)} — over the 25 MB most servers accept. Resize pictures or remove attachments.</span>}
        </div>
      )}

      {atts.length > 0 && (
        <div className="atts cp-atts">
          {atts.map((a, i) => (
            <span key={i} className={`att-chip ${blockedAttachmentExt(a.filename) ? "blocked" : ""}`} title={blockedAttachmentExt(a.filename) ? "Mail servers block this file type" : undefined}>
              <Paperclip size={13} /> <span className="ellipsis">{a.filename}</span> <span className="muted small">{fmtSize(approxBytes(a))}</span>
              {a.mime.startsWith("image/") && (
                <button
                  className="icon-btn"
                  aria-label={`Show ${a.filename} in message instead`}
                  title="Show in message instead"
                  onClick={() => {
                    const uri = `data:${a.mime};base64,${a.dataBase64}`;
                    setAtts((x) => x.filter((_, j) => j !== i));
                    editor?.chain().focus().insertContent({ type: "image", attrs: { src: uri, alt: "", "data-name": a.filename, width: null } }).run();
                  }}
                >
                  <ImagePlus size={12} />
                </button>
              )}
              <button className="icon-btn" aria-label={`Remove ${a.filename}`} onClick={() => (setAtts((x) => x.filter((_, j) => j !== i)), touch())}><X size={12} /></button>
            </span>
          ))}
          <span className={`muted small ${attBytes > MAX_ATTACH_BYTES ? "err" : ""}`}>{fmtSize(attBytes)} attached of 25 MB</span>
          {blockedAtts.length > 0 && (
            <span className="att-warn" role="alert">
              <TriangleAlert size={14} aria-hidden /> Gmail, Outlook and Yahoo reject {[...new Set(blockedAtts.map((a) => a.ext))].join(", ")} files, even inside a zip. This message will probably be refused: remove {blockedAtts.length === 1 ? "it" : "them"} or share a link instead.
            </span>
          )}
        </div>
      )}
      {draftsHint && !init.outboxId && <div className="muted small cp-foot">Editing a draft. Sending or saving replaces the original.</div>}
      {init.outboxId && <div className="muted small cp-foot">Closing without changes keeps the original schedule.</div>}
      {dragging && (
        <div className="drop-zones" aria-label="Drop files">
          {dragImages && (
            <div
              className={`dz ${hotZone === "top" ? "hot" : ""}`}
              data-zone="top"
              onDragOver={(e) => (e.preventDefault(), setHotZone("top"))}
              onDragLeave={() => setHotZone(null)}
              onDrop={(e) => (e.preventDefault(), e.stopPropagation(), dropOn("top", e.dataTransfer.files))}
            >
              <span>Drop to insert in the message</span>
              <small>Pictures go where the cursor is</small>
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
            <span>Drop here to attach</span>
          </div>
        </div>
      )}
    </div>
  );
}
