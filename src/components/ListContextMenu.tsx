import { Archive, AtSign, Clock, FolderInput, Flag, Forward, Mail, MailOpen, OctagonAlert, Pin, Reply, ReplyAll, Trash2, Type } from "lucide-react";
import { ReactNode, useRef, useState } from "react";
import { forward, replyTo } from "../actions";
import { api, MessageFull, ThreadSummary } from "../api";
import { isContextMenuKey, isKeyEcho } from "../contextMenu";
import { useT } from "../i18n/react";
import { moveChoices, contextTargets, rowMenu, senderOf } from "../rowMenu";
import type { Off, RowMenuEntry } from "../rowMenu";
import { copyToClipboard } from "../open";
import { folderLabel } from "../prefs";
import { friendlyError, scopeOf, useStore } from "../store";
import { snoozePresets, subjectText } from "../util";
import { ContextMenu, CtxItem } from "./ContextMenu";

interface Open {
  /** a new object per opening: the menu starts afresh when it is opened again */
  seq: number;
  ids: string[];
  at: { x: number; y: number };
  row: HTMLElement;
  keyboard: boolean;
}

/** The conversation's messages: the open conversation's, else read from the backend (nothing is marked read or opened by this). */
async function messagesOf(t: ThreadSummary): Promise<MessageFull[]> {
  const st = useStore.getState();
  if (st.selected === t.threadId && st.messages.length > 0) return st.messages;
  return api.getThread(t.threadId, scopeOf(st.folder)).catch(() => []);
}

/** Reply / reply all / forward on the last message of a conversation that may not be the open one. */
async function answer(t: ThreadSummary, kind: "reply" | "replyAll" | "forward") {
  const msgs = await messagesOf(t);
  const last = msgs[msgs.length - 1];
  if (!last) return;
  // encrypted mail that is not readable yet: the conversation opens (where the key / passphrase is asked for) instead of a blank quote
  if (last.security?.encrypted && last.security.decryption !== "ok") {
    void useStore.getState().select(t.threadId);
    return;
  }
  if (kind === "forward") forward(last, msgs);
  else replyTo(last, kind === "replyAll", msgs);
}

async function copyOf(text: string | null, done: () => string, failed: () => string) {
  const st = useStore.getState();
  if (text && (await copyToClipboard(text))) st.showToast(done, undefined, "success");
  else st.showToast(failed, undefined, "error"); // i18n-ok: a function, see the parameters
}

const ICON = 14;

