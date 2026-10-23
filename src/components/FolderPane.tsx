import {
  AlertTriangle, Archive, CalendarClock, CalendarDays, ChevronDown, ChevronRight, Clock, FileText, Flag, Folder, Inbox, MailOpen, OctagonAlert, PanelLeftClose, PanelLeftOpen, Pin, Send, Star, Trash2,
} from "lucide-react";
import { ReactNode, useEffect, useRef } from "react";
import { accountLabel } from "../accountLabel";
import { Grip, useAccountReorder } from "./AccountReorder";
import { AcctName } from "./AcctName";
import { CalRail, CalSidebar } from "./Calendar";
import { ReauthNotice } from "./SignInHelp";
import { FolderInfo } from "../api";
import { accountColor, folderDepth, folderLabel } from "../prefs";
import { useT } from "../i18n/react";
import { kbd } from "../platform";
import { folderVisible } from "../junk";
import { useStore } from "../store";
import { hasNew, hasNewMailbox } from "../newMail";
import { useSidebarPeek } from "../sidebarPeek";
import { sidebarControlOpen, toggleSidebar } from "../sidebarState";
import { sidebarInput, useWindowWidth } from "../useSidebar";

const ICONS: Record<string, ReactNode> = {
  inbox: <Inbox size={16} />,
  drafts: <FileText size={16} />,
  sent: <Send size={16} />,
  archive: <Archive size={16} />,
  junk: <OctagonAlert size={16} />,
  trash: <Trash2 size={16} />,
  starred: <Flag size={16} />,
  pinned: <Pin size={16} />,
  snoozed: <Clock size={16} />,
  scheduled: <CalendarClock size={16} />,
  unread: <MailOpen size={16} />,
};

const VIRTUAL_VIEWS = ["unread", "starred", "pinned", "snoozed", "scheduled"];

/** A mailbox's initial for its round avatar in the icon column (CSS shows it from data-initial). */
const initialOf = (text: string) => (Array.from(text.trim())[0] ?? "?").toUpperCase();
/** The numbers that stay on an icon: unread conversations where they help (the same rule as the badge of a row). */
const RAIL_BADGE_KEYS = ["inbox", "unread", "junk"];

/**
 * The side menu. `collapsed` is what the layout says (App.tsx, sidebarState.ts): the column is the icons. While it is, the full menu
 * opens over the other panes as a peek (sidebarPeek.ts); the markup is the same, `rail` only drops the words.
 */
