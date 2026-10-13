import {
  Archive, BrushCleaning, CalendarDays, CalendarPlus, CalendarRange, Clock, List as ListIcon, Upload, Command, FolderInput, Flag, Forward, Info, Keyboard, MailOpen, MailPlus, Mail, OctagonAlert, Pin, Reply, ReplyAll, Trash2,
} from "lucide-react";
import { ReactNode } from "react";
import { forwardLast, newMailAccount, replyLast, targets } from "../actions";
import { api } from "../api";
import { calTz, today } from "../calendar";
import { friendlyError, useStore, scopeOf } from "../store";
import { newEvent } from "./Calendar";
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
  const { act, openCompose, setDialog, threads, selected, checked, messages, accounts, folders, folder, accountId, prefs } = useStore();
  const ids = targets();
  const has = ids.length > 0;
  const cur = threads.find((t) => t.threadId === selected);
  const acct = cur?.accountId ?? accountId ?? accounts[0]?.id;
  const scope = scopeOf(folder);
  const moveItems: MenuItem[] = folders
    .filter((f) => f.accountId === acct && f.key !== scope && f.key !== "drafts" && f.key !== "sent")
    .map((f) => ({ label: folderLabel(f.key, f.name), onClick: () => void act(ids, "move", f.key, `Moved to ${folderLabel(f.key, f.name)}`) }));
  const anyUnread = (checked.size ? threads.filter((t) => checked.has(t.threadId)) : cur ? [cur] : []).some((t) => t.unread > 0);
  const flagged = cur?.flagged;
  const pinned = cur?.pinned;
  const canReply = messages.length > 0;
  const lastConfidential = !!messages[messages.length - 1]?.confidential;
  return (
    <div className="ribbon-row home">
      <div className="rg">
        <button className="rb primary" onClick={() => openCompose({ accountId: newMailAccount() })}>
          <MailPlus size={18} />
          <span>New mail</span>
        </button>
      </div>
      <div className="rg">
        <Btn icon={<Trash2 size={16} />} label="Delete" disabled={!has} onClick={() => void act(ids, "trash", undefined, folder === "trash" ? "Deleted permanently" : "Moved to Deleted Items")} />
        <Btn icon={<Archive size={16} />} label="Archive" disabled={!has} onClick={() => void act(ids, "archive", undefined, "Archived")} />
        <DdBtn
          icon={<OctagonAlert size={16} />}
          label="Report"
          disabled={!has}
          items={[
            { label: "Move to Junk", onClick: () => void act(ids, "junk", undefined, "Moved to Junk") },
            { label: "Block sender", onClick: () => void act(ids, "block", undefined, "Sender blocked") },
          ]}
        />
        <Btn icon={<BrushCleaning size={16} />} label="Sweep" title="Bulk cleaner: clean up by sender" onClick={() => setDialog({ type: "cleaner" })} />
        <DdBtn icon={<FolderInput size={16} />} label="Move to" disabled={!has} items={moveItems} />
      </div>
      <div className="rg">
        <Btn icon={<Reply size={16} />} label="Reply" disabled={!canReply} onClick={() => replyLast(false)} />
        <Btn icon={<ReplyAll size={16} />} label="Reply all" disabled={!canReply} onClick={() => replyLast(true)} />
        <Btn icon={<Forward size={16} />} label="Forward" disabled={!canReply || lastConfidential} title={lastConfidential ? "Confidential mail can’t be forwarded" : undefined} onClick={forwardLast} />
      </div>
      <div className="rg">
        <Btn
          icon={anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}
          label={anyUnread ? "Mark read" : "Mark unread"}
          disabled={!has}
          onClick={() => void act(ids, anyUnread ? "read" : "unread")}
        />
        <Btn icon={<Flag size={16} fill={flagged ? "currentColor" : "none"} />} label="Flag" disabled={!has} onClick={() => void act(ids, flagged ? "unstar" : "star")} />
        <Btn icon={<Pin size={16} fill={pinned ? "currentColor" : "none"} />} label="Pin" disabled={!has} onClick={() => void act(ids, pinned ? "unpin" : "pin")} />
        <DdBtn
          icon={<Clock size={16} />}
          label="Snooze"
          disabled={!has}
          items={snoozePresets(prefs.snoozeTimes).map((p) => ({
            label: p.label,
            onClick: () => void act(ids, "snooze", String(p.ts), `Snoozed: ${p.label}`),
          }))}
        />
      </div>
    </div>
  );
}

