import { Archive, BadgeCheck, Calendar, CalendarCheck, CalendarX, Check, CheckCheck, Clock, Flag, FolderOpen, Lock, Mail, MailOpen, Paperclip, Pin, SearchX, ShieldAlert, Trash2 } from "lucide-react";
import { openExternal } from "../open";
import { ReactNode, useCallback, useMemo, useRef } from "react";
import { fmtNumber } from "../i18n/format";
import { useLang, useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { t } from "../i18n";
import { accountLabel } from "../accountLabel";
import { ThreadSummary } from "../api";
import { gmailSearchUrl, webmailQuery, webmailTargets, WebmailTarget } from "../webmail";
import { accountColor, folderLabel, Prefs } from "../prefs";
import { canPageBack, exhaustedKey, friendlyError, useStore } from "../store";
import { dateGroup, fmtDate, snoozePresets, subjectText } from "../util";
import { openDraftInWindow, openDraftThread } from "./Compose";
import { wantsWindow } from "../popout/composeOpen";
import { shiftNow } from "../popout/modifier";
import { openReader } from "../popout/openReader";
import { readerAllowed } from "../popout/readerLogic";
import { ImportanceMark } from "./Importance";
import { AcctName } from "./AcctName";
import { useRowContextMenu } from "./ListContextMenu";
import { ScheduledList } from "./ScheduledList";
import { EmptyState, SkeletonRows } from "./overlays";
import { Avatar, Dropdown } from "./ui";
import { downloadLine } from "../backfill";
import { VirtualList, VItem } from "./VirtualList";

export interface ThreadRowProps {
  t: ThreadSummary;
  selected?: boolean;
  checked?: boolean;
  prefs: Prefs;
  /** show where the conversation lives (search results) */
  showFolder?: boolean;
  /** colour dot of the account (only when several accounts are shown together) */
  accountColor?: string | null;
  accountLabel?: string;
  hover?: ReactNode;
  onOpen?: () => void;
  /** double-click, or Shift+Enter: the conversation in a window of its own (not on the select circle or the hover buttons) */
  onOpenWindow?: () => void;
  onToggle?: () => void;
  /** position among the conversations of a list that is only partly in the DOM (1-based) and how many there are */
  posInSet?: number;
  setSize?: number;
}

/** One conversation in the list. Pure: the real list and the Appearance preview both render it. */
export function ThreadRow({ t, selected, checked, prefs, showFolder, accountColor, accountLabel, hover, onOpen, onOpenWindow, onToggle, posInSet, setSize }: ThreadRowProps) {
  const tr = useT();
  const who = t.participants.join(", ");
  const dense = prefs.density === "compact";
  return (
    <div
      role="option"
      aria-selected={!!selected}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      tabIndex={0}
      data-thread={t.threadId}
      className={`ml-row ${selected ? "selected" : ""} ${t.unread ? "unread" : ""} ${checked ? "checked" : ""}`}
      onClick={onOpen}
      onDoubleClick={(e) => {
        if (onOpenWindow && !(e.target as Element).closest(".ml-lead, .hover-actions")) onOpenWindow();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && onOpenWindow) {
          e.preventDefault();
          onOpenWindow();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.();
        }
      }}
    >
      <div
        className="ml-lead"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        title={tr("mail.row.select")}
      >
        {!dense && (
          <div className="lead-avatar">
            <Avatar name={t.participants[0] ?? "?"} size={34} />
          </div>
        )}
        <div className={`lead-check ${checked ? "on" : ""}`}>{checked && <Check size={12} />}</div>
        {accountColor && !dense && <span className="acct-dot under" style={{ background: accountColor }} title={accountLabel} />}
      </div>
      <div className="ml-main">
        <div className="ml-top">
          {t.unread > 0 && <span className="unread-dot" aria-label={tr("mail.row.unread")} />}
          {accountColor && dense && <span className="acct-dot" style={{ background: accountColor }} title={accountLabel} />}
          <span className="who ellipsis">{who}</span>
          {hover}
          <span className="date">{fmtDate(t.lastDate)}</span>
        </div>
        <div className="ml-mid">
          <span className="subject ellipsis">{subjectText(t.subject)}</span>
          <span className="flags">
            {showFolder && <span className="where">{folderLabel(t.folder)}</span>}
            {t.count > 1 && prefs.conversations && <span className="count">{t.count}</span>}
            <ImportanceMark level={t.importance} />
            {t.confidential && <ShieldAlert size={12} aria-label={tr("mail.row.confidential")} />}
            {t.encrypted && <Lock size={12} aria-label={tr("mail.row.encrypted")} />}
            {t.signed && !t.encrypted && <BadgeCheck size={12} aria-label={tr("mail.row.signed")} />}
            {t.invite === "request" && <Calendar size={12} aria-label={tr("mail.row.invite")} />}
            {t.invite === "reply" && <CalendarCheck size={12} aria-label={tr("mail.row.inviteReply")} />}
            {t.invite === "cancel" && <CalendarX size={12} aria-label={tr("mail.row.inviteCancel")} />}
            {t.hasAttach && <Paperclip size={12} aria-label={tr("mail.row.attachment")} />}
            {t.pinned && <Pin size={12} aria-label={tr("mail.row.pinned")} />}
            {t.flagged && <Flag size={12} fill="currentColor" className="flag-on" aria-label={tr("mail.row.flagged")} />}
            {t.snoozedUntil && t.snoozedUntil > Date.now() / 1000 && <Clock size={12} aria-label={tr("mail.row.snoozed")} />}
          </span>
        </div>
        {prefs.preview && !dense && <div className="preview ellipsis">{t.confidential ? tr("mail.row.confidentialPreview") : t.snippet}</div>}
      </div>
    </div>
  );
}

