import { Inbox, RefreshCw, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { makeFakeMailbox } from "../fakeMail";
import { useStore } from "../store";
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
  const prefs = useStore((s) => s.prefs);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const box = useMemo(() => makeFakeMailbox(seed), [seed]);
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const threads = prefs.sortAsc ? [...box.threads].reverse() : box.threads;
  const shown = prefs.focused ? threads.filter((t) => !t.bulk) : threads;
  let last = "";
  return (
    <div className="ap-wrap">
      <div className={`ap-preview pane-${prefs.readingPane}`} data-theme={dark ? "dark" : "light"} data-density={prefs.density} style={{ fontSize: prefs.fontSize }} aria-hidden>
        <div className="ap-top">
          <img src={logo} alt="" width={16} height={16} />
          <b>Hey Look!</b>
          <span className="ap-search">
            <Search size={11} /> Search mail
          </span>
        </div>
        <div className="ap-body">
          <div className="ap-folders">
            <div className="fp-row active">
              <Inbox size={13} /> Inbox <span className="fp-badge strong">{box.threads.filter((t) => t.unread && !t.bulk).length || ""}</span>
            </div>
            <div className="fp-row">Sent Items</div>
            <div className="fp-row">Drafts</div>
            <div className="fp-row">Archive</div>
          </div>
          <div className="ap-list">
            {prefs.focused ? (
              <div className="pivots ap-pivots">
                <button className="active">Focused</button>
                <button>Other</button>
              </div>
            ) : (
              <h2 className="ap-title">Inbox</h2>
            )}
            {shown.map((t, i) => {
              const group = t.pinned ? "Pinned" : dateGroup(t.lastDate);
              const showGroup = !prefs.sortAsc && group !== last;
              last = group;
              return (
                <Fragment key={t.threadId}>
                  {showGroup && <div className="ml-group">{group}</div>}
                  <ThreadRow t={t} prefs={prefs} selected={i === 0} />
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
        <RefreshCw size={11} /> Generate different sample mail
      </button>
    </div>
  );
}