function CalendarHomeTab() {
  const { prefs, setCalView, setCalDate, bumpCal, showToast } = useStore();
  const importIcs = async () => {
    try {
      const r = await api.calendarImportIcs();
      if (!r) return;
      showToast(`Imported ${r.added} new and ${r.updated} updated event${r.added + r.updated === 1 ? "" : "s"}`, undefined, "success");
      bumpCal();
    } catch (e) {
      showToast(`Couldn’t import the file: ${friendlyError(e)}`, undefined, "error");
    }
  };
  const view = prefs.calView;
  return (
    <div className="ribbon-row home">
      <div className="rg">
        <button className="rb primary" onClick={() => newEvent()} title="New event (c)">
          <CalendarPlus size={18} />
          <span>New event</span>
        </button>
      </div>
      <div className="rg">
        <Btn icon={<Upload size={16} />} label="Import .ics" title="Import a calendar file (.ics)" onClick={() => void importIcs()} />
        <Btn icon={<Clock size={16} />} label="Today" title="Go to today (t)" onClick={() => setCalDate(today(calTz(prefs)))} />
      </div>
      <div className="rg">
        <button className={`rb ${view === "month" ? "on" : ""}`} aria-pressed={view === "month"} onClick={() => setCalView("month")} title="Month (m)"><CalendarDays size={16} /><span>Month</span></button>
        <button className={`rb ${view === "week" ? "on" : ""}`} aria-pressed={view === "week"} onClick={() => setCalView("week")} title="Week (w)"><CalendarRange size={16} /><span>Week</span></button>
        <button className={`rb ${view === "agenda" ? "on" : ""}`} aria-pressed={view === "agenda"} onClick={() => setCalView("agenda")} title="Agenda (a)"><ListIcon size={16} /><span>Agenda</span></button>
      </div>
    </div>
  );
}

function ViewTab() {
  const { prefs, setPrefs } = useStore();
  const dd = (label: string, items: MenuItem[]) => (
    <Dropdown className="rb" items={items} title={label}>
      <span>{label}</span>
    </Dropdown>
  );
  return (
    <div className="ribbon-row">
      <div className="rg">
        {dd("Density", [
          { label: "Full", checked: prefs.density === "full", onClick: () => setPrefs({ density: "full" }) },
          { label: "Medium", checked: prefs.density === "medium", onClick: () => setPrefs({ density: "medium" }) },
          { label: "Compact", checked: prefs.density === "compact", onClick: () => setPrefs({ density: "compact" }) },
        ])}
        {dd("Reading pane", [
          { label: "Right", checked: prefs.readingPane === "right", onClick: () => setPrefs({ readingPane: "right" }) },
          { label: "Bottom", checked: prefs.readingPane === "bottom", onClick: () => setPrefs({ readingPane: "bottom" }) },
        ])}
        {dd("Theme", [
          { label: "System", checked: prefs.theme === "system", onClick: () => setPrefs({ theme: "system" }) },
          { label: "Light", checked: prefs.theme === "light", onClick: () => setPrefs({ theme: "light" }) },
          { label: "Dark", checked: prefs.theme === "dark", onClick: () => setPrefs({ theme: "dark" }) },
        ])}
        {dd("Text size", [12, 13, 14, 15, 16, 18].map((n) => ({ label: `${n} px`, checked: prefs.fontSize === n, onClick: () => setPrefs({ fontSize: n }) })))}
      </div>
      <div className="rg">
        <button className={`rb ${prefs.conversations ? "on" : ""}`} onClick={() => setPrefs({ conversations: !prefs.conversations })}>
          Show as conversations
        </button>
        <button className={`rb ${prefs.focused ? "on" : ""}`} onClick={() => setPrefs({ focused: !prefs.focused })}>
          Focused Inbox
        </button>
        <button className={`rb ${prefs.preview ? "on" : ""}`} onClick={() => setPrefs({ preview: !prefs.preview })}>
          Message preview
        </button>
        {dd("Sort", [
          { label: "Newest on top", checked: !prefs.sortAsc, onClick: () => setPrefs({ sortAsc: false }) },
          { label: "Oldest on top", checked: prefs.sortAsc, onClick: () => setPrefs({ sortAsc: true }) },
        ])}
      </div>
    </div>
  );
}

function HelpTab() {
  const { setDialog, setCommandOpen } = useStore();
  return (
    <div className="ribbon-row">
      <div className="rg">
        <Btn icon={<Keyboard size={16} />} label="Shortcuts" onClick={() => setDialog({ type: "settings", tab: "shortcuts" })} />
        <Btn icon={<Command size={16} />} label="Command bar" onClick={() => setCommandOpen(true)} />
        <Btn icon={<Info size={16} />} label="About" onClick={() => setDialog({ type: "settings", tab: "about" })} />
      </div>
    </div>
  );
}

export function Ribbon() {
  const { ribbonTab, setRibbonTab, module } = useStore();
  const tabs: ["home" | "view" | "help", string][] = [["home", "Home"], ["view", "View"], ["help", "Help"]];
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