function HoverActions({ t }: { t: ThreadSummary }) {
  const tr = useT();
  const { act, prefs, folder } = useStore();
  const ids = [t.threadId];
  const btn = (key: string, title: string, icon: ReactNode, run: () => void) => (
    <button key={key} className="icon-btn" title={title} aria-label={title} onClick={run}>
      {icon}
    </button>
  );
  const map: Record<string, ReactNode> = {
    archive: btn("archive", tr("mail.hover.archive"), <Archive size={14} />, () => void act(ids, "archive", undefined, () => tr("mail.done.archived"))),
    delete: btn("delete", folder === "trash" ? tr("mail.hover.deleteForever") : tr("common.delete"), <Trash2 size={14} />, () =>
      void act(ids, "trash", undefined, () => folder === "trash" ? tr("mail.done.deleted") : tr("mail.done.trashed"))),
    flag: btn("flag", t.flagged ? tr("mail.hover.unflag") : tr("mail.hover.flag"), <Flag size={14} fill={t.flagged ? "currentColor" : "none"} />, () => void act(ids, t.flagged ? "unstar" : "star")),
    pin: btn("pin", t.pinned ? tr("mail.hover.unpin") : tr("mail.hover.pin"), <Pin size={14} fill={t.pinned ? "currentColor" : "none"} />, () => void act(ids, t.pinned ? "unpin" : "pin")),
    read: btn("read", t.unread ? tr("mail.hover.markRead") : tr("mail.hover.markUnread"), t.unread ? <MailOpen size={14} /> : <Mail size={14} />, () => void act(ids, t.unread ? "read" : "unread")),
    snooze: (
      <Dropdown
        key="snooze"
        className="icon-btn"
        caret={false}
        title={tr("mail.hover.snooze")}
        items={snoozePresets(prefs.snoozeTimes).map((p) => ({ label: p.label, onClick: () => void act(ids, "snooze", String(p.ts), () => tr("mail.done.snoozed", { when: p.label })) }))}
      >
        <Clock size={14} />
      </Dropdown>
    ),
  };
  return (
    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
      {prefs.hoverActions.map((k) => map[k])}
    </div>
  );
}

/** A line of the list: a conversation, or the header of its group. */
type ListItem = VItem & ({ kind: "group"; label: string } | { kind: "row"; t: ThreadSummary; pos: number });

/** Copies text for the clipboard; false when the webview refuses (no permission, no focus). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Gmail has a documented search link and opens straight on the results. The other webmails have none that we know of, so the
 * search is copied and their home page is opened: the person pastes it into the webmail's own search box.
 */
