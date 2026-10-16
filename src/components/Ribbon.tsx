import {
  Archive, BrushCleaning, CalendarDays, CalendarPlus, CalendarRange, Clock, List as ListIcon, Upload, Command, FolderInput, Flag, Forward, Info, Keyboard, MailOpen, MailPlus, Mail, OctagonAlert, Pin, Reply, ReplyAll, Trash2,
} from "lucide-react";
import { ReactNode } from "react";
import { forwardLast, newMailAccount, replyLast, targets } from "../actions";
import { api } from "../api";
import { calTz, today } from "../calendar";
import { useT } from "../i18n/react";
import { friendlyError, useStore, scopeOf } from "../store";
import { newEvent } from "./Calendar";
import { accountsOf, canMoveToJunk } from "../junk";
import { moveChoices } from "../rowMenu";
import { folderLabel } from "../prefs";
import { snoozePresets } from "../util";
import { Dropdown, MenuItem } from "./ui";

function Btn({ icon, label, onClick, disabled, title }: { icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button className="rb" onClick={onClick} disabled={disabled} title={title ?? label} aria-label={title ?? label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DdBtn({ icon, label, items, disabled }: { icon: ReactNode; label: string; items: MenuItem[]; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="rb-wrap">
      <Dropdown className="rb" items={items} title={label}>
        {icon}
        <span>{label}</span>
      </Dropdown>
    </fieldset>
  );
}

function HomeTab() {
  const t = useT();
  const { act, openCompose, setDialog, threads, selected, checked, messages, accounts, folders, folder, accountId, prefs } = useStore();
  const ids = targets();
  const has = ids.length > 0;
  const cur = threads.find((x) => x.threadId === selected);
  const acct = cur?.accountId ?? accountId ?? accounts[0]?.id;
  const scope = scopeOf(folder);
  // no Junk folder on the account(s): the actions that move mail there are off, with the reason (src/junk.ts)
  const junkOff: Partial<MenuItem> = canMoveToJunk(folders, accountsOf(threads, ids)) ? {} : { disabled: true, hint: t("mail.junk.none"), title: t("mail.junk.noneTip") };
  const moveItems: MenuItem[] = moveChoices(folders, acct, scope)
    .map((f) => ({ label: folderLabel(f.key, f.name), onClick: () => void act(ids, "move", f.key, t("mail.done.moved", { folder: folderLabel(f.key, f.name) })) }));
  const anyUnread = (checked.size ? threads.filter((x) => checked.has(x.threadId)) : cur ? [cur] : []).some((x) => x.unread > 0);
  const flagged = cur?.flagged;
  const pinned = cur?.pinned;
  const canReply = messages.length > 0;
  const lastConfidential = !!messages[messages.length - 1]?.confidential;
  return (
    <div className="ribbon-row home">
      <div className="rg">
        <button className="rb primary" onClick={() => openCompose({ accountId: newMailAccount() })}>
          <MailPlus size={18} />
          <span>{t("app.ribbon.newMail")}</span>
        </button>
      </div>
      <div className="rg">
        <Btn icon={<Trash2 size={16} />} label={t("common.delete")} disabled={!has} onClick={() => void act(ids, "trash", undefined, folder === "trash" ? t("mail.done.deleted") : t("mail.done.trashed"))} />
        <Btn icon={<Archive size={16} />} label={t("app.ribbon.archive")} disabled={!has} onClick={() => void act(ids, "archive", undefined, t("mail.done.archived"))} />
        <DdBtn
          icon={<OctagonAlert size={16} />}
          label={t("app.ribbon.report")}
          disabled={!has}
          items={[
            { label: t("app.ribbon.moveToJunk"), onClick: () => void act(ids, "junk", undefined, t("mail.done.junk")), ...junkOff },
            { label: t("app.ribbon.blockSender"), onClick: () => void act(ids, "block", undefined, t("mail.done.blocked")), ...junkOff },
          ]}
        />
        <Btn icon={<BrushCleaning size={16} />} label={t("app.ribbon.sweep")} title={t("app.ribbon.sweepTitle")} onClick={() => setDialog({ type: "cleaner" })} />
        <DdBtn icon={<FolderInput size={16} />} label={t("app.ribbon.moveTo")} disabled={!has} items={moveItems} />
      </div>
      <div className="rg">
        <Btn icon={<Reply size={16} />} label={t("app.ribbon.reply")} disabled={!canReply} onClick={() => replyLast(false)} />
        <Btn icon={<ReplyAll size={16} />} label={t("app.ribbon.replyAll")} disabled={!canReply} onClick={() => replyLast(true)} />
        <Btn icon={<Forward size={16} />} label={t("app.ribbon.forward")} disabled={!canReply || lastConfidential} title={lastConfidential ? t("app.ribbon.noForward") : undefined} onClick={forwardLast} />
      </div>
      <div className="rg">
        <Btn
          icon={anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}
          label={anyUnread ? t("app.ribbon.markRead") : t("app.ribbon.markUnread")}
          disabled={!has}
          onClick={() => void act(ids, anyUnread ? "read" : "unread")}
        />
        <Btn icon={<Flag size={16} fill={flagged ? "currentColor" : "none"} />} label={t("app.ribbon.flag")} disabled={!has} onClick={() => void act(ids, flagged ? "unstar" : "star")} />
        <Btn icon={<Pin size={16} fill={pinned ? "currentColor" : "none"} />} label={t("app.ribbon.pin")} disabled={!has} onClick={() => void act(ids, pinned ? "unpin" : "pin")} />
        <DdBtn
          icon={<Clock size={16} />}
          label={t("app.ribbon.snooze")}
          disabled={!has}
          items={snoozePresets(prefs.snoozeTimes).map((p) => ({
            label: p.label,
            onClick: () => void act(ids, "snooze", String(p.ts), t("mail.done.snoozed", { when: p.label })),
          }))}
        />
      </div>
    </div>
  );
}

function CalendarHomeTab() {
  const t = useT();
  const { prefs, setCalView, setCalDate, bumpCal, showToast } = useStore();
  const importIcs = async () => {
    try {
      const r = await api.calendarImportIcs();
      if (!r) return;
      showToast(t(r.added + r.updated === 1 ? "app.ribbon.imported.one" : "app.ribbon.imported.many", { added: r.added, updated: r.updated }), undefined, "success");
      bumpCal();
    } catch (e) {
      showToast(t("app.ribbon.importFailed", { error: friendlyError(e) }), undefined, "error");
    }
  };
  const view = prefs.calView;
  return (
    <div className="ribbon-row home">
      <div className="rg">
        <button className="rb primary" onClick={() => newEvent()} title={t("app.ribbon.newEventTitle")}>
          <CalendarPlus size={18} />
          <span>{t("app.ribbon.newEvent")}</span>
        </button>
      </div>
      <div className="rg">
        <Btn icon={<Upload size={16} />} label={t("app.ribbon.importIcs")} title={t("app.ribbon.importIcsTitle")} onClick={() => void importIcs()} />
        <Btn icon={<Clock size={16} />} label={t("app.date.today")} title={t("app.ribbon.todayTitle")} onClick={() => setCalDate(today(calTz(prefs)))} />
      </div>
      <div className="rg">
        <button className={`rb ${view === "month" ? "on" : ""}`} aria-pressed={view === "month"} onClick={() => setCalView("month")} title={t("app.ribbon.monthTitle")}><CalendarDays size={16} /><span>{t("app.ribbon.month")}</span></button>
        <button className={`rb ${view === "week" ? "on" : ""}`} aria-pressed={view === "week"} onClick={() => setCalView("week")} title={t("app.ribbon.weekTitle")}><CalendarRange size={16} /><span>{t("app.ribbon.week")}</span></button>
        <button className={`rb ${view === "agenda" ? "on" : ""}`} aria-pressed={view === "agenda"} onClick={() => setCalView("agenda")} title={t("app.ribbon.agendaTitle")}><ListIcon size={16} /><span>{t("app.ribbon.agenda")}</span></button>
      </div>
    </div>
  );
}

function ViewTab() {
  const t = useT();
  const { prefs, setPrefs } = useStore();
  const dd = (label: string, items: MenuItem[]) => (
    <Dropdown className="rb" items={items} title={label}>
      <span>{label}</span>
    </Dropdown>
  );
  return (
    <div className="ribbon-row">
      <div className="rg">
        {dd(t("app.ribbon.density"), [
          { label: t("app.ribbon.densityFull"), checked: prefs.density === "full", onClick: () => setPrefs({ density: "full" }) },
          { label: t("app.ribbon.densityMedium"), checked: prefs.density === "medium", onClick: () => setPrefs({ density: "medium" }) },
          { label: t("app.ribbon.densityCompact"), checked: prefs.density === "compact", onClick: () => setPrefs({ density: "compact" }) },
        ])}
        {dd(t("app.ribbon.readingPane"), [
          { label: t("app.ribbon.paneRight"), checked: prefs.readingPane === "right", onClick: () => setPrefs({ readingPane: "right" }) },
          { label: t("app.ribbon.paneBottom"), checked: prefs.readingPane === "bottom", onClick: () => setPrefs({ readingPane: "bottom" }) },
        ])}
        {dd(t("app.ribbon.theme"), [
          { label: t("app.ribbon.themeSystem"), checked: prefs.theme === "system", onClick: () => setPrefs({ theme: "system" }) },
          { label: t("app.ribbon.themeLight"), checked: prefs.theme === "light", onClick: () => setPrefs({ theme: "light" }) },
          { label: t("app.ribbon.themeDark"), checked: prefs.theme === "dark", onClick: () => setPrefs({ theme: "dark" }) },
        ])}
        {dd(t("app.ribbon.textSize"), [12, 13, 14, 15, 16, 18].map((n) => ({ label: t("app.ribbon.px", { n }), checked: prefs.fontSize === n, onClick: () => setPrefs({ fontSize: n }) })))}
      </div>
      <div className="rg">
        <button className={`rb ${prefs.conversations ? "on" : ""}`} onClick={() => setPrefs({ conversations: !prefs.conversations })}>
          {t("app.ribbon.conversations")}
        </button>
        <button className={`rb ${prefs.focused ? "on" : ""}`} onClick={() => setPrefs({ focused: !prefs.focused })}>
          {t("app.ribbon.focusedInbox")}
        </button>
        <button className={`rb ${prefs.preview ? "on" : ""}`} onClick={() => setPrefs({ preview: !prefs.preview })}>
          {t("app.ribbon.preview")}
        </button>
        {dd(t("app.ribbon.sort"), [
          { label: t("app.ribbon.sortNewest"), checked: !prefs.sortAsc, onClick: () => setPrefs({ sortAsc: false }) },
          { label: t("app.ribbon.sortOldest"), checked: prefs.sortAsc, onClick: () => setPrefs({ sortAsc: true }) },
        ])}
      </div>
    </div>
  );
}

function HelpTab() {
  const t = useT();
  const { setDialog, setCommandOpen } = useStore();
  return (
    <div className="ribbon-row">
      <div className="rg">
        <Btn icon={<Keyboard size={16} />} label={t("app.ribbon.shortcuts")} onClick={() => setDialog({ type: "settings", tab: "shortcuts" })} />
        <Btn icon={<Command size={16} />} label={t("app.ribbon.commandBar")} onClick={() => setCommandOpen(true)} />
        <Btn icon={<Info size={16} />} label={t("app.ribbon.about")} onClick={() => setDialog({ type: "settings", tab: "about" })} />
      </div>
    </div>
  );
}

export function Ribbon() {
  const t = useT();
  const { ribbonTab, setRibbonTab, module } = useStore();
  const tabs: ["home" | "view" | "help", string][] = [["home", t("app.ribbon.tabHome")], ["view", t("app.ribbon.tabView")], ["help", t("app.ribbon.tabHelp")]];
  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        {tabs.map(([k, l]) => (
          <button key={k} className={ribbonTab === k ? "active" : ""} onClick={() => setRibbonTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {ribbonTab === "home" && (module === "calendar" ? <CalendarHomeTab /> : <HomeTab />)}
      {ribbonTab === "view" && <ViewTab />}
      {ribbonTab === "help" && <HelpTab />}
    </div>
  );
}
