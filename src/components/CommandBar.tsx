import { useEffect, useMemo, useRef, useState } from "react";
import { accountLabel } from "../accountLabel";
import { newMailAccount } from "../actions";
import { useLang, useT } from "../i18n/react";
import { folderVisible } from "../junk";
import { folderLabel } from "../prefs";
import { newEvent } from "./Calendar";
import { useStore } from "../store";
import { commandsFor } from "../mailControls";
import { openReader } from "../popout/openReader";
import { readerAllowed } from "../popout/readerLogic";
import { useUpdates } from "../updates";

interface Cmd {
  /** stable name of the command (the English wording): mailControls keeps the commands of the no-account state by it */
  id: string;
  label: string;
  run: () => void;
}

/** Lower case without accents, so "ho thu" finds "Hộp thư" and "creer" finds "Créer". */
const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").toLowerCase();

export function CommandBar() {
  const t = useT();
  const lang = useLang();
  const s = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const cmds = useMemo<Cmd[]>(() => {
    const ids = s.selected ? [s.selected] : [];
    const cur = s.threads.find((x) => x.threadId === s.selected);
    const list: Cmd[] = [
      { id: "Add account", label: t("app.cmd.addAccount"), run: () => s.setDialog({ type: "settings", tab: "add-account", nonce: Date.now() }) }, // listed only without an account
      { id: "New mail", label: t("app.cmd.newMail"), run: () => s.openCompose({ accountId: newMailAccount() }) },
      { id: "Sync now", label: t("app.cmd.syncNow"), run: () => void s.sync() },
      { id: "New event", label: t("app.cmd.newEvent"), run: () => newEvent() },
      { id: "Go to Calendar", label: t("app.cmd.goCalendar"), run: () => s.setModule("calendar") },
      { id: "Go to Mail", label: t("app.cmd.goMail"), run: () => s.setModule("mail") },
      { id: "Calendar: Month view", label: t("app.cmd.calMonth"), run: () => (s.setModule("calendar"), s.setCalView("month")) },
      { id: "Calendar: Week view", label: t("app.cmd.calWeek"), run: () => (s.setModule("calendar"), s.setCalView("week")) },
      { id: "Calendar: Agenda view", label: t("app.cmd.calAgenda"), run: () => (s.setModule("calendar"), s.setCalView("agenda")) },
      { id: "Open settings", label: t("app.cmd.openSettings"), run: () => s.setDialog({ type: "settings" }) },
      { id: "Check for updates", label: t("app.cmd.checkUpdates"), run: () => useUpdates.getState().openSettingsAbout(true) },
      { id: "Sweep: clean up by sender", label: t("app.cmd.sweep"), run: () => s.setDialog({ type: "cleaner" }) },
      { id: "Theme: light", label: t("app.cmd.themeLight"), run: () => s.setPrefs({ theme: "light" }) },
      { id: "Theme: dark", label: t("app.cmd.themeDark"), run: () => s.setPrefs({ theme: "dark" }) },
      { id: "Theme: system", label: t("app.cmd.themeSystem"), run: () => s.setPrefs({ theme: "system" }) },
      { id: "Toggle reading pane position", label: t("app.cmd.toggleReadingPane"), run: () => s.setPrefs({ readingPane: s.prefs.readingPane === "right" ? "bottom" : "right" }) },
      { id: "Toggle conversations", label: t("app.cmd.toggleConversations"), run: () => s.setPrefs({ conversations: !s.prefs.conversations }) },
      { id: "Toggle Focused Inbox", label: t("app.cmd.toggleFocused"), run: () => s.setPrefs({ focused: !s.prefs.focused }) },
      ...["inbox", "unread", "starred", "pinned", "snoozed", "scheduled", "sent", "drafts", "archive", "junk", "trash"].filter((f) => folderVisible(s.folders, s.accountId, f)).map((f) => ({
        id: `Go to ${f}`,
        label: t("app.cmd.goToFolder", { folder: folderLabel(f) }),
        run: () => void s.setView(f, s.accountId),
      })),
    ];
    if (ids.length)
      list.push(
        { id: "Archive conversation", label: t("app.cmd.archive"), run: () => void s.act(ids, "archive", undefined, () => t("mail.done.archived")) },
        ...(cur && readerAllowed(s.folder, cur.folder) ? [{ id: "Open in new window", label: t("app.cmd.openInWindow"), run: () => void openReader(cur, s.folder) }] : []),
        { id: "Delete conversation", label: t("app.cmd.delete"), run: () => void s.act(ids, "trash", undefined, () => t("mail.done.trashed")) },
        { id: "Mark as unread", label: t("app.cmd.markUnread"), run: () => void s.act(ids, "unread") },
        { id: cur?.flagged ? "Remove flag" : "Flag", label: cur?.flagged ? t("app.cmd.unflag") : t("app.cmd.flag"), run: () => void s.act(ids, cur?.flagged ? "unstar" : "star") },
        { id: cur?.pinned ? "Unpin" : "Pin", label: cur?.pinned ? t("app.cmd.unpin") : t("app.cmd.pin"), run: () => void s.act(ids, cur?.pinned ? "unpin" : "pin") },
      );
    for (const a of s.accounts) list.push({ id: `Switch to ${a.id}`, label: t("app.cmd.switchTo", { email: accountLabel(a).text }), run: () => void s.setView(s.folder, a.id) });
    list.push({ id: "Show all accounts", label: t("app.cmd.showAll"), run: () => void s.setView(s.folder, null) });
    // without an account only Settings, updates and the theme remain
    const byId = new Map(list.map((c) => [c.id, c]));
    return commandsFor(s.accounts.length, list.map((c) => ({ label: c.id }))).map((c) => byId.get(c.label) as Cmd);
  }, [s.selected, s.accounts, s.folder, s.accountId, s.threads, s.prefs, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = cmds.filter((c) => fold(c.label).includes(fold(q))).slice(0, 10);
  const exec = (c?: Cmd) => {
    s.setCommandOpen(false);
    c?.run();
  };

  return (
    <div className="modal-back top" onMouseDown={() => s.setCommandOpen(false)}>
      <div className="modal cmd" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={ref}
          aria-label={t("app.cmd.aria")} placeholder={t("app.cmd.placeholder")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            else if (e.key === "Enter") exec(shown[i]);
            else if (e.key === "Escape") s.setCommandOpen(false);
          }}
        />
        {shown.map((c, idx) => (
          <div key={c.id} className={`menu-row ${idx === i ? "hl" : ""}`} onMouseEnter={() => setI(idx)} onClick={() => exec(c)}>
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}
