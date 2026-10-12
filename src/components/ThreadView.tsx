import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertOctagon, Archive, Ban, Clock, Forward, MailX, Pin, Reply, ReplyAll, Sparkles, Star, Trash2, MailMinus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, MessageFull } from "../api";
import { useStore } from "../store";
import { fmtFull, hue, initials, plainToHtml, quoteHtml, sanitizeHtml, splitAddrs } from "../util";
import { SnoozeMenu } from "./SnoozeMenu";

function MessageBody({ m }: { m: MessageFull }) {
  const loadRemote = useStore((s) => s.loadRemote);
  const [allow, setAllow] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const { html, blocked } = useMemo(
    () => (m.html ? sanitizeHtml(m.html, loadRemote || allow) : { html: plainToHtml(m.text ?? ""), blocked: 0 }),
    [m, loadRemote, allow],
  );
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
    <style>body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:0;padding:4px 2px;word-wrap:break-word;color:${dark ? "#e6e6e6" : "#1a1a1a"}}
    img{max-width:100%;height:auto}blockquote{margin:0 0 0 .8ex;border-left:2px solid #999;padding-left:1ex}a{color:#2a7de1}table{max-width:100%}</style>
    </head><body>${html}</body></html>`;

  const onLoad = () => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const resize = () => {
      if (ref.current) ref.current.style.height = `${doc.documentElement.scrollHeight + 8}px`;
    };
    resize();
    doc.querySelectorAll("img").forEach((i) => i.addEventListener("load", resize));
    doc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (a?.href) {
        e.preventDefault();
        void openUrl(a.href);
      }
    });
  };

  return (
    <>
      {blocked > 0 && !allow && !loadRemote && (
        <div className="notice">
          Remote content blocked (trackers & images).{" "}
          <button className="link" onClick={() => setAllow(true)}>
            Load once
          </button>
        </div>
      )}
      {/* sandbox without allow-scripts: no script can run; allow-same-origin only lets us read height / hook links */}
      <iframe ref={ref} className="msg-frame" sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={onLoad} title={m.id} />
    </>
  );
}

function MessageCard({ m, open, onToggle, onReply, onReplyAll, onForward }: {
  m: MessageFull;
  open: boolean;
  onToggle: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
}) {
  const showToast = useStore((s) => s.showToast);
  const who = m.fromName || m.fromEmail;
  const unsub = async () => {
    try {
      const r = await api.unsubscribe(m.id);
      if (r.kind === "done") showToast("Unsubscribed");
      else if (r.kind === "open") await openUrl(r.target);
      else useStore.getState().openCompose({ accountId: m.accountId, to: [r.target.replace("mailto:", "").split("?")[0]], subject: "unsubscribe" });
    } catch (e) {
      showToast(`Unsubscribe failed: ${e}`);
    }
  };
  return (
    <div className={`msg ${open ? "open" : ""}`}>
      <div className="msg-head" onClick={onToggle}>
        <div className="avatar sm" style={{ background: `hsl(${hue(who)} 55% 45%)` }}>
          {initials(who)}
        </div>
        <div className="msg-meta">
          <div className="ellipsis">
            <b>{who}</b> <span className="muted">&lt;{m.fromEmail}&gt;</span>
          </div>
          <div className="muted small ellipsis">{open ? `to ${m.to}${m.cc ? `, cc ${m.cc}` : ""}` : (m.text ?? "").slice(0, 120)}</div>
        </div>
        <div className="muted small">{fmtFull(m.date)}</div>
      </div>
      {open && (
        <div className="msg-body">
          <MessageBody m={m} />
          <div className="msg-actions">
            <button className="btn" onClick={onReply}>
              <Reply size={14} /> Reply
            </button>
            <button className="btn" onClick={onReplyAll}>
              <ReplyAll size={14} /> Reply all
            </button>
            <button className="btn" onClick={onForward}>
              <Forward size={14} /> Forward
            </button>
            {m.canUnsubscribe && (
              <button className="btn" onClick={unsub}>
                <MailMinus size={14} /> Unsubscribe
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadView() {
  const { selected, messages, threads, act, accounts, openCompose, showToast } = useStore();
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [snooze, setSnooze] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const summ = threads.find((t) => t.threadId === selected);

  useEffect(() => {
    setSummary(null);
    setOpenIds(new Set(messages.length ? [messages[messages.length - 1].id] : []));
  }, [selected, messages.length]);

  if (!selected || !summ) return <section className="reader empty">Select a conversation</section>;

  const last = messages[messages.length - 1];
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));

  const reply = (m: MessageFull, all: boolean) => {
    const to = all
      ? [m.fromEmail, ...splitAddrs(m.to)].filter((e) => !mine.has(e.toLowerCase()))
      : [m.fromEmail];
    const cc = all ? splitAddrs(m.cc).filter((e) => !mine.has(e.toLowerCase())) : [];
    openCompose({
      accountId: m.accountId,
      to: Array.from(new Set(to)),
      cc,
      subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      bodyHtml: quoteHtml(m),
      inReplyTo: m.messageId,
      references: messages.map((x) => x.messageId).filter(Boolean) as string[],
    });
  };
  const forward = (m: MessageFull) =>
    openCompose({
      accountId: m.accountId,
      subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      bodyHtml: `<br><br>---------- Forwarded message ----------<br>From: ${m.fromName} &lt;${m.fromEmail}&gt;<br>Date: ${fmtFull(m.date)}<br>Subject: ${m.subject}<br><br>${m.html ? sanitizeHtml(m.html, false).html : plainToHtml(m.text ?? "")}`,
    });

  const summarize = async () => {
    setBusy(true);
    try {
      const body = messages
        .map((m) => `From: ${m.fromName} <${m.fromEmail}>\nDate: ${fmtFull(m.date)}\n\n${(m.text ?? "").slice(0, 4000)}`)
        .join("\n\n-----\n\n")
        .slice(0, 24000);
      setSummary(
        await api.aiComplete(
          "You summarize email conversations. Reply with 2-5 concise bullet points covering key facts, decisions and requested actions. Use the language of the emails.",
          `Subject: ${summ.subject}\n\n${body}`,
        ),
      );
    } catch (e) {
      showToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const id = [selected];
  return (
    <section className="reader">
      <div className="reader-head">
        <h2 className="ellipsis">{summ.subject}</h2>
        <div className="toolbar">
          <button className="icon-btn" title="Archive (e)" onClick={() => act(id, "archive", undefined, "Archived")}>
            <Archive size={16} />
          </button>
          <button className="icon-btn" title="Trash (#)" onClick={() => act(id, "trash", undefined, "Moved to trash")}>
            <Trash2 size={16} />
          </button>
          <button className="icon-btn" title="Report junk (!)" onClick={() => act(id, "junk", undefined, "Moved to junk")}>
            <AlertOctagon size={16} />
          </button>
          <button className="icon-btn" title="Snooze (s)" onClick={() => setSnooze(true)}>
            <Clock size={16} />
          </button>
          <button className={`icon-btn ${summ.pinned ? "on" : ""}`} title="Pin (p)" onClick={() => act(id, summ.pinned ? "unpin" : "pin")}>
            <Pin size={16} />
          </button>
          <button className={`icon-btn ${summ.flagged ? "on" : ""}`} title="Star (*)" onClick={() => act(id, summ.flagged ? "unstar" : "star")}>
            <Star size={16} />
          </button>
          <button className="icon-btn" title="Block sender" onClick={() => last && act(id, "block", undefined, `Blocked ${last.fromEmail}`)}>
            <Ban size={16} />
          </button>
          <button className="icon-btn" title="Mark unread (u)" onClick={() => act(id, "unread", undefined, "Marked unread")}>
            <MailX size={16} />
          </button>
          <button className="btn" onClick={summarize} disabled={busy}>
            <Sparkles size={14} /> {busy ? "Summarizing…" : "Summarize"}
          </button>
        </div>
      </div>
      {summary && (
        <div className="summary">
          <b>
            <Sparkles size={13} /> Conversation summary
          </b>
          <div className="pre">{summary}</div>
        </div>
      )}
      <div className="reader-body">
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            m={m}
            open={openIds.has(m.id)}
            onToggle={() =>
              setOpenIds((s) => {
                const n = new Set(s);
                n.has(m.id) ? n.delete(m.id) : n.add(m.id);
                return n;
              })
            }
            onReply={() => reply(m, false)}
            onReplyAll={() => reply(m, true)}
            onForward={() => forward(m)}
          />
        ))}
      </div>
      {snooze && <SnoozeMenu ids={id} onClose={() => setSnooze(false)} />}
    </section>
  );
}
