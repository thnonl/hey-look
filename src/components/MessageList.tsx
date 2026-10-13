import { Archive, BadgeCheck, Calendar, CalendarCheck, CalendarX, Check, CheckCheck, Clock, Flag, FolderOpen, Lock, Mail, MailOpen, Paperclip, Pin, SearchX, ShieldAlert, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactNode, useCallback, useMemo, useRef } from "react";
import { api, ThreadSummary } from "../api";
import { gmailSearchUrl, webmailQuery, webmailTargets, WebmailTarget } from "../webmail";
import { accountColor, folderLabel, Prefs } from "../prefs";
import { canPageBack, exhaustedKey, friendlyError, useStore } from "../store";
import { dateGroup, fmtDate, snoozePresets } from "../util";
import { messageToEditor } from "./Compose";
import { askUnlock } from "./Pgp";
import { ScheduledList } from "./ScheduledList";
import { EmptyState, SkeletonRows } from "./overlays";
import { Avatar, Dropdown } from "./ui";
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
  onToggle?: () => void;
  /** position among the conversations of a list that is only partly in the DOM (1-based) and how many there are */
  posInSet?: number;
  setSize?: number;
}

/** One conversation in the list. Pure: the real list and the Appearance preview both render it. */
export function ThreadRow({ t, selected, checked, prefs, showFolder, accountColor, accountLabel, hover, onOpen, onToggle, posInSet, setSize }: ThreadRowProps) {
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
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
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
        title="Select"
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
          {t.unread > 0 && <span className="unread-dot" aria-label="Unread" />}
          {accountColor && dense && <span className="acct-dot" style={{ background: accountColor }} title={accountLabel} />}
          <span className="who ellipsis">{who}</span>
          {hover}
          <span className="date">{fmtDate(t.lastDate)}</span>
        </div>
        <div className="ml-mid">
          <span className="subject ellipsis">{t.subject}</span>
          <span className="flags">
            {showFolder && <span className="where">{folderLabel(t.folder)}</span>}
            {t.count > 1 && prefs.conversations && <span className="count">{t.count}</span>}
            {t.confidential && <ShieldAlert size={12} aria-label="Confidential" />}
            {t.encrypted && <Lock size={12} aria-label="Encrypted" />}
            {t.signed && !t.encrypted && <BadgeCheck size={12} aria-label="Signed" />}
            {t.invite === "request" && <Calendar size={12} aria-label="Meeting invitation" />}
            {t.invite === "reply" && <CalendarCheck size={12} aria-label="Meeting reply" />}
            {t.invite === "cancel" && <CalendarX size={12} aria-label="Meeting cancelled" />}
            {t.hasAttach && <Paperclip size={12} aria-label="Has attachment" />}
            {t.pinned && <Pin size={12} aria-label="Pinned" />}
            {t.flagged && <Flag size={12} fill="currentColor" className="flag-on" aria-label="Flagged" />}
            {t.snoozedUntil && t.snoozedUntil > Date.now() / 1000 && <Clock size={12} aria-label="Snoozed" />}
          </span>
        </div>
        {prefs.preview && !dense && <div className="preview ellipsis">{t.confidential ? "Confidential — open to read" : t.snippet}</div>}
      </div>
    </div>
  );
}

