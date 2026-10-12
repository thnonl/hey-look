import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold, CalendarClock, ChevronDown, FileText, Italic, Link2, List, ListOrdered, Paperclip, Save, Send, Sparkles, Trash2, Underline as UIcon, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Att, Contact, Signature, Template } from "../api";
import { eff } from "../prefs";
import { ComposeInit, friendlyError, useStore } from "../store";
import { fileToBase64, fmtSize, htmlToText, playSent, snoozePresets } from "../util";
import { Dropdown, useOutside } from "./ui";

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const bareAddress = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim();
const approxBytes = (a: Att) => Math.floor((a.dataBase64.length * 3) / 4);

/** Recipient input with chips, address validation and keyboard-friendly suggestions. */
function RecipientField({ label, values, onChange, autoFocus, onTouch }: { label: string; values: string[]; onChange: (v: string[]) => void; autoFocus?: boolean; onTouch?: () => void }) {
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
    if (/[,;]$/.test(v)) return commit(v);
    setText(v);
    setHi(-1);
    if (v.trim().length >= 2) void api.suggestContacts(v.trim()).then(setSugg).catch(() => setSugg([]));
    else setSugg([]);
  };

  return (
    <div className="cf-field rcpt" onClick={() => input.current?.focus()}>
      <label>{label}</label>
      <div className="chips">
        {values.map((v) => (
          <span key={v} className={`rchip ${EMAIL.test(bareAddress(v)) ? "" : "bad"}`} title={EMAIL.test(bareAddress(v)) ? v : "This does not look like an email address"}>
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
        ))}
        <input
          ref={input}
          value={text}
          aria-label={label}
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

export function Compose({ init }: { init: ComposeInit }) {
  const { accounts, openCompose, showToast, prefs, refresh, confirm, setComposeDirty, setComposeSaver, aiConfigured, setDialog } = useStore();
  const [accountId, setAccountId] = useState(init.accountId || prefs.defaultAccount || accounts[0]?.id || "");
  const isFresh = !init.replaces && !init.isReply;
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
  const [sigId, setSigId] = useState<string>("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [dragging, setDragging] = useState(false);
  const touched = useRef(false);
  const ccTouched = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const schedRef = useRef<HTMLDivElement>(null);
  useOutside(schedRef, () => setSchedOpen(false), schedOpen);

  const touch = useCallback(() => {
    touched.current = true;
    setComposeDirty(true);
  }, [setComposeDirty]);

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "Write your message…" })],
    content: init.bodyHtml ? (init.replaces ? init.bodyHtml : `<p></p>${init.bodyHtml}`) : "<p></p>",
    autofocus: (init.to?.length ?? 0) > 0 ? "start" : false,
    onUpdate: () => touch(),
  });

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
    if (!loaded || init.replaces) return;
    if (sigId && (sigId === "none" || mySigs.some((s) => s.id === sigId))) return; // keep a valid manual choice
    if (init.isReply && !eff(prefs, accountId, "signatureOnReply")) return setSigId("none");
    setSigId(defaultSig());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, accountId]);

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

  const sigHtml = () => {
    const s = mySigs.find((x) => x.id === sigId);
    return s ? `<br><div class="sig">-- <br>${s.html}</div>` : "";
  };

  const buildDraft = () => {
    const body = (editor?.getHTML() ?? "") + sigHtml();
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
    };
  };

  const reopen = (d: ReturnType<typeof buildDraft>) =>
    void useStore.getState().openCompose({
      ...init,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyHtml: d.html,
      accountId: d.accountId,
      attachments: d.attachments,
      replaces: init.replaces,
      isReply: false,
    });

  const totalBytes = atts.reduce((n, a) => n + approxBytes(a), 0);

  const send = async (sendAt?: number) => {
    const d = buildDraft();
    if (d.to.length === 0) return showToast("Add at least one recipient", undefined, "error");
    const bad = [...d.to, ...d.cc, ...d.bcc].filter((a) => !EMAIL.test(bareAddress(a)));
    if (bad.length) return showToast(`Check the address: ${bad[0]}`, undefined, "error");
    if (!accountId) return showToast("No account selected", undefined, "error");
    if (totalBytes > MAX_ATTACH_BYTES) return showToast(`Attachments are ${fmtSize(totalBytes)}; most servers accept at most 25 MB`, undefined, "error");
    if (!d.subject && !(await confirm({ title: "Send without a subject?", confirmLabel: "Send anyway" }))) return;
    setBusy(true);
    setComposeDirty(false);
    void openCompose(null);
    if (sendAt) {
      try {
        await api.sendMessage(d, sendAt, init.replaces);
        showToast(`Scheduled for ${new Date(sendAt * 1000).toLocaleString()}`, undefined, "success");
        void refresh();
      } catch (e) {
        showToast(`Schedule failed: ${friendlyError(e)}`, undefined, "error");
        reopen(d);
      }
      return;
    }
    const wait = eff(prefs, accountId, "undoSeconds");
    let cancelled = false;
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
      }
    }, wait * 1000);
    if (wait > 0) {
      showToast(
        "Sending…",
        () => {
          cancelled = true;
          clearTimeout(t);
          reopen(d);
        },
        "info",
      );
    }
  };

  const saveDraft = useCallback(
    async (close: boolean) => {
      try {
        await api.saveDraft(buildDraft(), init.replaces);
        showToast("Draft saved", undefined, "success");
        setComposeDirty(false);
        if (close) void openCompose(null);
        void useStore.getState().sync();
      } catch (e) {
        showToast(`Save draft failed: ${friendlyError(e)}`, undefined, "error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [to, cc, bcc, subject, atts, accountId, sigId, editor],
  );

  // let the store save this draft when another message is opened over it
  useEffect(() => {
    setComposeSaver(() => saveDraft(false));
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
      const bytes = next.reduce((n, x) => n + approxBytes(x), 0);
      if (bytes > MAX_ATTACH_BYTES) showToast(`Attachments total ${fmtSize(bytes)}; most servers accept at most 25 MB`, undefined, "error");
      return next;
    });
    touch();
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

  const draftsHint = init.replaces;

  return (
    <div
      className={`compose-pane ${dragging ? "dragging" : ""}`}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          void send();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
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
          <button className="btn primary" disabled={busy} onClick={() => void send()} title="Send (Ctrl+Enter)">
            <Send size={14} /> Send
          </button>
          <button className="btn primary split-caret" aria-label="Schedule send" title="Send later" onClick={() => setSchedOpen((o) => !o)}>
            <ChevronDown size={14} />
          </button>
          {schedOpen && (
            <div className="popover up sched">
              <div className="sb-title">Send later</div>
              {snoozePresets(prefs.snoozeTimes).map((p) => (
                <button key={p.label} className="menu-row" onClick={() => (setSchedOpen(false), void send(p.ts))}>
                  <CalendarClock size={14} />
                  <span className="menu-lbl">{p.label}</span>
                </button>
              ))}
              <div className="row-inline">
                <input type="datetime-local" value={custom} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={(e) => setCustom(e.target.value)} />
                <button className="btn primary" disabled={!custom} onClick={() => (setSchedOpen(false), void send(Math.floor(new Date(custom).getTime() / 1000)))}>
                  Schedule
                </button>
              </div>
            </div>
          )}
        </div>
        <button className="rb" onClick={() => void discard()}><Trash2 size={15} /><span>Discard</span></button>
        <button className="rb" onClick={() => fileRef.current?.click()}><Paperclip size={15} /><span>Attach</span></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ""))} />
        <button className="rb" onClick={() => void saveDraft(true)}><Save size={15} /><span>Save draft</span></button>
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
        <select className="sig-select" value={sigId} onChange={(e) => (setSigId(e.target.value), touch())} title="Signature" aria-label="Signature">
          <option value="none">No signature</option>
          {mySigs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          {!sigId && <option value="">Automatic</option>}
        </select>
      </div>

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
          <select value={accountId} onChange={(e) => changeAccount(e.target.value)} aria-label="From">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}
          </select>
        </div>
        <RecipientField label="To" values={to} onChange={setTo} autoFocus={to.length === 0 && !init.replaces} onTouch={touch} />
        {showCc ? (
          <>
            <RecipientField label="Cc" values={cc} onChange={setCc} onTouch={() => ((ccTouched.current = true), touch())} />
            <RecipientField label="Bcc" values={bcc} onChange={setBcc} onTouch={() => ((ccTouched.current = true), touch())} />
          </>
        ) : (
          <div className="cf-links">
            <button className="link" onClick={() => setShowCc(true)}>Cc</button>
            <button className="link" onClick={() => setShowCc(true)}>Bcc</button>
          </div>
        )}
        <div className="cf-field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => (setSubject(e.target.value), touch())} placeholder="Add a subject" aria-label="Subject" />
        </div>
      </div>

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
      </div>

      <div className="cp-editor">
        <EditorContent editor={editor} className="editor" />
        {sigId && sigId !== "none" && <div className="sig-note muted small">Signature “{mySigs.find((s) => s.id === sigId)?.name}” will be added when you send.</div>}
      </div>

      {atts.length > 0 && (
        <div className="atts cp-atts">
          {atts.map((a, i) => (
            <span key={i} className="att-chip">
              <Paperclip size={13} /> <span className="ellipsis">{a.filename}</span> <span className="muted small">{fmtSize(approxBytes(a))}</span>
              <button className="icon-btn" aria-label={`Remove ${a.filename}`} onClick={() => (setAtts((x) => x.filter((_, j) => j !== i)), touch())}><X size={12} /></button>
            </span>
          ))}
          <span className={`muted small ${totalBytes > MAX_ATTACH_BYTES ? "err" : ""}`}>{fmtSize(totalBytes)} of 25 MB</span>
        </div>
      )}
      {draftsHint && <div className="muted small cp-foot">Editing a draft. Sending or saving replaces the original.</div>}
      {dragging && <div className="drop-hint">Drop files to attach</div>}
    </div>
  );
}
