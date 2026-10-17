// The reader window (REQ-R1 ... R13, spec 5.3): one conversation in a window of its own, drawn with the components of the reading pane
// (MessageCard: the same sanitiser, sandboxed frame, remote-picture rules, attachments, invitations, PGP cards, translation).
//
// How it fits the multi-window design (see views.tsx): the window has its own JS store, filled once from the backend (accounts, folders,
// preferences, the AI flag, the conversation) and re-read when `mail-synced` / `thread-state` / `calendar-changed` / `prefs-changed` say
// something changed. Nothing here writes mail state or preferences: read / flag / pin, moves with Undo, the mail background switch, the
// dialogs of the main window and the compose window are asked of the main page (`askMain`, readerBridge.ts), which does them with its
// own machinery and tells the result. The yes/no states show the answer at once (`Wanted`) and are read again when the request is done.
import { AlertTriangle, Archive, ChevronsDownUp, ChevronsUpDown, Clock, Flag, Forward, Mail, MailX, MoreHorizontal, Pin, Reply, ReplyAll, Sparkles, Trash2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { forward, replyTo } from "../actions";
import { api, type MessageFull } from "../api";
import { AiRunning, MessageCard, TRANSLATE_TO, translateMessage, useKeepReadingPosition } from "../components/ReadingPane";
import { GuardMenuHost } from "../components/GuardMenuHost";
import { ShowOriginal } from "../components/Dialogs";
import { needsCard, PassphraseHost } from "../components/Pgp";
import { Dropdown } from "../components/ui";
import { t as tNow } from "../i18n";
import { useLang, useT } from "../i18n/react";
import { accountsOf, canMoveToJunk } from "../junk";
import { osNow, loadPlatform } from "../platform";
import { useContentProtection } from "../protect";
import { friendlyError, useStore } from "../store";
import { useAiSlot } from "../useAiSlot";
import { configureDates, fmtFull, snoozePresets, subjectText } from "../util";
import { senderOf } from "../rowMenu";
import { askMain, cancelRunningTranslations, installReaderBridge } from "./readerBridge";
import {
  allowedWhenGone, isFlagged, isGone, isUnread, markReadPlan, readerInit, readerKey, readerTitleText, threadScope, withWanted,
  type ReaderAction, type ReaderInit, type Wanted,
} from "./readerLogic";
import { popoutTitle } from "./route";
import type { PopoutViewProps } from "./views";

const quiet = () => undefined;
const closeWindow = () => void getCurrentWindow().close().catch(quiet);

/** A request for a state change (flag, pin, read) takes up to this long: the main page asks the server and answers when it has it. */
const STATE_WAIT_MS = 60_000;
/** A move waits for the main page to look up the folder and queue the move with its Undo window. */
const MOVE_WAIT_MS = 30_000;

export default function ReaderView({ init }: PopoutViewProps) {
  const info = useMemo(() => readerInit(init), [init]);
  if (!info) return <ReaderFailed text={tNow("reading.popout.loadFailed", { error: tNow("reading.popout.noId") })} />;
  return <Reader info={info} />;
}

function ReaderFailed({ text, retry }: { text: string; retry?: () => void }) {
  const t = useT();
  return (
    <div className="reader-win">
      <div className="reader-state" role="alert">
        <AlertTriangle size={22} aria-hidden />
        <p>{text}</p>
        <div className="reader-state-actions">
          {retry && <button className="btn primary" onClick={retry}>{t("common.retry")}</button>}
          <button className="btn" onClick={closeWindow}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

function Reader({ info }: { info: ReaderInit }) {
  const t = useT();
  const lang = useLang();
  const messages = useStore((s) => s.messages);
  const prefs = useStore((s) => s.prefs);
  const folders = useStore((s) => s.folders);
  const aiConfigured = useStore((s) => s.aiConfigured);
  const dialog = useStore((s) => s.dialog);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [gone, setGone] = useState(false);
  const [meta, setMeta] = useState<{ pinned: boolean; snoozedUntil: number | null }>({ pinned: false, snoozedUntil: null });
  const [busy, setBusy] = useState(false); // a move waits for the main window
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const ai = useAiSlot("summarize");
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // what the database said last, what this window asked for since, and the bookkeeping of the loads
  const base = useRef<MessageFull[]>([]);
  const wanted = useRef<Wanted>({});
  const goneRef = useRef(false);
  const loadSeq = useRef(0);
  const pending = useRef(0); // state requests under way
  const known = useRef(new Set<string>()); // the messages this window has seen: the mark-as-read rule looks at a message once
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadRef = useRef<(first?: boolean) => Promise<void>>(async () => undefined);

  configureDates(prefs); // dates in the message headers follow the date / time format of the preferences

  // the conversation shown through what was asked in this window
  const paint = useCallback(() => useStore.setState({ messages: withWanted(base.current, wanted.current), selected: info.threadId }), [info.threadId]);

  // ---- mark as read (REQ-R8): the rule of the reading pane, done by the main page
  const stateRequest = useCallback(
    async (action: string, patch: Wanted, labelKey?: string) => {
      wanted.current = { ...wanted.current, ...patch };
      paint();
      redraw();
      pending.current++;
      await askMain("thread-action", { threadId: info.threadId, action, labelKey, view: info.view }, STATE_WAIT_MS);
      pending.current--;
      if (pending.current === 0) {
        // the last answer is in: the database says how it went (a failure is rolled back by reading it again)
        wanted.current = {};
        void loadRef.current();
      }
    },
    [info.threadId, info.view, paint],
  );
  const planRead = useCallback(
    (msgs: MessageFull[]) => {
      // only what arrived since the last look is judged: the conversation as it was opened, and a reply that comes in while it is open.
      // Mail the person marks unread here is not marked read again by this rule.
      const fresh = msgs.filter((m) => !known.current.has(m.id));
      fresh.forEach((m) => known.current.add(m.id));
      const plan = markReadPlan(fresh, useStore.getState().prefs.markReadDelay);
      if (plan.kind === "none") return;
      clearTimeout(readTimer.current);
      const go = () => {
        if (!goneRef.current) void stateRequest("read", { unread: false });
      };
      if (plan.kind === "now") go();
      else readTimer.current = setTimeout(go, plan.ms);
    },
    [stateRequest],
  );

  // ---- reading the conversation
  const load = useCallback(
    async (first = false) => {
      const my = ++loadSeq.current;
      try {
        const [msgs, m, accounts, fl] = await Promise.all([
          api.getThread(info.threadId, threadScope(info.folder)),
          api.threadMeta(info.threadId).catch(() => null),
          api.listAccounts().catch(() => null),
          api.listFolders().catch(() => null),
        ]);
        if (my !== loadSeq.current) return; // a newer read is under way
        if (accounts) useStore.setState({ accounts });
        if (fl) useStore.setState({ folders: fl });
        if (m) setMeta(m);
        // the mailbox was removed: its conversation is gone with it
        const removed = accounts !== null && info.accountId !== "" && !accounts.some((a) => a.id === info.accountId);
        const isG = removed || isGone(msgs, info.folder);
        goneRef.current = isG;
        setGone(isG);
        if (!isG || first) {
          base.current = msgs; // (a conversation that is gone keeps showing what was read last)
          paint();
        }
        setPhase("ready");
        if (!isG) planRead(msgs);
      } catch (e) {
        if (first || phase !== "ready") {
          setError(friendlyError(e));
          setPhase("error");
        }
      }
    },
    [info.threadId, info.folder, info.accountId, paint, planRead, phase],
  );
  loadRef.current = load;

  // the first load, and the listeners that keep the window current
  useEffect(() => {
    let dead = false;
    let off: (() => void) | undefined;
    const subs: Array<Promise<() => void>> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // the AI Assistant may have been set up in Settings (main window) since this window opened
    const onFocus = () => void useStore.getState().refreshAi();
    window.addEventListener("focus", onFocus);
    const later = () => {
      // events come in bursts (a sync, several actions): one read after a short pause
      clearTimeout(timer);
      timer = setTimeout(() => void loadRef.current(), 250);
    };
    void (async () => {
      await loadPlatform(); // (Print and the Delete key differ on macOS)
      useStore.setState({ selected: info.threadId });
      void useStore.getState().refreshAi();
      off = await installReaderBridge({ reload: later });
      if (dead) return off();
      subs.push(
        listen("mail-synced", later),
        listen<{ threadIds?: string[] }>("thread-state", (e) => {
          if (!e.payload?.threadIds || e.payload.threadIds.includes(info.threadId)) later();
        }),
        listen("calendar-changed", () => {
          if (useStore.getState().messages.some((m) => m.invite)) later();
        }),
      );
      await loadRef.current(true);
    })();
    return () => {
      dead = true;
      clearTimeout(timer);
      clearTimeout(readTimer.current);
      window.removeEventListener("focus", onFocus);
      off?.();
      for (const s of subs) void s.then((f) => f()).catch(quiet);
      cancelRunningTranslations();
    };
  }, [info.threadId]);

  // the window leaves with its translations: a request under way is dropped (the backend also drops the AI requests of a window that is destroyed)
  useEffect(() => {
    const bye = () => cancelRunningTranslations();
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, []);

  // a new message arrives: it is open and the older ones fold, as in the reading pane; a summary of the old conversation is dropped
  useEffect(() => {
    setSummary(null);
    setOpenIds(new Set(messages.length ? [messages[messages.length - 1].id] : []));
  }, [messages.length]);
  useEffect(() => ai.cancel, []); // eslint-disable-line react-hooks/exhaustive-deps
  useKeepReadingPosition();
  useContentProtection(messages.some((m) => m.confidential)); // confidential mail: the window is out of screen capture (REQ-R3)

  // the window title: the subject (REQ-W7), in the language in use
  const subject = messages[0]?.subject ?? info.subject;
  const title = subjectText(readerTitleText(subject, "(no subject)"));
  useEffect(() => {
    const w = popoutTitle(title);
    document.title = w;
    void getCurrentWindow().setTitle(w).catch(quiet);
  }, [title, lang]);

  // the toolbar shows its labels while they fit, then keeps them on the main buttons only, then shows icons only (name and shortcut in the
  // tooltip): the window may be as narrow as 520 px, and the labels are longer in some languages (REQ-R4)
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // two steps: first the secondary buttons (flag, read state, snooze) lose their words, then all of them
    const fit = () => {
      bar.classList.remove("part", "compact");
      if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("part");
      if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("compact");
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [lang, phase, gone, ai.running, aiConfigured, messages.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // initial focus: the subject, so that a screen reader says it (5.4); Tab then goes toolbar > message
  useEffect(() => {
    if (phase === "ready") titleRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const last = messages[messages.length - 1];
  const conf = !!last?.confidential;
  const shownWanted = wanted.current;
  const flagged = isFlagged(messages);
  const unread = isUnread(messages);
  const pinned = shownWanted.pinned ?? meta.pinned;
  const junkOk = canMoveToJunk(folders, accountsOf([{ threadId: info.threadId, accountId: info.accountId }], [info.threadId]));
  const allOpen = messages.length > 0 && openIds.size === messages.length;
  const off = (a: ReaderAction) => gone && !allowedWhenGone(a);
  const locked = busy;

  // ---- the actions
  const cancelRead = () => clearTimeout(readTimer.current); // a choice of the person about the read state ends the automatic one
  const move = useCallback(
    async (action: string, labelKey?: string, labelParams?: Record<string, string>, arg?: string) => {
      setBusy(true);
      cancelRead();
      const ok = await askMain("thread-action", { threadId: info.threadId, action, arg, labelKey, labelParams, view: info.view }, MOVE_WAIT_MS);
      if (ok) closeWindow(); // REQ-R6: the window closes at once; the toast with Undo is in the main window
      else setBusy(false);
    },
    [info.threadId, info.view],
  );
  const doReply = (all: boolean) => last && void replyTo(last, all);
  const doForward = () => {
    if (!last) return;
    if (last.confidential) return useStore.getState().showToast(tNow("app.forward.confidential"), undefined, "info");
    void forward(last);
  };
  const toggleFlag = () => {
    cancelRead();
    void stateRequest(flagged ? "unstar" : "star", { flagged: !flagged });
  };
  const togglePin = () => {
    cancelRead();
    void stateRequest(pinned ? "unpin" : "pin", { pinned: !pinned });
  };
  const toggleRead = () => {
    cancelRead();
    if (unread) void stateRequest("read", { unread: false });
    else void stateRequest("unread", { unread: true }, "reading.head.markedUnread");
  };
  const block = async () => {
    if (!last) return;
    const ok = await useStore.getState().confirm({
      title: t("reading.head.blockTitle", { email: last.fromEmail }),
      body: t("reading.head.blockBody"),
      confirmLabel: t("reading.head.blockConfirm"),
      danger: true,
    });
    if (ok) void move("block", "reading.head.blocked", { email: last.fromEmail });
  };
  const printLast = () => {
    const frames = document.querySelectorAll<HTMLIFrameElement>(".rp-msg.open iframe.msg-frame");
    frames[frames.length - 1]?.contentWindow?.print();
  };
  const summarize = async () => {
    if (!aiConfigured) {
      useStore.getState().setDialog({ type: "settings", tab: "ai" }); // opens in the main window
      return;
    }
    const readable = messages.filter((m) => !needsCard(m) && !m.confidential);
    const st = useStore.getState();
    if (readable.length === 0) {
      st.showToast(messages.some((m) => m.confidential) ? t("reading.ai.noConfidential") : t("reading.ai.unlockEncrypted"), undefined, "info");
      return;
    }
    const body = readable
      .map((m) => `From: ${m.fromName} <${m.fromEmail}>\nDate: ${fmtFull(m.date)}\n\n${(m.text ?? "").slice(0, 4000)}`)
      .join("\n\n-----\n\n")
      .slice(0, 24000);
    const out = await ai.run(
      // i18n-ok: a prompt for the language model, not text the person reads
      "You summarize email conversations. Reply with 2-5 concise bullet points covering key facts, decisions and requested actions. Use the language of the emails.",
      `${messages.some((m) => m.confidential) ? "" : `Subject: ${subject}\n\n`}${body}`,
    );
    if (!out) return;
    if ("error" in out) st.showToast(() => friendlyError(out.error), undefined, "error");
    else setSummary(out.text);
  };

  // keys (REQ-R13): the table is readerKey; nothing while typing, nothing behind a dialog
  const act = (a: ReaderAction) => {
    if (off(a) || (locked && a !== "close")) return;
    switch (a) {
      case "close": return closeWindow();
      case "reply": return doReply(false);
      case "replyAll": return doReply(true);
      case "forward": return doForward();
      case "archive": return void move("archive", "reading.head.archived");
      case "trash": return void move("trash", "reading.head.trashed");
      case "junk": return junkOk ? void move("junk", "reading.head.movedJunk") : useStore.getState().showToast(t("mail.junk.noneTip"), undefined, "info");
      case "unread": return toggleRead();
      case "pin": return togglePin();
      case "flag": return toggleFlag();
      case "snooze": return document.querySelector<HTMLButtonElement>(".reader-bar button.snooze-btn")?.click();
      case "print": return conf ? undefined : printLast();
    }
  };
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const tgt = e.target;
      const inField = tgt instanceof Element && !!tgt.closest("input,textarea,select,[contenteditable=true]");
      const st = useStore.getState();
      const a = readerKey(e, { mac: osNow() === "macos", inField, modalOpen: !!(st.dialog || st.ask || st.passphrase) });
      if (!a || (a === "close" && (e.ctrlKey || e.metaKey))) return; // (Ctrl+W / Cmd+W: the root of the window closes it)
      e.preventDefault();
      actRef.current(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (phase === "error") return <ReaderFailed text={t("reading.popout.loadFailed", { error: error.replace(/\.$/, "") })} retry={() => { setPhase("loading"); void load(true); }} />;
  if (phase === "loading") {
    return (
      <div className="reader-win">
        <div className="reader-state" role="status" aria-busy="true">
          <span className="busy-ring spin" aria-hidden />
          <p className="muted">{t("reading.popout.loading")}</p>
        </div>
      </div>
    );
  }

  const rb = (key: string, label: string, tip: string | undefined, a: ReaderAction, onClick: () => void, icon: React.ReactNode, extra?: { on?: boolean; disabled?: boolean; why?: string; text?: string; sec?: boolean }) => (
    <button key={key} className={`rb ${extra?.on ? "on" : ""} ${extra?.sec ? "sec" : ""}`} title={extra?.why ?? tip ?? label} aria-label={label} aria-pressed={extra?.on} disabled={locked || off(a) || extra?.disabled} onClick={onClick}>
      {icon}
      <span>{extra?.text ?? label}</span>
    </button>
  );
  const sender = last ? senderOf(messages, new Set(useStore.getState().accounts.map((a) => a.email.toLowerCase()))) : null;

  return (
    <div className="reader-win">
      <div className="reader-bar" ref={barRef} role="toolbar" aria-label={t("reading.popout.toolbar")}>
        {rb("reply", t("reading.msg.reply"), `${t("reading.msg.reply")} (r)`, "reply", () => doReply(false), <Reply size={16} />)}
        {rb("replyAll", t("reading.msg.replyAll"), `${t("reading.msg.replyAll")} (a)`, "replyAll", () => doReply(true), <ReplyAll size={16} />)}
        {rb("forward", t("reading.msg.forward"), conf ? t("reading.msg.forwardBlocked") : `${t("reading.msg.forward")} (f)`, "forward", doForward, <Forward size={16} />, { disabled: conf })}
        <span className="sep" aria-hidden />
        {rb("archive", t("reading.head.archive"), t("reading.head.archiveTip"), "archive", () => void move("archive", "reading.head.archived"), <Archive size={16} />)}
        {rb("delete", t("reading.head.delete"), t("reading.head.deleteTip"), "trash", () => void move("trash", "reading.head.trashed"), <Trash2 size={16} />)}
        <span className="sep" aria-hidden />
        {rb("flag", flagged ? t("mail.hover.unflag") : t("reading.head.flag"), t("reading.head.flagTip"), "flag", toggleFlag, <Flag size={16} fill={flagged ? "currentColor" : "none"} />, { on: flagged, sec: true })}
        {rb("unread", unread ? t("mail.hover.markRead") : t("reading.head.markUnread"), unread ? undefined : `${t("reading.head.markUnread")} (u)`, "unread", toggleRead, unread ? <Mail size={16} /> : <MailX size={16} />, { text: unread ? t("reading.popout.read") : t("reading.popout.unread"), sec: true })}
        <Dropdown
          className="rb snooze-btn sec"
          title={t("reading.head.snoozeTip")}
          disabled={locked || off("snooze")}
          items={snoozePresets(prefs.snoozeTimes).map((p) => ({ label: p.label, onClick: () => void move("snooze", "reading.head.snoozed", { label: p.label }, String(p.ts)) }))}
        >
          <Clock size={16} />
          <span>{t("app.ribbon.snooze")}</span>
        </Dropdown>
        <span className="sep" aria-hidden />
        <Dropdown
          className="rb"
          title={t("reading.head.more")}
          disabled={locked}
          items={[
            { label: pinned ? t("mail.hover.unpin") : t("reading.head.pin"), icon: <Pin size={14} />, disabled: gone, onClick: togglePin },
            { label: t("reading.head.moveJunk"), disabled: gone || !junkOk, title: junkOk ? undefined : t("mail.junk.noneTip"), onClick: () => void move("junk", "reading.head.movedJunk") },
            { label: t("reading.head.blockSender"), disabled: gone || !junkOk || !last, onClick: () => void block() },
            { divider: true },
            { label: t("reading.msg.showOriginal"), disabled: conf || !last, onClick: () => last && useStore.getState().setDialog({ type: "original", messageId: last.id }) },
            ...(osNow() === "macos" ? [] : [{ label: t("reading.msg.print"), disabled: conf, onClick: printLast }]),
            { label: t("reading.msg.createEvent"), disabled: !last, onClick: () => last && useStore.getState().setDialog({ type: "event", init: { summary: last.subject.replace(/^((re|fwd?):\s*)+/i, ""), description: conf ? "" : (last.text ?? "").trim().slice(0, 1500) } }) },
            { label: t("reading.msg.copySender"), disabled: !sender, onClick: () => sender && void navigator.clipboard.writeText(sender).then(() => useStore.getState().showToast(t("reading.msg.copied"))) },
            { divider: true },
            ...TRANSLATE_TO.map((l) => ({ label: t("reading.msg.translateTo", { lang: t(l.key) }), disabled: conf || !last || needsCard(last), onClick: () => last && translateMessage(last, l) })),
          ]}
        >
          <MoreHorizontal size={16} />
        </Dropdown>
        <button className="rb ai-btn grow" onClick={summarize} disabled={ai.running || messages.length === 0} title={aiConfigured ? t("reading.head.summarizeTip") : t("reading.head.setupAiTip")}>
          <Sparkles size={16} />
          <span>{ai.running ? t("reading.head.summarizing") : aiConfigured ? t("reading.head.summarize") : t("reading.head.setupAi")}</span>
        </button>
      </div>
      {gone && (
        <div className="notice reader-gone" role="alert">
          <span>{t("reading.popout.gone")}</span>
          <button className="btn small" onClick={closeWindow}>{t("common.close")}</button>
        </div>
      )}
      <section className="reading-pane reader-pane" aria-label={t("reading.pane.label")}>
        <div className="rp-head">
          <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
          {messages.length > 1 && (
            <button
              className="icon-btn"
              title={allOpen ? t("reading.head.collapseAllTip") : t("reading.head.expandAllTip")}
              aria-label={allOpen ? t("reading.head.collapseAll") : t("reading.head.expandAll")}
              onClick={() => setOpenIds(allOpen ? new Set([messages[messages.length - 1].id]) : new Set(messages.map((m) => m.id)))}
            >
              {allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
            </button>
          )}
        </div>
        {ai.running && ai.startedAt !== null && (
          <AiRunning title={<b><Sparkles size={13} /> {t("reading.head.summaryTitle")}</b>} text={t("reading.head.summarizing")} startedAt={ai.startedAt} onCancel={ai.cancel} />
        )}
        {summary && (
          <div className="summary">
            <b><Sparkles size={13} /> {t("reading.head.summaryTitle")}</b>
            <div className="pre">{summary}</div>
          </div>
        )}
        <div className="rp-body" ref={bodyRef}>
          {messages.map((m) => (
            <MessageCard
              key={m.id}
              m={m}
              open={openIds.has(m.id)}
              onToggle={() =>
                setOpenIds((s) => {
                  const n = new Set(s);
                  if (n.has(m.id)) n.delete(m.id);
                  else n.add(m.id);
                  return n;
                })
              }
            />
          ))}
        </div>
      </section>
      {dialog?.type === "original" && <ShowOriginal messageId={dialog.messageId} />}
      <PassphraseHost />
      <GuardMenuHost />
    </div>
  );
}