function HoverActions({ t }: { t: ThreadSummary }) {
  const { act, prefs, folder } = useStore();
  const ids = [t.threadId];
  const btn = (key: string, title: string, icon: ReactNode, run: () => void) => (
    <button key={key} className="icon-btn" title={title} aria-label={title} onClick={run}>
      {icon}
    </button>
  );
  const map: Record<string, ReactNode> = {
    archive: btn("archive", "Archive", <Archive size={14} />, () => void act(ids, "archive", undefined, "Archived")),
    delete: btn("delete", folder === "trash" ? "Delete permanently" : "Delete", <Trash2 size={14} />, () =>
      void act(ids, "trash", undefined, folder === "trash" ? "Deleted permanently" : "Moved to Deleted Items")),
    flag: btn("flag", t.flagged ? "Remove flag" : "Flag", <Flag size={14} fill={t.flagged ? "currentColor" : "none"} />, () => void act(ids, t.flagged ? "unstar" : "star")),
    pin: btn("pin", t.pinned ? "Unpin" : "Pin", <Pin size={14} fill={t.pinned ? "currentColor" : "none"} />, () => void act(ids, t.pinned ? "unpin" : "pin")),
    read: btn("read", t.unread ? "Mark as read" : "Mark as unread", t.unread ? <MailOpen size={14} /> : <Mail size={14} />, () => void act(ids, t.unread ? "read" : "unread")),
    snooze: (
      <Dropdown
        key="snooze"
        className="icon-btn"
        caret={false}
        title="Snooze"
        items={snoozePresets(prefs.snoozeTimes).map((p) => ({ label: p.label, onClick: () => void act(ids, "snooze", String(p.ts), `Snoozed: ${p.label}`) }))}
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
      await openUrl(gmailSearchUrl(account.email, q));
      return;
    }
    const copying = copyText(q); // started inside the click, before anything is awaited
    await openUrl(webmail.home);
    if (await copying) st.showToast(`Search text copied. Paste it into the search box of ${webmail.name} webmail.`, undefined, "success");
    else st.showToast(`Couldn’t copy the search. Type it into the search box of ${webmail.name} webmail: ${q}`, undefined, "error");
  } catch (e) {
    st.showToast(`Couldn’t open ${webmail.name} in the browser: ${friendlyError(e)}`, undefined, "error");
  }
}

