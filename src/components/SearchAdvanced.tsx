import { format } from "date-fns";
import { Paperclip, Pin, Star, Mail } from "lucide-react";
import { Fragment } from "react";
import { useT } from "../i18n/react";
import { tx } from "../i18n/rich";
import { getKey, hasTok, setKey, toggleTok } from "../searchQuery";
import { DateField } from "./DateTimeFields";

// "Advanced search" (W13.4): the filters, the dates, the fields and the operators of the search panel. A chunk of its own, loaded when the person opens "Advanced search" (lazyViews.tsx);
// the search box and the simple panel (SearchBox.tsx) stay in the first chunk.

// the operators the person types into the box: they are not translated
const OPERATORS = ["from:", "to:", "subject:", "body:", "folder:sent", "is:unread|read|flagged|pinned", "has:attachment", "after:2026-01-31", "before:", "after:7d"];
const QUOTE_EXAMPLE = '"quarterly report"';

const DATES = [
  ["", "app.search.anyTime"],
  ["today", "app.date.today"],
  ["7d", "app.search.past7"],
  ["30d", "app.search.past30"],
  ["365d", "app.search.pastYear"],
] as const;

export interface SearchAdvancedProps {
  /** the text of the search box */
  q: string;
  /** the box gets a new text; `immediate` runs the search at once (else after a short pause) */
  change: (value: string, immediate?: boolean) => void;
  /** only the text in the box changes (a field being typed in), nothing runs yet */
  edit: (value: string) => void;
  /** run the search; `remember` puts it in the recent searches */
  run: (value: string, remember?: boolean) => void;
  /** the panel closes */
  close: () => void;
  /** Advanced search cannot be loaded: the panel goes back to the simple look (lazyViews.tsx) */
  onFail?: () => void;
}

export function SearchAdvanced({ q, change, edit, run, close }: SearchAdvancedProps) {
  const t = useT();

  const date = (() => {
    const a = getKey(q, "after");
    if (!a) return "";
    if (a === format(new Date(), "yyyy-MM-dd")) return "today";
    return DATES.some(([k]) => k === a) ? a : "custom";
  })();
  const setDate = (v: string) => change(setKey(q, "after", v === "today" ? format(new Date(), "yyyy-MM-dd") : v), true);

  const chip = (label: string, token: string, icon: React.ReactNode) => (
    <button key={token} className={`sb-chip ${hasTok(q, token) ? "on" : ""}`} onClick={() => change(toggleTok(q, token), true)}>
      {icon}
      {label}
    </button>
  );

  const dateField = (label: string, key: string) => {
    const v = getKey(q, key);
    return (
      <div className="sb-field">
        <label htmlFor={`sb-${key}`}>{label}</label>
        <DateField id={`sb-${key}`} allowEmpty value={/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""} onChange={(d) => change(setKey(q, key, d), true)} />
      </div>
    );
  };

  const field = (label: string, key: string, placeholder: string) => (
    <label className="sb-field">
      <span>{label}</span>
      <input
        value={getKey(q, key)}
        placeholder={placeholder}
        onChange={(e) => edit(setKey(q, key, e.target.value))}
        onKeyDown={(e) => e.key === "Enter" && (run(q, true), close())}
        onBlur={() => run(q)}
      />
    </label>
  );

  return (
    <>
      <div className="sb-section">
        <div className="sb-title">{t("app.search.filters")}</div>
        <div className="sb-chips">
          {chip(t("app.search.unread"), "is:unread", <Mail size={13} />)}
          {chip(t("app.search.flagged"), "is:flagged", <Star size={13} />)}
          {chip(t("app.search.pinned"), "is:pinned", <Pin size={13} />)}
          {chip(t("app.search.hasAttachment"), "has:attachment", <Paperclip size={13} />)}
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-title">{t("app.search.date")}</div>
        <div className="sb-chips">
          {DATES.map(([k, l]) => (
            <button key={k || "any"} className={`sb-chip ${date === k ? "on" : ""}`} onClick={() => setDate(k)}>
              {t(l)}
            </button>
          ))}
        </div>
        <div className="sb-row">
          {dateField(t("app.search.after"), "after")}
          {dateField(t("app.search.before"), "before")}
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-title">{t("app.search.fields")}</div>
        <div className="sb-row">
          {field(t("app.search.from"), "from", t("app.search.nameOrAddress"))}
          {field(t("app.search.to"), "to", t("app.search.nameOrAddress"))}
        </div>
        <div className="sb-row">{field(t("app.search.subject"), "subject", t("app.search.subjectHint"))}</div>
      </div>

      <div className="sb-foot muted small">
        {t("app.search.operators")}{" "}
        {OPERATORS.map((o, i) => (
          <Fragment key={o}>
            {i > 0 && " "}
            <code>{o}</code>
          </Fragment>
        ))}
        . {tx("app.search.quote", { example: <code>{QUOTE_EXAMPLE}</code> })}
      </div>
    </>
  );
}