export function FolderPane({ collapsed: folded }: { collapsed: boolean }) {
  const t = useT();
  const { accounts, folders, folder, accountId, setView, prefs, setPrefs, syncErrors, sync, outbox, module, setModule, firstSync, reauth, newMail } = useStore();
  const toggleReq = useStore((s) => s.sidebarToggle);
  useWindowWidth(); // (the control follows the window: whether the full menu would fit next to the panes)
  const tree = useRef<HTMLDivElement>(null);
  const reorder = useAccountReorder(tree); // the mailbox groups can be moved (grip, Alt+Up / Alt+Down, menu); see AccountReorder.tsx
  const peek = useSidebarPeek(folded, reorder.dragging !== null || reorder.menuOpen);
  const rail = folded && !peek.open; // icons only; a peek is the full menu over the panes
  // the control and Ctrl+B / Cmd+B (sidebarState.ts `toggleSidebar`): fold or open the menu in place, or - with no room next to the list - open the overlay pinned or close it
  const onToggle = () => {
    const r = toggleSidebar(sidebarInput(), peek.open);
    if (r.mode !== prefs.sidebar) setPrefs({ sidebar: r.mode }); // (the person's own choice from now on)
    if (r.overlay === "close") peek.close();
    else if (r.overlay === "open") {
      peek.pin();
      // the keyboard goes into the menu: the selected folder (or the first row)
      requestAnimationFrame(() => {
        const pane = peek.bind.ref.current;
        (pane?.querySelector<HTMLElement>(".fp-row.active") ?? pane?.querySelector<HTMLElement>(".fp-row"))?.focus({ preventScroll: true });
      });
    }
  };
  const seenToggle = useRef(toggleReq);
  useEffect(() => {
    if (toggleReq !== seenToggle.current) {
      seenToggle.current = toggleReq;
      onToggle();
    }
  }, [toggleReq]); // eslint-disable-line react-hooks/exhaustive-deps
  // a new account's group sits at the bottom of a long tree: bring its (selected) Inbox into view
  useEffect(() => {
    if (firstSync && accountId === firstSync) document.querySelector(".fp-tree .fp-row.active")?.scrollIntoView({ block: "nearest" });
  }, [firstSync, accountId]);

  // in the icon column the chosen folder (or mailbox) can be below the fold of a low window: bring it into view
  useEffect(() => {
    if (rail) (document.querySelector(".fp-tree .fp-row.active") ?? document.querySelector(".fp-tree .fp-avatar.on"))?.scrollIntoView({ block: "nearest" });
  }, [rail, accountId, folder]);

  const isFav = (acct: string | null, key: string) => prefs.favorites.includes(`${acct ?? "*"}|${key}`);
  const toggleFav = (acct: string | null, key: string) => {
    const id = `${acct ?? "*"}|${key}`;
    setPrefs({ favorites: isFav(acct, key) ? prefs.favorites.filter((f) => f !== id) : [...prefs.favorites, id] });
  };
  const collapsed = (k: string) => !!prefs.collapsed[k];
  const toggle = (k: string) => setPrefs({ collapsed: { ...prefs.collapsed, [k]: !collapsed(k) } });

  const counts = (acct: string | null, key: string): { unread: number; total: number } =>
    folders
      .filter((f) => f.key === key && (acct === null || f.accountId === acct))
      .reduce((a, f) => ({ unread: a.unread + f.unread, total: a.total + f.total }), { unread: 0, total: 0 });

  /** "12 unread" for a tooltip and a screen reader, empty for none. */
  const unreadText = (n: number) => (n > 0 ? t("mail.side.unread", { n }) : "");

  const row = (acct: string | null, key: string, label: string, indent = 0, name?: string) => {
    const active = folder === key && accountId === acct;
    const c = counts(acct, key);
    // calm numbers: only unread conversations, and only where they help (Inbox / Junk / the Unread view); drafts show a total
    const badge = key === "inbox" || key === "unread" || key === "junk" ? c.unread : key === "drafts" ? c.total : 0;
    // Scheduled: how many are queued, or how many failed (shown in red)
    const failed = key === "scheduled" ? outbox.filter((o) => o.status === "failed").length : 0;
    const queued = key === "scheduled" ? outbox.length : 0;
    const go = () => {
      void setView(key, acct);
      peek.close(); // a folder was chosen: the menu that opened over the panes goes away
    };
    const full = name && name !== label ? name : label;
    // (W13.2) new mail since the person last looked: a dot and a bolder label, and the words in the tooltip / the name for a screen reader
    const fresh = hasNew(newMail, acct, key);
    const newText = fresh ? t("mail.side.newMail") : "";
    // the icon column has no words: the name and the unread count are the tooltip and the name for a screen reader
    const tip = rail
      ? [full, unreadText(RAIL_BADGE_KEYS.includes(key) ? c.unread : 0), failed > 0 ? t("mail.pane.failedTitle", { n: failed }) : "", newText].filter(Boolean).join("\n")
      : fresh
        ? [full, unreadText(RAIL_BADGE_KEYS.includes(key) ? c.unread : 0), newText].filter(Boolean).join("\n")
        : name && name !== label ? name : undefined;
    return (
      <div
        key={`${acct}|${key}`}
        role="treeitem"
        aria-selected={active}
        aria-label={tip && rail ? tip.replace(/\n/g, ", ") : undefined}
        tabIndex={0}
        className={`fp-row ${active ? "active" : ""} ${fresh ? "fresh" : ""}`}
        style={rail ? undefined : { paddingLeft: 12 + indent * 16 }}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            go();
          }
        }}
        title={tip}
      >
        <span className="fp-ico">{ICONS[key] ?? <Folder size={16} />}</span>
        <span className="fp-lbl ellipsis">{label}</span>
        {fresh && <span className="fp-new" aria-hidden />}
        {fresh && !rail && <span className="sr-only">, {newText}</span>}
        {badge > 0 && (!rail || RAIL_BADGE_KEYS.includes(key)) && <span className={`fp-badge ${key === "inbox" || key === "unread" ? "strong" : ""}`}>{badge > 99 ? "99+" : badge}</span>}
        {failed > 0 ? (
          <span className="fp-badge err" title={t("mail.pane.failedTitle", { n: failed })}>{rail ? "!" : t("mail.pane.failedBadge", { n: failed })}</span>
        ) : queued > 0 && key === "scheduled" ? (
          <span className="fp-badge">{queued}</span>
        ) : null}
        {!rail && (
          <button
            className={`fp-star ${isFav(acct, key) ? "on" : ""}`}
            title={isFav(acct, key) ? t("mail.pane.removeFav") : t("mail.pane.addFav")}
            aria-label={isFav(acct, key) ? t("mail.pane.removeFav") : t("mail.pane.addFav")}
            onClick={(e) => {
              e.stopPropagation();
              toggleFav(acct, key);
            }}
          >
            <Star size={12} fill={isFav(acct, key) ? "currentColor" : "none"} />
          </button>
        )}
      </div>
    );
  };

  const favs = prefs.favorites
    .map((f) => {
      const [a, ...k] = f.split("|");
      return { acct: a === "*" ? null : a, key: k.join("|") };
    })
    .filter((f) => f.acct === null || accounts.some((a) => a.id === f.acct));

  const acctName = (id: string | null) => {
    const a = accounts.find((x) => x.id === id);
    return a ? accountLabel(a).text : "";
  };
  const labelFor = (acct: string | null, key: string) => {
    const info: FolderInfo | undefined = folders.find((f) => f.accountId === acct && f.key === key);
    const base = folderLabel(key, info?.name);
    return acct ? `${base} — ${acctName(acct)}` : base;
  };

  const head = (id: string, label: ReactNode, movable = false, fresh = false) => (
    <button className={`fp-head ${fresh ? "fresh" : ""}`} onClick={() => toggle(id)} aria-expanded={!collapsed(id)} data-reorder-focus={movable ? "" : undefined}>
      {collapsed(id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      {label}
      {fresh && <span className="fp-new" aria-hidden />}
      {fresh && <span className="sr-only">, {t("mail.side.newMail")}</span>}
    </button>
  );

  /** A mailbox in the icon column: its colour as a round avatar with the number of unread conversations; a click opens its Inbox. */
  const avatar = (a: (typeof accounts)[number], error: string | undefined) => {
    const l = accountLabel(a);
    const unread = counts(a.id, "inbox").unread;
    const warn = !!error || !!reauth[a.id];
    const fresh = hasNewMailbox(newMail, a.id); // (W13.2) its Inbox got new mail: a ring around the avatar
    const newText = fresh ? t("mail.side.newMail") : "";
    // the display name and the address, the unread count, then what is wrong; a mailbox without a display name shows the address once
    const tip = [l.tip ?? l.text, unreadText(unread), error ?? "", newText].filter(Boolean).join("\n");
    return (
      <button
        className={`fp-head fp-avatar ${accountId === a.id ? "on" : ""} ${fresh ? "fresh" : ""}`}
        data-reorder-focus=""
        aria-current={accountId === a.id ? "true" : undefined}
        aria-label={[l.name ? `${l.name} (${a.email})` : a.email, unreadText(unread), error ?? "", newText].filter(Boolean).join(", ")}
        title={tip}
        onClick={() => {
          void setView("inbox", a.id);
          peek.close();
        }}
      >
        <span className="dot" data-initial={initialOf(l.text)} style={{ background: accountColor(a, prefs.accent) }} />
        {unread > 0 && <span className="fp-pip">{unread > 99 ? "99+" : unread}</span>}
        {warn && <span className="fp-warnpip" aria-hidden />}
      </button>
    );
  };

  const shown = sidebarControlOpen(sidebarInput(), peek.open); // the full menu is on screen (in place, or as the overlay when there is no room): the control folds it
  const toggleLabel = shown ? t("mail.side.collapse") : t("mail.side.expand");
  const favRows = collapsed("fav") ? [] : favs.filter((f) => folderVisible(folders, f.acct, f.key)).map((f) => row(f.acct, f.key, labelFor(f.acct, f.key)));
  const viewRows = collapsed("views") ? [] : VIRTUAL_VIEWS.map((k) => row(null, k, folderLabel(k)));

  return (
    <aside
      className={`folder-pane ${folded ? "is-folded" : ""} ${rail ? "is-rail" : ""} ${peek.open ? "is-peek" : ""}`}
      aria-label={module === "calendar" ? t("mail.pane.calendars") : t("mail.pane.folders")}
      data-sidebar={rail ? "rail" : peek.open ? "peek" : "open"}
      {...peek.bind}
    >
      <div className="fp-surface">
      <div className="fp-top">
        <button
          className="icon-btn fp-toggle"
          aria-expanded={shown}
          aria-label={toggleLabel}
          title={kbd(`${toggleLabel} (Ctrl+B)`)}
          onClick={onToggle}
        >
          {shown ? <PanelLeftClose size={16} aria-hidden /> : <PanelLeftOpen size={16} aria-hidden />}
        </button>
      </div>
      {module === "calendar" ? (
        rail ? <CalRail /> : <CalSidebar />
      ) : (
      <div className="fp-tree" role="tree" aria-label={t("mail.pane.folders")} ref={tree}>
      <div className="fp-group">
        {rail ? favRows.length > 0 && <hr className="fp-sep" /> : head("fav", t("mail.pane.favorites"))}
        {favRows}
      </div>

      <div className="fp-group">
        {rail ? viewRows.length > 0 && <hr className="fp-sep" /> : head("views", t("mail.pane.quickViews"))}
        {viewRows}
      </div>

      {accounts.map((a) => {
        const mine = folders.filter((f) => f.accountId === a.id);
        const std = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
        const custom = mine.filter((f) => f.key.startsWith("f:"));
        const error = syncErrors[a.id];
        // the icon column lists the folders of the selected mailbox only; the open menu lists them all
        const folderRows = !collapsed(a.id) && (!rail || accountId === a.id);
        return (
          <div className={`fp-group ${reorder.dragging === a.id ? "reorder-src" : ""}`} key={a.id} data-reorder-id={a.id} {...reorder.entry(a.id)}>
            {rail && <hr className="fp-sep" />}
            <div className="fp-headrow">
            {accounts.length > 1 && <Grip email={accountLabel(a).text} bind={reorder.grip(a.id)} dragging={reorder.dragging === a.id} />}
            {rail ? avatar(a, error) : head(
              a.id,
              <>
                <span className="dot" data-initial={initialOf(accountLabel(a).text)} style={{ background: accountColor(a, prefs.accent) }} />
                <AcctName account={a} className="ellipsis fp-acct" />
                {error && (
                  <span
                    className="fp-warn"
                    role="button"
                    tabIndex={0}
                    title={t("mail.pane.retry", { error })}
                    onClick={(e) => {
                      e.stopPropagation();
                      void sync();
                    }}
                  >
                    <AlertTriangle size={13} />
                  </span>
                )}
              </>,
              true,
              hasNewMailbox(newMail, a.id),
            )}
            </div>
            {!rail && <ReauthNotice account={a} compact />}
            {folderRows && (
              <>
                {std.filter((k) => folderVisible(folders, a.id, k)).map((k) => row(a.id, k, folderLabel(k), 1))}
                {custom.map((f) => row(a.id, f.key, folderLabel(f.key, f.name), 1 + folderDepth(f.key, f.name), f.name))}
              </>
            )}
          </div>
        );
      })}
      </div>
      )}
      <nav className="fp-modules" aria-label={t("mail.pane.switch")}>
        <button aria-current={module === "mail" ? "page" : undefined} aria-label={t("mail.pane.mail")} title={kbd(t("mail.pane.mailTitle"))} onClick={() => setModule("mail")}>
          <Inbox size={15} aria-hidden /> <span className="fp-mlbl">{t("mail.pane.mail")}</span>
        </button>
        <button aria-current={module === "calendar" ? "page" : undefined} aria-label={t("mail.pane.calendar")} title={kbd(t("mail.pane.calendarTitle"))} onClick={() => setModule("calendar")}>
          <CalendarDays size={15} aria-hidden /> <span className="fp-mlbl">{t("mail.pane.calendar")}</span>
        </button>
      </nav>
      </div>
      {reorder.overlay}
    </aside>
  );
}