async function searchInWebmail({ account, webmail }: WebmailTarget, q: string) {
  const st = useStore.getState();
  try {
    if (webmail.id === "gmail") {
      await openExternal(gmailSearchUrl(account.email, q));
      return;
    }
    const copying = copyText(q); // started inside the click, before anything is awaited
    await openExternal(webmail.home);
    if (await copying) st.showToast(t("mail.webmail.copied", { name: webmail.name }), undefined, "success");
    else st.showToast(() => t("mail.webmail.copyFailed", { name: webmail.name, query: q }), undefined, "error");
  } catch (e) {
    st.showToast(() => t("mail.webmail.openFailed", { name: webmail.name, error: friendlyError(e) }), undefined, "error");
  }
}

/** "Search in <webmail>": one button per mailbox of the search that has a known webmail (the address is shown when there are several). */
function WebmailSearch({ targets, query, openFolder }: { targets: WebmailTarget[]; query: string; openFolder?: string }) {
  const tr = useT();
  const shown = targets.map((t) => ({ t, q: webmailQuery(t.webmail, query, openFolder) })).filter((x) => x.q);
  if (shown.length === 0) return null;
  return (
    <div className="gmail-search">
      {shown.map(({ t, q }) => {
        const hint = t.webmail.id === "gmail" ? tr("mail.webmail.hintGmail", { email: t.account.email }) : tr("mail.webmail.hintCopy", { name: t.webmail.name });
        const name = t.webmail.name;
        return (
          <button key={t.account.id} className="btn" title={hint} aria-label={shown.length > 1 ? tr("mail.webmail.ariaMailbox", { name, email: t.account.email, hint }) : tr("mail.webmail.aria", { name, hint })} onClick={() => void searchInWebmail(t, q)}>
            <span className="gs-main">{tr("mail.webmail.search", { name })}</span>
            {shown.length > 1 && <span className="gs-acct">{t.account.email}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MessageList() {
  const tr = useT();
  const lang = useLang();
  const {
    threads, folder, accountId, selected, openMail, checked, toggleCheck, setChecked, search, searchScope, setSearchScope,
    prefs, focus, setFocus, filter, setFilter, accounts, loading, loadMore, loadingMore, exhausted, limited, backfill, firstSync, setDialog,
  } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctxMenu = useRowContextMenu(); // right-click / ContextMenu key on a row (components/ListContextMenu.tsx)
  const searching = search.trim().length > 0;
  const title = searching ? tr("mail.list.searchResults") : folderLabel(folder);
  const scopeNote = searching ? (searchScope === "all" ? tr("mail.list.scopeAll") : searchScope === "account" ? tr("mail.list.scopeAccount") : tr("mail.list.scopeFolder", { folder: folderLabel(folder) })) : "";
  const showTabs = folder === "inbox" && prefs.focused && !searching;
  const multi = checked.size > 0;
  const colors = new Map(accounts.map((a) => [a.id, accountColor(a, prefs.accent)]));
  const labels = new Map(accounts.map((a) => [a.id, accountLabel(a).text])); // the display name, else the address
  const mixed = accounts.length > 1 && (!accountId || (searching && searchScope === "all"));
  const firstHere = !!firstSync && (!accountId || accountId === firstSync) && !searching && folder === "inbox";
  const pageable = canPageBack(folder, searching) && threads.length > 0;
  const targets = accountId ? [accountId] : accounts.map((a) => a.id);
  // a mailbox is done when the server has nothing older or the "Max emails to download" cap stopped it; the cap's footer wins
  const reachedEnd = targets.length > 0 && targets.every((id) => exhausted[exhaustedKey(id, folder)] || limited[exhaustedKey(id, folder)]);
  // F-13: the cap is about how much mail of the mailbox was downloaded; under a filter (or in the Unread view) the list is a handful of
  // matches, so the cap's footer would read as "this list is limited to 500" - there the plain end-of-list line is shown instead
  const filtered = filter !== "all" || folder === "unread";
  const capped = reachedEnd && !filtered && targets.some((id) => limited[exhaustedKey(id, folder)]);
  // background download of older Inbox mail (event `backfill-progress`)
  const inboxish = folder === "inbox" || folder === "unread";
  const download = downloadLine(backfill, { inboxish, searching, accountId, accountIds: accounts.map((a) => a.id) });
  const webmails = searching ? webmailTargets(accounts, accountId, searchScope) : [];
  // a search limited to the open folder stays in that folder on Gmail
  const webmailFolder = searchScope === "current" ? folder : undefined;

  const openThread = (t: ThreadSummary) => {
    if (folder === "drafts") {
      // a draft opens in Compose; the message being written is left first (saved as a draft when it holds something)
      const shift = shiftNow(); // (Shift+click does the opposite of the setting: a window, or the pane when the setting is on)
      void (async () => {
        // (a draft that opens in a window leaves the message in the pane alone: the windows are independent of it)
        if (!wantsWindow({ shift }) && !(await useStore.getState().leaveCompose())) return;
        await openDraftThread(t.threadId, false, { shift });
      })();
      return;
    }
    void openMail(t.threadId);
  };

  // the flat list of lines (group headers + conversations) the virtual list draws from
  const items = useMemo(() => {
    const out: ListItem[] = [];
    let last = "";
    let pos = 0;
    for (const t of threads) {
      const group = prefs.sortAsc ? "" : t.pinned && folder === "inbox" ? tr("mail.group.pinned") : dateGroup(t.lastDate);
      if (group && group !== last) out.push({ kind: "group", key: `g:${t.rowKey}`, group, label: group });
      last = group;
      out.push({ kind: "row", key: t.rowKey, group, t, pos: ++pos });
    }
    return out;
  }, [threads, folder, prefs.sortAsc, lang]); // the group names follow the language
  const revealKey = useMemo(() => (selected ? threads.find((t) => t.threadId === selected)?.rowKey ?? null : null), [threads, selected]);
  const viewKey = [folder, accountId, search, searchScope, filter, focus, prefs.sortAsc, prefs.conversations, prefs.focused].join("|");
  // oldest-first: older mail is added at the top, so that is where the list asks for it and where its status is shown
  // re-created when what loadMore would decide changes, so the list asks again (e.g. after "Loading…" ended with the end still in view)
  const nearMore = useCallback(() => {
    if (pageable) void loadMore();
  }, [pageable, loadMore, loadingMore, reachedEnd, capped, folder, accountId]);
  const pagingStatus = loadingMore ? (
    <span className="muted"><span className="spin" aria-hidden /> {tr("common.loading")}</span>
  ) : capped ? (
    <span className="muted">
      {tx(
        "mail.list.limitReached",
        { link: <button className="link" onClick={() => setDialog({ type: "settings", tab: "mb:all", focus: "maxDownload" })}>{tr("mail.list.limitLink")}</button> },
        { max: fmtNumber(prefs.maxDownload) },
      )}
    </span>
  ) : reachedEnd ? (
    <span className="muted">{tr("mail.list.reachedEnd")}</span>
  ) : (
    <button className="btn small" onClick={() => void loadMore(true)}>{tr("mail.list.loadOlder")}</button>
  );

  const renderItem = (it: ListItem) =>
    it.kind === "group" ? (
      <div className="ml-group" role="presentation">{it.label}</div>
    ) : (
      <ThreadRow
        t={it.t}
        prefs={prefs}
        selected={selected === it.t.threadId}
        checked={checked.has(it.t.threadId)}
        showFolder={searching}
        accountColor={mixed ? colors.get(it.t.accountId) ?? accountColor(null, prefs.accent) : null}
        accountLabel={labels.get(it.t.accountId)}
        hover={<HoverActions t={it.t} />}
        onOpen={() => openThread(it.t)}
        onOpenWindow={folder === "drafts" ? () => void openDraftInWindow(it.t.threadId) : readerAllowed(folder, it.t.folder) ? () => void openReader(it.t, folder) : undefined}
        onToggle={() => toggleCheck(it.t.threadId)}
        posInSet={it.pos}
        setSize={threads.length}
      />
    );

  return (
    <section className="msg-list" aria-label={tr("mail.list.aria")}>
      <div className={`ml-head ${multi ? "multi" : ""}`}>
        <div className="ml-title">
          {showTabs ? (
            <div className="pivots" role="tablist">
              <button role="tab" aria-selected={focus === "focused"} className={focus === "focused" ? "active" : ""} onClick={() => void setFocus("focused")}>{tr("mail.tabs.focused")}</button>
              <button role="tab" aria-selected={focus === "other"} className={focus === "other" ? "active" : ""} onClick={() => void setFocus("other")}>{tr("mail.tabs.other")}</button>
            </div>
          ) : (
            <h2 className="ellipsis">{title}</h2>
          )}
          <div className="ml-tools">
            <Dropdown
              className="link-btn"
              items={[
                { label: tr("mail.filter.all"), checked: filter === "all", onClick: () => void setFilter("all") },
                { label: tr("mail.filter.unread"), checked: filter === "unread", onClick: () => void setFilter("unread") },
                { label: tr("mail.filter.flagged"), checked: filter === "flagged", onClick: () => void setFilter("flagged") },
              ]}
            >
              {filter === "all" ? tr("mail.filter.button") : tr("mail.filter.active", { name: tr(filter === "unread" ? "mail.filter.unread" : "mail.filter.flagged") })}
            </Dropdown>
          </div>
        </div>
        {searching ? (
          <div className="ml-sub">
            {tr("mail.list.summary", { query: search.trim(), scope: scopeNote, n: threads.length })}
          </div>
        ) : (
          accountId && <div className="ml-sub ellipsis">{accounts.find((a) => a.id === accountId) ? <AcctName account={accounts.find((a) => a.id === accountId)!} className="" /> : labels.get(accountId)}</div>
        )}
        {pageable && prefs.sortAsc && !searching && (
          <div className="ml-progress" role="status">{pagingStatus}</div>
        )}
        {download && (
          <div className="ml-progress" role="status">
            <span className="spin" aria-hidden /> {tr("mail.list.downloading", { have: fmtNumber(download.have), target: fmtNumber(download.target) })}
          </div>
        )}
        {multi && (
          <div className="ml-bulk">
            <span>{tr("mail.list.selected", { n: checked.size })}</span>
            <button className="link-btn" onClick={() => setChecked(threads.map((t) => t.threadId))}>{tr("mail.list.selectAll")}</button>
            <button className="link-btn" onClick={() => setChecked([])}>{tr("mail.list.clear")}</button>
          </div>
        )}
      </div>

      <div className="ml-body" ref={scrollRef} role="listbox" aria-label={title} aria-multiselectable {...ctxMenu.handlers}>
        {folder === "scheduled" ? (
          <ScheduledList />
        ) : (loading || firstHere) && threads.length === 0 ? (
          <>
            {firstHere && (
              <div className="ml-firstsync" role="status">
                <span className="spin" aria-hidden /> {tr("mail.list.syncing", { account: labels.get(firstSync!) ?? tr("mail.list.yourAccount") })}
              </div>
            )}
            <SkeletonRows />
          </>
        ) : threads.length === 0 ? (
          searching ? (
            <EmptyState
              icon={<SearchX size={40} />}
              title={tr("mail.empty.noResults")}
              text={searchScope === "all" ? tr("mail.empty.searchedAll") : tr("mail.empty.searchHint")}
              action={
                <>
                  {searchScope !== "all" && <button className="btn" onClick={() => void setSearchScope("all")}>{tr("mail.empty.searchAll")}</button>}
                  <WebmailSearch targets={webmails} query={search} openFolder={webmailFolder} />
                </>
              }
            />
          ) : filter !== "all" ? (
            <EmptyState icon={<FolderOpen size={40} />} title={tr("mail.empty.noMatch")} action={<button className="btn" onClick={() => void setFilter("all")}>{tr("mail.empty.showAll")}</button>} />
          ) : folder === "inbox" || folder === "unread" ? (
            <EmptyState icon={<CheckCheck size={40} />} title={tr("mail.empty.caughtUp")} text={tr("mail.empty.caughtUpText")} />
          ) : (
            <EmptyState icon={<FolderOpen size={40} />} title={tr("mail.empty.folder")} />
          )
        ) : (
          <VirtualList
            scrollRef={scrollRef}
            items={items}
            render={renderItem}
            viewKey={viewKey}
            reveal={revealKey}
            floating={(label) => <div className="ml-group" role="presentation">{label}</div>}
            onNearEnd={prefs.sortAsc ? undefined : nearMore}
            onNearStart={prefs.sortAsc ? nearMore : undefined}
            prefetch={!filtered}
            holdTop={prefs.sortAsc}
            footer={
              searching ? (
                webmails.some((t) => webmailQuery(t.webmail, search, webmailFolder)) ? (
                  <div className="ml-foot">
                    <WebmailSearch targets={webmails} query={search} openFolder={webmailFolder} />
                  </div>
                ) : null
              ) : pageable && !prefs.sortAsc ? (
                <div className="ml-foot" role="status">{pagingStatus}</div>
              ) : null
            }
          />
        )}
      </div>
      {ctxMenu.menu}
    </section>
  );
}
