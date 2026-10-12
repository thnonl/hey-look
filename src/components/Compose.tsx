import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, ChevronDown, Clock, Italic, List, Link2, Paperclip, Send, Sparkles, Underline as UIcon, X, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, Att, Contact, Signature, Template } from "../api";
import { ComposeInit, useStore } from "../store";
import { fileToBase64, htmlToText, snoozePresets, splitAddrs } from "../util";

function AddrField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [sugg, setSugg] = useState<Contact[]>([]);
  const onInput = async (v: string) => {
    onChange(v);
    const last = v.split(",").pop()?.trim() ?? "";
    setSugg(last.length >= 2 ? await api.suggestContacts(last) : []);
  };
  const pick = (c: Contact) => {
    const parts = value.split(",");
    parts[parts.length - 1] = ` ${c.email}`;
    onChange(parts.join(",").trim() + ", ");
    setSugg([]);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} onChange={(e) => onInput(e.target.value)} onBlur={() => setTimeout(() => setSugg([]), 150)} />
      {sugg.length > 0 && (
        <div className="suggest">
          {sugg.map((c) => (
            <div key={c.email} onMouseDown={() => pick(c)}>
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
  const { accounts, openCompose, showToast, undoSeconds, refresh } = useStore();
  const [accountId, setAccountId] = useState(init.accountId ?? accounts[0]?.id ?? "");
  const [to, setTo] = useState((init.to ?? []).join(", "));
  const [cc, setCc] = useState((init.cc ?? []).join(", "));
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState((init.cc ?? []).length > 0);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [atts, setAtts] = useState<Att[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [sigId, setSigId] = useState<string>("");
  const [menu, setMenu] = useState<"" | "schedule" | "templates" | "ai">("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "Write your message…" })],
    content: init.bodyHtml ? `<p></p>${init.bodyHtml}` : "<p></p>",
    autofocus: init.to?.length ? "start" : false,
  });

  useEffect(() => {
    void Promise.all([api.listTemplates(), api.listSignatures()]).then(([t, s]) => {
      setTemplates(t);
      setSigs(s);
      const def = s.find((x) => x.isDefault);
      if (def) setSigId(def.id);
    });
  }, []);

  const sigHtml = () => {
    const s = sigs.find((x) => x.id === sigId);
    return s ? `<br><div class="sig">-- <br>${s.html}</div>` : "";
  };

  const buildDraft = () => {
    const body = (editor?.getHTML() ?? "") + sigHtml();
    return {
      accountId,
      to: splitAddrs(to),
      cc: splitAddrs(cc),
      bcc: splitAddrs(bcc),
      subject,
      html: body,
      text: htmlToText(body),
      inReplyTo: init.inReplyTo ?? null,
      references: init.references ?? [],
      attachments: atts,
    };
  };

  const send = async (sendAt?: number) => {
    const d = buildDraft();
    if (d.to.length === 0) return showToast("Add at least one recipient");
    if (!accountId) return showToast("No account");
    if (!d.subject && !confirm("Send without a subject?")) return;
    setSending(true);
    openCompose(null);
    if (sendAt) {
      try {
        await api.sendMessage(d, sendAt);
        showToast(`Scheduled for ${new Date(sendAt * 1000).toLocaleString()}`);
        refresh();
      } catch (e) {
        showToast(`Schedule failed: ${e}`);
      }
      return;
    }
    // undo-send: delay actual send
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      try {
        await api.sendMessage(d, null);
        showToast("Message sent");
        void useStore.getState().sync();
      } catch (e) {
        showToast(`Send failed: ${e}`);
        useStore.getState().openCompose({ ...init, to: d.to, cc: d.cc, subject: d.subject, bodyHtml: d.html, accountId: d.accountId });
      }
    }, undoSeconds * 1000);
    if (undoSeconds > 0) {
      showToast("Sending…", () => {
        cancelled = true;
        clearTimeout(t);
        useStore.getState().openCompose({ ...init, to: d.to, cc: d.cc, subject: d.subject, bodyHtml: d.html, accountId: d.accountId });
      });
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const list: Att[] = [];
    for (const f of Array.from(files)) list.push({ filename: f.name, mime: f.type || "application/octet-stream", dataBase64: await fileToBase64(f) });
    setAtts((a) => [...a, ...list]);
  };

  const applyTemplate = (t: Template) => {
    if (t.subject && !subject) setSubject(t.subject);
    editor?.commands.insertContent(t.body);
    setMenu("");
  };

  const letAiWrite = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const out = await api.aiComplete(
        "You write email bodies. Output only the email body text (no subject line, no preamble). Match the language of the user's request and the tone requested.",
        `Subject: ${subject}\nExisting draft:\n${editor?.getText() ?? ""}\n\nInstruction: ${aiPrompt}`,
      );
      editor?.commands.insertContent(out.split("\n").map((l) => `<p>${l.replace(/</g, "&lt;")}</p>`).join(""));
      setMenu("");
      setAiPrompt("");
    } catch (e) {
      showToast(String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const [custom, setCustom] = useState("");

  return (
    <div className="compose">
      <div className="compose-head">
        <b>New message</b>
        <button className="icon-btn" onClick={() => openCompose(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="compose-body">
        <div className="field">
          <label>From</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
              </option>
            ))}
          </select>
        </div>
        <AddrField label="To" value={to} onChange={setTo} />
        {showCc ? (
          <>
            <AddrField label="Cc" value={cc} onChange={setCc} />
            <AddrField label="Bcc" value={bcc} onChange={setBcc} />
          </>
        ) : (
          <button className="link small" onClick={() => setShowCc(true)}>
            Add Cc / Bcc
          </button>
        )}
        <div className="field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="fmt">
          <button className="icon-btn" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={14} /></button>
          <button className="icon-btn" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={14} /></button>
          <button className="icon-btn" onClick={() => editor?.chain().focus().toggleUnderline?.().run()}><UIcon size={14} /></button>
          <button className="icon-btn" onClick={() => editor?.chain().focus().toggleBulletList().run()}><List size={14} /></button>
          <button
            className="icon-btn"
            onClick={() => {
              const url = prompt("Link URL");
              if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            }}
          >
            <Link2 size={14} />
          </button>
          <span className="sep" />
          <button className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}><Paperclip size={14} /></button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
          <button className="btn small" onClick={() => setMenu(menu === "templates" ? "" : "templates")}><FileText size={13} /> Templates</button>
          <button className="btn small" onClick={() => setMenu(menu === "ai" ? "" : "ai")}><Sparkles size={13} /> Let AI write</button>
          <select className="sig-select" value={sigId} onChange={(e) => setSigId(e.target.value)} title="Signature">
            <option value="">No signature</option>
            {sigs.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        {menu === "templates" && (
          <div className="popover">
            {templates.length === 0 && <div className="muted">No templates yet (Settings → Templates)</div>}
            {templates.map((t) => (
              <button key={t.id} className="menu-item" onClick={() => applyTemplate(t)}>{t.name}</button>
            ))}
          </div>
        )}
        {menu === "ai" && (
          <div className="popover">
            <textarea rows={3} placeholder="e.g. politely decline the meeting and propose next Tuesday" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
            <button className="btn primary" disabled={aiBusy} onClick={letAiWrite}>
              {aiBusy ? "Writing…" : "Write"}
            </button>
          </div>
        )}
        <EditorContent editor={editor} className="editor" />
        {atts.length > 0 && (
          <div className="atts">
            {atts.map((a, i) => (
              <span key={i} className="chip">
                {a.filename}
                <button onClick={() => setAtts((x) => x.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="compose-foot">
        <div className="split">
          <button className="btn primary" disabled={sending} onClick={() => send()}>
            <Send size={14} /> Send
          </button>
          <button className="btn primary dropdown" onClick={() => setMenu(menu === "schedule" ? "" : "schedule")}>
            <ChevronDown size={14} />
          </button>
          {menu === "schedule" && (
            <div className="popover up">
              {snoozePresets().map((p) => (
                <button key={p.label} className="menu-item" onClick={() => send(p.ts)}>
                  <Clock size={13} /> {p.label}
                </button>
              ))}
              <div className="row-inline">
                <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
                <button className="btn" disabled={!custom} onClick={() => send(Math.floor(new Date(custom).getTime() / 1000))}>
                  Schedule
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