/** "Search in <webmail>": one button per mailbox of the search that has a known webmail (the address is shown when there are several). */
function WebmailSearch({ targets, query, openFolder }: { targets: WebmailTarget[]; query: string; openFolder?: string }) {
  const shown = targets.map((t) => ({ t, q: webmailQuery(t.webmail, query, openFolder) })).filter((x) => x.q);
  if (shown.length === 0) return null;
  return (
    <div className="gmail-search">
      {shown.map(({ t, q }) => {
        const hint = t.webmail.id === "gmail" ? `Opens ${t.account.email} in Gmail` : `Copies your search and opens ${t.webmail.name}`;
        return (
          <button key={t.account.id} className="btn" title={hint} aria-label={`Search in ${t.webmail.name}${shown.length > 1 ? `, ${t.account.email}` : ""}. ${hint}`} onClick={() => void searchInWebmail(t, q)}>
            <span className="gs-main">Search in {t.webmail.name}</span>
            {shown.length > 1 && <span className="gs-acct">{t.account.email}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MessageList() {
  const {
    threads, folder, accountId, selected, select, checked, toggleCheck, setChecked, search, searchScope, setSearchScope,
    prefs, focus, setFocus, filter, setFilter, accounts, openCompose, loading, loadMore, loadingMore, exhausted, limited, backfill, firstSync, setDialog,
  } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const title = searching ? "Search results" : folderLabel(folder);
  const scopeNote = searching ? (searchScope === "all" ? "All mailboxes" : searchScope === "account" ? "Whole mailbox" : `In ${folderLabel(folder)}`) : "";
  const showTabs = folder === "inbox" && prefs.focused && !searching;
  const multi = checked.size > 0;
  const colors = new Map(accounts.map((a) => [a.id, accountColor(a, prefs.accent)]));
  const labels = new Map(accounts.map((a) => [a.id, a.email]));
  const mixed = accounts.length > 1 && (!accountId || (searching && searchScope === "all"));
  const firstHere = !!firstSync && (!accountId || accountId === firstSync) && !searching && folder === "inbox";
  const pageable = canPageBack(folder, searching) && threads.length > 0;
  const targets = accountId ? [accountId] : accounts.map((a) => a.id);
  // a mailbox is done when the server has nothing older or the "Max emails to download" cap stopped it; the cap's footer wins
  const reachedEnd = targets.length > 0 && targets.every((id) => exhausted[exhaustedKey(id, folder)] || limited[exhaustedKey(id, folder)]);
  const capped = reachedEnd && targets.some((id) => limited[exhaustedKey(id, folder)]);
  // background download of older Inbox mail (event `backfill-progress`)
  const inboxish = folder === "inbox" || folder === "unread";
  const download = inboxish && !searching ? Object.values(backfill).filter((p) => !p.done && p.role === "inbox" && (!accountId || p.accountId === accountId)) : [];
  const dlHave = download.reduce((n, p) => n + Math.min(p.have, p.target), 0);
  const dlTarget = download.reduce((n, p) => n + p.target, 0);
  const webmails = searching ? webmailTargets(accounts, accountId, searchScope) : [];
  // a search limited to the open folder stays in that folder on Gmail
  const webmailFolder = searchScope === "current" ? folder : undefined;

  const openThread = (t: ThreadSummary) => {
    if (folder === "drafts") {
      void (async () => {
        const msgs = await api.getThread(t.threadId, "drafts");
        let m = msgs[msgs.length - 1];
        if (!m) return;
        // a draft that was encrypted to your own key needs the key (and its passphrase) to be opened again
        const st = useStore.getState();
        if (m.security?.encrypted && m.security.decryption !== "ok") {
          if (m.security.decryption === "locked" && m.security.lockedKey && (await askUnlock(m.security.lockedKey, "draft", m.security.lockedLabel ?? undefined))) {
            m = await api.pgpDecryptMessage(m.id).catch(() => m);
          }
          if (m.security?.decryption !== "ok") {
            if (m.security?.decryption !== "locked") st.showToast(`Couldn’t open this encrypted draft: ${friendlyError(m.security?.error ?? "the key for it is not on this computer")}`, undefined, "error");
            return;
          }
        }
        // restore pictures and attachments so saving or sending the draft does not silently drop them
        const { html, attachments } = await messageToEditor(m);
        void openCompose({
          accountId: m.accountId,
          to: m.to ? m.to.split(",").map((x) => x.trim()) : [],
          cc: m.cc ? m.cc.split(",").map((x) => x.trim()) : [],
          subject: m.subject === "(no subject)" ? "" : m.subject,
          bodyHtml: html ?? `<p>${(m.text ?? "").replace(/\n/g, "<br>")}</p>`,
          replaces: t.threadId,
          attachments,
          security: m.security?.encrypted ? { encrypt: true, sign: false, attachPublicKey: false } : undefined,
          confidential: m.confidential,
        });
      })();
      return;
    }
    void select(t.threadId);
  };

  // the flat list of lines (group headers + conversations) the virtual list draws from
  const items = useMemo(() => {
    const out: ListItem[] = [];
    let last = "";
    let pos = 0;
    for (const t of threads) {
      const group = prefs.sortAsc ? "" : t.pinned && folder === "inbox" ? "Pinned" : dateGroup(t.lastDate);
      if (group && group !== last) out.push({ kind: "group", key: `g:${t.rowKey}`, group, label: group });
      last = group;
      out.push({ kind: "row", key: t.rowKey, group, t, pos: ++pos });
    }
    return out;
  }, [threads, folder, prefs.sortAsc]);
  const revealKey = useMemo(() => (selected ? threads.find((t) => t.threadId === selected)?.rowKey ?? null : null), [threads, selected]);
  const viewKey = [folder, accountId, search, searchScope, filter, focus, prefs.sortAsc, prefs.conversations, prefs.focused].join("|");
  // oldest-first: older mail is added at the top, so that is where the list asks for it and where its status is shown
  // re-created when what loadMore would decide changes, so the list asks again (e.g. after "Loading…" ended with the end still in view)
  const nearMore = useCallback(() => {
    if (pageable) void loadMore();
  }, [pageable, loadMore, loadingMore, reachedEnd, capped, folder, accountId]);
  const pagingStatus = loadingMore ? (
    <span className="muted"><span className="spin" aria-hidden /> Loading…</span>
  ) : capped ? (
    <span className="muted">
      Download limit reached ({prefs.maxDownload.toLocaleString("en-US")} mails per mailbox). Raise it in{" "}
      <button className="link" onClick={() => setDialog({ type: "settings", tab: "mb:all", focus: "maxDownload" })}>Settings &gt; Reading &amp; sync</button>.
    </span>
  ) : reachedEnd ? (
    <span className="muted">You've reached the end</span>
  ) : (
    <button className="btn small" onClick={() => void loadMore(true)}>Load older messages</button>
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
        onToggle={() => toggleCheck(it.t.threadId)}
        posInSet={it.pos}
        setSize={threads.length}
      />
    );

  return (
    <section className="msg-list" aria-label="Message list">
      <div className={`ml-head ${multi ? "multi" : ""}`}>
        <div className="ml-title">
          {showTabs ? (
            <div className="pivots" role="tablist">
              <button role="tab" aria-selected={focus === "focused"} className={focus === "focused" ? "active" : ""} onClick={() => void setFocus("focused")}>Focused</button>
              <button role="tab" aria-selected={focus === "other"} className={focus === "other" ? "active" : ""} onClick={() => void setFocus("other")}>Other</button>
            </div>
          ) : (
            <h2 className="ellipsis">{title}</h2>
          )}
          <div className="ml-tools">
            <Dropdown
              className="link-btn"
              items={[
                { label: "All", checked: filter === "all", onClick: () => void setFilter("all") },
                { label: "Unread", checked: filter === "unread", onClick: () => void setFilter("unread") },
                { label: "Flagged", checked: filter === "flagged", onClick: () => void setFilter("flagged") },
              ]}
            >
              {filter === "all" ? "Filter" : `Filter: ${filter[0].toUpperCase()}${filter.slice(1)}`}
            </Dropdown>
          </div>
        </div>
        {searching ? (
          <div className="ml-sub">
            “{search.trim()}” · {scopeNote} · {threads.length} result{threads.length === 1 ? "" : "s"}
          </div>
        ) : (
          accountId && <div className="ml-sub">{labels.get(accountId)}</div>
        )}
        {pageable && prefs.sortAsc && !searching && (
          <div className="ml-progress" role="status">{pagingStatus}</div>
        )}
        {download.length > 0 && (
          <div className="ml-progress" role="status">
            <span className="spin" aria-hidden /> Downloading mails… {dlHave} / {dlTarget}
          </div>
        )}
        {multi && (
          <div className="ml-bulk">
            <span>{checked.size} selected</span>
            <button className="link-btn" onClick={() => setChecked(threads.map((t) => t.threadId))}>Select all</button>
            <button className="link-btn" onClick={() => setChecked([])}>Clear</button>
          </div>
        )}
      </div>

      <div className="ml-body" ref={scrollRef} role="listbox" aria-label={title} aria-multiselectable>
        {folder === "scheduled" ? (
          <ScheduledList />
        ) : (loading || firstHere) && threads.length === 0 ? (
          <>
            {firstHere && (
              <div className="ml-firstsync" role="status">
                <span className="spin" aria-hidden /> Syncing {labels.get(firstSync!) ?? "your account"}… the first download can take a minute.
              </div>
            )}
            <SkeletonRows />
          </>
        ) : threads.length === 0 ? (
          searching ? (
            <EmptyState
              icon={<SearchX size={40} />}
              title="No results"
              text={searchScope === "all" ? "Only mail already downloaded to this computer is searched. Older mail is downloaded as you scroll a folder." : "Try other words, or search every folder."}
              action={
                <>
                  {searchScope !== "all" && <button className="btn" onClick={() => void setSearchScope("all")}>Search all mailboxes</button>}
                  <WebmailSearch targets={webmails} query={search} openFolder={webmailFolder} />
                </>
              }
            />
          ) : filter !== "all" ? (
            <EmptyState icon={<FolderOpen size={40} />} title="Nothing matches this filter" action={<button className="btn" onClick={() => void setFilter("all")}>Show everything</button>} />
          ) : folder === "inbox" || folder === "unread" ? (
            <EmptyState icon={<CheckCheck size={40} />} title="You're all caught up" text="New mail will show up here as it arrives." />
          ) : (
            <EmptyState icon={<FolderOpen size={40} />} title="This folder is empty" />
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
            prefetch={filter === "all" && folder !== "unread"}
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
    </section>
  );
}
