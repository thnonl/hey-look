import { Inbox, RefreshCw, Search } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useState } from "react";
import { applyColorFallback } from "../colorFallback";
import { badgeText } from "../focusCounts";
import { makeFakeMailbox } from "../fakeMail";
import { useT } from "../i18n/react";
import { useStore } from "../store";
import { useAppDark } from "../useAppDark";
import { dateGroup, fmtFull } from "../util";
import { ThreadRow } from "./MessageList";
import { Avatar } from "./ui";
import logo from "../assets/logo.png";

/**
 * Miniature of the real window rendered from generated sample mail, so every appearance choice
 * (theme, density, reading pane, preview, conversations, Focused tabs, text size) is visible while you pick it.
 * The rows are the very same component the mailbox uses.
 */
export function AppearancePreview() {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const box = useMemo(() => makeFakeMailbox(seed), [seed]);
  const dark = useAppDark();
  // an engine without color-mix(): the preview has theme tokens of its own, computed here (W9.7); nothing happens elsewhere
  useLayoutEffect(() => applyColorFallback(), [dark, prefs.accent]);
  const threads = prefs.sortAsc ? [...box.threads].reverse() : box.threads;
  const shown = prefs.focused ? threads.filter((th) => !th.bulk) : threads;
  // like the real side menu: bulk mail is in the Inbox number when "Count Other (bulk) mail" is on or Focused Inbox is off
  const inboxUnread = box.threads.filter((th) => th.unread && (prefs.countOtherMail || !prefs.focused || !th.bulk)).length;
  // the tab numbers count each tab's own unread conversations, whatever that setting says
  const focusedUnread = box.threads.filter((th) => th.unread && !th.bulk).length;
  const otherUnread = box.threads.filter((th) => th.unread && th.bulk).length;
  let last = "";
  return (
    <div className="ap-wrap">
      <div className={`ap-preview pane-${prefs.readingPane}`} data-theme={dark ? "dark" : "light"} data-density={prefs.density} style={{ fontSize: prefs.fontSize }} aria-hidden inert>
        <div className="ap-top">
          <img src={logo} alt="" width={16} height={16} />
          <b>Hey Look!</b>
          <span className="ap-search">
            <Search size={11} /> {t("reading.preview.search")}
          </span>
        </div>
        <div className="ap-body">
          <div className="ap-folders">
            <div className="fp-row active">
              <Inbox size={13} /> {t("reading.preview.inbox")} <span className="fp-badge strong">{inboxUnread || ""}</span>
            </div>
            <div className="fp-row">{t("reading.preview.sent")}</div>
            <div className="fp-row">{t("reading.preview.drafts")}</div>
            <div className="fp-row">{t("reading.preview.archive")}</div>
          </div>
          <div className="ap-list">
            {prefs.focused ? (
              <div className="pivots ap-pivots">
                <span className="active" aria-hidden="true">
                  {t("reading.preview.focused")}
                  {focusedUnread > 0 && <span className="fp-badge strong">{badgeText(focusedUnread)}</span>}
                </span>
                <span aria-hidden="true">
                  {t("reading.preview.other")}
                  {otherUnread > 0 && <span className="fp-badge">{badgeText(otherUnread)}</span>}
                </span>
              </div>
            ) : (
              <h2 className="ap-title">{t("reading.preview.inbox")}</h2>
            )}
            {shown.map((th, i) => {
              const group = th.pinned ? t("reading.preview.pinned") : dateGroup(th.lastDate);
              const showGroup = !prefs.sortAsc && group !== last;
              last = group;
              return (
                <Fragment key={th.threadId}>
                  {showGroup && <div className="ml-group">{group}</div>}
                  <ThreadRow t={th} prefs={prefs} selected={i === 0} inPreview />
                </Fragment>
              );
            })}
          </div>
          <div className="ap-read">
            <h4>{box.message.subject}</h4>
            <div className="ap-from">
              <Avatar name={box.message.from} size={28} />
              <div>
                <b>{box.message.from}</b>
                <div className="muted small">{fmtFull(box.message.date)}</div>
              </div>
            </div>
            {box.message.paragraphs.map((p, i) => (
              <p key={i} className={i === box.message.paragraphs.length - 1 ? "muted pre" : ""}>
                {p}
              </p>
            ))}
          </div>
        </div>
      </div>
      <button className="link small shuffle" onClick={() => setSeed((s) => s + 1)}>
        <RefreshCw size={11} /> {t("reading.preview.shuffle")}
      </button>
    </div>
  );
}