function RowMenu({ open, onClose }: { open: Open; onClose: () => void }) {
  const tr = useT();
  const { threads, folders, folder, prefs, accounts, act } = useStore();
  const targets = open.ids.map((id) => threads.find((x) => x.threadId === id)).filter((x): x is ThreadSummary => !!x);
  if (targets.length === 0) return null;
  const ids = targets.map((x) => x.threadId);
  const first = targets[0];
  const entries = rowMenu(targets, { view: folder, folders });

  const why = (off: Off): Partial<CtxItem> => {
    switch (off) {
      case "many":
        return { title: tr("mail.ctx.onlyOne") };
      case "mailbox":
        return { title: tr("mail.ctx.oneMailbox") };
      case "junk":
        return { hint: tr("mail.junk.none"), title: tr("mail.junk.noneTip") }; // the Report menu's wording
      case "confidential":
        return { title: tr("app.ribbon.noForward") };
      default:
        return {};
    }
  };
  const item = (e: RowMenuEntry): CtxItem => {
    const off: Partial<CtxItem> = e.off ? { disabled: true, ...why(e.off) } : {};
    const run = (label: string, icon: ReactNode, onClick: () => void, extra: Partial<CtxItem> = {}): CtxItem => ({ label, icon, onClick, ...extra, ...off });
    switch (e.action) {
      case "reply":
        return run(tr("app.ribbon.reply"), <Reply size={ICON} />, () => void answer(first, "reply"));
      case "replyAll":
        return run(tr("app.ribbon.replyAll"), <ReplyAll size={ICON} />, () => void answer(first, "replyAll"));
      case "forward":
        return run(tr("app.ribbon.forward"), <Forward size={ICON} />, () => void answer(first, "forward"));
      case "read":
        return e.variant === "markRead"
          ? run(tr("mail.hover.markRead"), <MailOpen size={ICON} />, () => void act(ids, "read"))
          : run(tr("mail.hover.markUnread"), <Mail size={ICON} />, () => void act(ids, "unread"));
      case "flag":
        return e.variant === "unflag"
          ? run(tr("mail.hover.unflag"), <Flag size={ICON} fill="currentColor" />, () => void act(ids, "unstar"))
          : run(tr("mail.hover.flag"), <Flag size={ICON} />, () => void act(ids, "star"));
      case "pin":
        return e.variant === "unpin"
          ? run(tr("mail.hover.unpin"), <Pin size={ICON} fill="currentColor" />, () => void act(ids, "unpin"))
          : run(tr("mail.hover.pin"), <Pin size={ICON} />, () => void act(ids, "pin"));
      case "snooze":
        return run(tr("app.ribbon.snooze"), <Clock size={ICON} />, () => undefined, {
          submenu: snoozePresets(prefs.snoozeTimes).map((p) => ({ label: p.label, onClick: () => void act(ids, "snooze", String(p.ts), () => tr("mail.done.snoozed", { when: p.label })) })),
        });
      case "move": {
        const choices = moveChoices(folders, first.accountId, scopeOf(folder));
        return run(tr("app.ribbon.moveTo"), <FolderInput size={ICON} />, () => undefined, {
          submenu: choices.map((f) => ({ label: folderLabel(f.key, f.name), onClick: () => void act(ids, "move", f.key, () => tr("mail.done.moved", { folder: folderLabel(f.key, f.name) })) })),
          ...(choices.length === 0 ? { disabled: true } : {}),
        });
      }
      case "archive":
        return run(tr("app.ribbon.archive"), <Archive size={ICON} />, () => void act(ids, "archive", undefined, () => tr("mail.done.archived")));
      case "delete":
        return e.variant === "permanent"
          ? run(tr("mail.hover.deleteForever"), <Trash2 size={ICON} />, () => void act(ids, "trash", undefined, () => tr("mail.done.deleted")))
          : run(tr("common.delete"), <Trash2 size={ICON} />, () => void act(ids, "trash", undefined, () => tr("mail.done.trashed")));
      case "junk":
        return run(tr("app.ribbon.moveToJunk"), <OctagonAlert size={ICON} />, () => void act(ids, "junk", undefined, () => tr("mail.done.junk")));
      case "copySender":
        return run(tr("reading.msg.copySender"), <AtSign size={ICON} />, () =>
          void messagesOf(first).then((m) => copyOf(senderOf(m, new Set(accounts.map((a) => a.email.toLowerCase()))), () => tr("reading.msg.copied"), () => tr("mail.ctx.copyFailed"))).catch((err) =>
            useStore.getState().showToast(() => tr("errors.toast.failed", { error: friendlyError(err) }), undefined, "error")));
      case "copySubject":
        return run(tr("mail.ctx.copySubject"), <Type size={ICON} />, () => void copyOf(subjectText(first.subject), () => tr("reading.msg.copied"), () => tr("mail.ctx.copyFailed")));
    }
  };
  const items: CtxItem[] = [
    ...(targets.length > 1 ? [{ header: tr("mail.list.selected", { n: targets.length }) }] : []),
    ...entries.map((e) => (e === "-" ? { divider: true } : item(e))),
  ];
  // the menu is named by the row it was opened on (several conversations: by how many)
  return (
    <ContextMenu
      key={open.seq}
      at={open.at}
      items={items}
      labelledBy={targets.length === 1 ? open.row.id : undefined}
      label={targets.length > 1 ? tr("mail.list.selected", { n: targets.length }) : undefined}
      keyboard={open.keyboard}
      returnTo={open.row}
      onClose={onClose}
    />
  );
}

/**
 * The context menu of the mail list: right-click on a row, or the ContextMenu key / Shift+F10 on the focused row. Spread `handlers` on the
 * element that holds the rows and render `menu` next to it. A row that is not part of the selection becomes the selection first (the
 * mail is not opened); a row that is acts together with the rest of the selection.
 */
export function useRowContextMenu() {
  const [open, setOpen] = useState<Open | null>(null);
  const seq = useRef(0);
  const keyAt = useRef(0);
  const show = (row: HTMLElement, x: number, y: number, keyboard: boolean) => {
    const threadId = row.dataset.thread;
    if (!threadId) return;
    const st = useStore.getState();
    const { ids, makeSelection } = contextTargets(threadId, st.checked, st.selected, st.threads.map((x) => x.threadId));
    if (makeSelection) st.setChecked([threadId]);
    if (!row.id) row.id = `ml-row-${threadId}`;
    setOpen({ seq: ++seq.current, ids, at: { x, y }, row, keyboard });
  };
  const handlers = {
    "data-own-menu": "", // the window's right-click guard (contextGuard.ts) leaves this menu to us
    onContextMenu: (e: React.MouseEvent) => {
      const row = (e.target as Element).closest<HTMLElement>("[data-thread]");
      if (!row) return;
      e.preventDefault();
      if (isKeyEcho(keyAt.current, Date.now())) return; // the event that follows the key press was answered already
      show(row, e.clientX, e.clientY, false);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!isContextMenuKey(e)) return;
      const row = (e.target as Element).closest<HTMLElement>("[data-thread]");
      if (!row) return;
      e.preventDefault();
      keyAt.current = Date.now();
      const r = row.getBoundingClientRect();
      show(row, r.left + Math.min(40, r.width / 2), r.top + r.height * 0.6, true);
    },
  };
  return { handlers, menu: open ? <RowMenu open={open} onClose={() => setOpen(null)} /> : null };
}
