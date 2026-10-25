import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { accountLabel } from "../accountLabel";
import { api } from "../api";
import type { Rule, RuleCond, RuleField } from "../api";
import type { Key } from "../i18n";
import { useT } from "../i18n/react";
import { ruleTargetProblem } from "../junk";
import { folderLabel, folderTitle } from "../prefs";
import { moveChoices } from "../rowMenu";
import { condWords } from "../ruleText";
import { runRule, runSourceOk } from "../ruleRun";
import type { RuleSource } from "../ruleSource";
import { offeredDomain, senderLabel, splitValues, hasSubject, subjectCore, subjectExact, suggestWords } from "../ruleSuggest";
import { friendlyError, useStore } from "../store";
import { FolderDialog } from "./FolderDialog";
import { Modal, Switch } from "./ui";

// Create rule / Edit rule (1.0.8, REQ-3 / REQ-4 / REQ-7). One dialog for "Create rule…" on a message (`source`: the sender, the subject and suggested words fill it in) and for New rule /
// Edit rule in Settings (`rule`). A chunk of its own (lazyViews.tsx); the suggested words and their stop words (ruleSuggest.ts) come with it. It is drawn by the page (a message) or by
// Settings (inside the Settings dialog or window), so it closes through `onClose` and never touches the store's single dialog.

const MAX_ROWS = 10;
const NEW_FOLDER = "__new__";

type Op = RuleCond["op"];

interface Row {
  id: number;
  on: boolean;
  field: RuleField;
  op: Op;
  text: string;
  /** the part of a message this row was made from: its sender, its subject, the words box */
  role?: "from" | "subject" | "words";
  /** the text the dialog put there itself (the person has not changed it) */
  auto?: string;
  /** a saved condition: its values as saved, kept while the text is not touched (an old rule's value "Smith, John" is one value, not two) */
  keep?: { text: string; values: string[] };
}

interface Err {
  kind: "cond" | "folder" | "server";
  text: string;
}

export interface RuleDialogProps {
  /** edit this rule */
  rule?: Rule;
  /** make a rule from this message */
  source?: RuleSource;
  /** New rule in Settings: the mailbox the list was opened in (null: All accounts) */
  scope?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

let rowSeq = 0;
const newRow = (r: Omit<Row, "id">): Row => ({ id: ++rowSeq, ...r });
const FIELDS: RuleField[] = ["from", "to", "subject", "body", "subjectBody", "any"];
const hasOp = (f: RuleField) => f !== "body" && f !== "subjectBody";

function startRows(rule: Rule | undefined, source: RuleSource | undefined): Row[] {
  if (rule) {
    const rows = rule.conditions.map((c) => {
      const text = c.values.join(", ");
      return newRow({ on: true, field: c.field, op: c.op, text, keep: { text, values: c.values } });
    });
    return rows.length ? rows : [newRow({ on: true, field: "from", op: "contains", text: "" })];
  }
  if (!source) return [newRow({ on: true, field: "from", op: "contains", text: "" })];
  const rows: Row[] = [];
  const address = source.fromEmail.trim().toLowerCase();
  rows.push(newRow({ on: true, field: "from", op: address ? "equals" : "contains", text: address, role: "from", auto: address }));
  if (hasSubject(source.subject)) {
    const core = subjectCore(source.subject);
    rows.push(newRow({ on: false, field: "subject", op: "contains", text: core, role: "subject", auto: core }));
  }
  rows.push(newRow({ on: false, field: "subjectBody", op: "contains", text: "", role: "words" }));
  return rows;
}

export function RuleDialog({ rule, source, scope = null, onClose, onSaved }: RuleDialogProps) {
  const t = useT();
  const { accounts, folders, showToast } = useStore();
  const accountIds = accounts.map((a) => a.id);
  const [rows, setRows] = useState<Row[]>(() => startRows(rule, source));
  const [accountId, setAccountId] = useState<string>(rule ? rule.accountId ?? "" : source ? source.accountId : scope ?? "");
  const [action, setAction] = useState<Rule["action"]>(rule?.action ?? "move");
  const [folderKey, setFolderKey] = useState<string>(rule?.action === "move" ? rule.arg ?? "" : "");
  const [name, setName] = useState(rule?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!rule?.name);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [applyNow, setApplyNow] = useState(!!source && !rule);
  const [scan, setScan] = useState<{ n: number; capped: boolean } | "loading" | "error" | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [nested, setNested] = useState(false);
  const nestedRef = useRef(false);
  nestedRef.current = nested;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const folderRef = useRef<HTMLSelectElement>(null);
  const firstText = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const domain = source ? offeredDomain(source.fromEmail, source.mine) : null;
  const fromRow = rows.find((r) => r.role === "from");
  const domainMode = !!domain && !!fromRow && fromRow.field === "from" && fromRow.op === "contains" && fromRow.text.trim().toLowerCase() === `@${domain}`;
  const wordsRow = rows.find((r) => r.role === "words");
  const chips = useMemo(
    () => (source ? suggestWords({ subject: source.subject, text: source.text, senderName: source.fromName, senderEmail: source.fromEmail, confidential: source.text === null }) : []),
    [source],
  );

  const patch = (id: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  // ---- the conditions as the rule saves them: only the checked rows that have a value
  const conds: RuleCond[] = rows
    .filter((r) => r.on)
    .map((r) => ({ field: r.field, op: hasOp(r.field) ? r.op : "contains", values: r.keep && r.keep.text === r.text ? r.keep.values : splitValues(r.text) }) as RuleCond)
    .filter((c) => c.values.length > 0);

  // ---- the name: the person's own, else made from the conditions (one From row: "Mail from {sender}")
  const autoName = ((): string => {
    if (conds.length === 0) return "";
    const c = conds[0];
    if (conds.length === 1 && c.field === "from") {
      const v = c.values[0];
      let sender = v;
      if (domain && v.toLowerCase() === `@${domain}`) sender = senderLabel("", `x@${domain}`, true);
      else if (source && v.toLowerCase() === source.fromEmail.trim().toLowerCase()) sender = senderLabel(source.fromName, source.fromEmail, false);
      return t("settings.rules.fromSender", { sender });
    }
    return condWords(c);
  })();
  const shownName = nameTouched ? name : autoName;

  // ---- the folder picker (REQ-4): the folders of the mailbox in the order of "Move to"; for All mailboxes only the standard ones
  const options = useMemo(() => {
    if (accountId) {
      return moveChoices(folders, accountId, undefined)
        .filter((f) => f.key !== "inbox")
        .map((f) => ({ key: f.key, text: `${"— ".repeat(f.depth ?? 0)}${f.key.startsWith("f:") ? f.label ?? folderLabel(f.key, f.name) : folderLabel(f.key)}`, title: folderTitle(f, folders) }));
    }
    const std = ["archive", "junk", "trash"].filter((k) => k !== "junk" || accountIds.some((a) => folders.some((f) => f.accountId === a && f.key === "junk" && f.listed !== false) || !folders.some((f) => f.accountId === a)));
    return std.map((k) => ({ key: k, text: folderLabel(k), title: folderLabel(k) }));
  }, [accountId, folders, accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = options.some((o) => o.key === folderKey);
  // a rule for All mailboxes that points to a folder of the person keeps it shown; a rule whose folder is gone shows "Choose folder" and says so
  const keptOption = !!folderKey && !known && !accountId && folderKey.startsWith("f:") ? { key: folderKey, text: folderLabel(folderKey), title: folderLabel(folderKey) } : null;
  const missing = action === "move" && !!folderKey && !known && !keptOption;
  const pickerValue = known || keptOption ? folderKey : "";
  const junkProblem = ruleTargetProblem({ action: "junk", accountId: accountId || null }, folders, accountIds) !== null;

  // ---- how many messages already there the rule matches (REQ-7.1): when the dialog opens and 400 ms after the last change
  const srcFolder = source ? source.folder : "inbox";
  const draft: Rule = {
    id: rule?.id ?? "draft",
    accountId: accountId || null,
    name: "",
    conditions: conds,
    action,
    arg: action === "move" ? folderKey || null : null,
    enabled,
  };
  const offerRun = conds.length > 0 && runSourceOk(srcFolder, draft);
  const draftKey = JSON.stringify([conds, accountId, srcFolder, action, folderKey]);
  const asked = useRef(0);
  useEffect(() => {
    if (!offerRun) {
      setScan(null);
      return;
    }
    const mine = ++asked.current;
    setScan("loading");
    const timer = setTimeout(() => {
      api.ruleCount(draft, srcFolder).then(
        (r) => mine === asked.current && alive.current && setScan({ n: r.n, capped: r.capped }),
        () => mine === asked.current && alive.current && setScan("error"),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [draftKey, offerRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const srcName = (() => {
    const f = folders.find((x) => x.key === srcFolder && (source ? x.accountId === source.accountId : true));
    return f ? folderTitle(f, folders) : folderLabel(srcFolder);
  })();
  const moves = action !== "read" && action !== "star" && action !== "pin"; // (also before a folder is chosen)

  // ---- focus: the folder (the one thing to choose) when made from a message, else the first field
  useEffect(() => {
    const id = setTimeout(() => (source && action === "move" ? folderRef.current : firstText.current)?.focus(), 0);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Esc: the New folder dialog on top first (it closes itself, see FolderDialog), then this one. A capture listener, so the dialog under this one (Settings) does not close with it.
  const closeNow = () => {
    if (!busyRef.current) onClose();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || nestedRef.current || useStore.getState().ask) return;
      e.preventDefault();
      closeNow();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions on the rows
  const setText = (r: Row, text: string) => {
    const on = r.role === "words" ? text.trim() !== "" : text.trim() !== "" ? true : r.on;
    patch(r.id, { text, on, ...(r.auto !== undefined && text !== r.auto ? { auto: undefined } : {}) });
    setErr((e) => (e?.kind === "cond" ? null : e));
  };
  const setOp = (r: Row, op: Op) => {
    // "Subject is exactly" of a message starts from the whole subject (prefixes off), "contains" from its core; text the person changed stays
    if (r.role === "subject" && source && r.auto !== undefined && r.text === r.auto) {
      const text = op === "equals" ? subjectExact(source.subject) : subjectCore(source.subject);
      patch(r.id, { op, text, auto: text });
    } else patch(r.id, { op });
  };
  const toggleDomain = () => {
    if (!fromRow || !domain || !source) return;
    if (domainMode) patch(fromRow.id, { op: "equals", text: source.fromEmail.trim().toLowerCase() });
    else patch(fromRow.id, { op: "contains", text: `@${domain}` });
  };
  const chipOn = (w: string) => !!wordsRow && splitValues(wordsRow.text).some((v) => v.toLowerCase() === w.toLowerCase());
  const toggleChip = (w: string) => {
    if (!wordsRow) return;
    const values = splitValues(wordsRow.text);
    if (chipOn(w)) {
      const rest = values.filter((v) => v.toLowerCase() !== w.toLowerCase());
      patch(wordsRow.id, { text: rest.join(", "), on: rest.length > 0 });
    } else patch(wordsRow.id, { text: [...values, w].join(", "), on: true });
    setErr((e) => (e?.kind === "cond" ? null : e));
  };
  const changeAccount = (id: string) => {
    setAccountId(id);
    // a folder the other mailbox does not have is cleared
    if (folderKey.startsWith("f:") && (!id || !folders.some((f) => f.accountId === id && f.key === folderKey))) setFolderKey("");
  };

  // ---- save
  const save = async () => {
    if (busy) return;
    if (conds.length === 0) {
      setErr({ kind: "cond", text: t("settings.rules.errCondition") });
      requestAnimationFrame(() => firstText.current?.focus());
      return;
    }
    if (action === "move" && !folderKey) {
      setErr({ kind: "folder", text: t("settings.rules.errFolder") });
      requestAnimationFrame(() => folderRef.current?.focus());
      return;
    }
    setBusy(true);
    setErr(null);
    const toSave: Rule = { ...draft, id: rule?.id ?? crypto.randomUUID(), name: (nameTouched ? name.trim() : "") || autoName };
    try {
      await api.saveRule(toSave);
    } catch (e) {
      if (alive.current) {
        setErr({ kind: "server", text: friendlyError(e) });
        setBusy(false);
      }
      return;
    }
    showToast(t("settings.filters.saved"), undefined, "success");
    const run = applyNow && offerRun && scan !== null && scan !== "loading" && scan !== "error" && scan.n > 0;
    onSaved?.();
    onClose();
    if (run) void runRule(toSave, srcFolder).catch((e) => useStore.getState().showToast(() => t("errors.toast.failed", { error: friendlyError(e) }), undefined, "error"));
  };

  const fieldLabel: Record<RuleField, Key> = {
    from: "settings.filters.from", to: "settings.filters.to", subject: "settings.filters.subject", body: "settings.rules.kBody", subjectBody: "settings.rules.kSubjectBody", any: "settings.filters.anyField",
  };

  const applyLabel = ((): { text: string; busy?: boolean; plain?: boolean } | null => {
    if (!offerRun || scan === null) return null;
    if (scan === "loading" || scan === "error") return { text: t("settings.rules.applyNowMany", { folder: srcName }), busy: scan === "loading" };
    if (scan.n === 0 && !scan.capped) return { text: t("settings.rules.applyNowNone", { folder: srcName }), plain: true };
    if (scan.capped) return { text: t("settings.rules.applyNowMany", { folder: srcName }) };
    return { text: t(moves ? "settings.rules.applyNowMove" : "settings.rules.applyNowOther", { n: scan.n, folder: srcName }) };
  })();

  return (
    <>
      <Modal title={t(rule ? "settings.rules.edit" : "settings.rules.create")} onClose={closeNow} width={560}>
        {/* (not a form element: the policy has form-action none; Enter in a field does nothing, Ctrl+Enter saves) */}
        <div
          className="form rd-form"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") e.preventDefault();
          }}
        >
          <div className="field">
            <label htmlFor="rd-account">{t("settings.rules.applyTo")}</label>
            <select id="rd-account" value={accountId} onChange={(e) => changeAccount(e.target.value)}>
              <option value="">{t("app.search.allMailboxes")}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a).text}</option>)}
            </select>
          </div>

          <div className="rd-head" id="rd-when">{t("settings.rules.when")}</div>
          <div className="rd-conds" role="group" aria-labelledby="rd-when">
            {rows.map((r, i) => (
              <div key={r.id} className="rd-item">
                <div className="rd-row">
                  <input type="checkbox" className="rd-on" aria-label={t("settings.rules.useCondition")} checked={r.on} onChange={(e) => patch(r.id, { on: e.target.checked })} />
                  <select aria-label={t("settings.filters.ruleField")} value={r.field} onChange={(e) => patch(r.id, { field: e.target.value as RuleField })}>
                    {FIELDS.map((f) => <option key={f} value={f}>{t(fieldLabel[f])}</option>)}
                  </select>
                  {hasOp(r.field) ? (
                    <select aria-label={t("settings.filters.ruleCondition")} value={r.op} onChange={(e) => setOp(r, e.target.value as Op)}>
                      <option value="contains">{t("settings.filters.opContains")}</option>
                      <option value="equals">{t("settings.filters.opEquals")}</option>
                    </select>
                  ) : (
                    <span className="muted rd-static">{t("settings.filters.opContains")}</span>
                  )}
                  <input
                    ref={i === 0 ? firstText : undefined}
                    aria-label={t("settings.filters.ruleText")}
                    aria-invalid={err?.kind === "cond" && i === 0 ? true : undefined}
                    aria-describedby={err?.kind === "cond" && i === 0 ? "rd-err" : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={r.field === "from" || r.field === "to" ? "newsletter@example.com" : undefined}
                    value={r.text}
                    onChange={(e) => setText(r, e.target.value)}
                  />
                </div>
                {r.role === "from" && domain && r.field === "from" && (
                  <button type="button" className="link rd-link" onClick={toggleDomain}>
                    {domainMode ? t("settings.rules.onlyAddress", { address: source?.fromEmail.trim().toLowerCase() ?? "" }) : t("settings.rules.anyAtDomain", { domain })}
                  </button>
                )}
                {r.role === "words" && (
                  chips.length > 0 ? (
                    <div className="rd-chips" role="group" aria-label={t("settings.rules.suggested")}>
                      <span className="muted rd-chips-lbl" aria-hidden>{t("settings.rules.suggested")}</span>
                      {chips.map((w) => (
                        <button key={w} type="button" className={`sb-chip${chipOn(w) ? " on" : ""}`} aria-pressed={chipOn(w)} onClick={() => toggleChip(w)}>{w}</button>
                      ))}
                      <div className="muted small rd-chips-hint">{t("settings.rules.suggestedHint")}</div>
                    </div>
                  ) : (
                    <div className="muted small rd-chips">{t("settings.rules.noSuggestions")}</div>
                  )
                )}
              </div>
            ))}
          </div>
          <div className="muted small">{t("settings.rules.valuesHint")}</div>
          <div>
            <button type="button" className="btn" disabled={rows.length >= MAX_ROWS} onClick={() => setRows((rs) => [...rs, newRow({ on: true, field: "from", op: "contains", text: "" })])}>
              <Plus size={14} /> {t("settings.rules.addCondition")}
            </button>
          </div>
          {err?.kind === "cond" && <div id="rd-err" className="field-err" role="alert">{err.text}</div>}

          <div className="rd-head" id="rd-do">{t("settings.rules.doThis")}</div>
          <div className="rd-do" role="group" aria-labelledby="rd-do">
            <select aria-label={t("settings.filters.ruleAction")} value={action} onChange={(e) => (setAction(e.target.value as Rule["action"]), setErr(null))}>
              <option value="move">{t("settings.filters.toFolder")}</option>
              <option value="archive">{t("settings.action.archive")}</option>
              <option value="trash">{t("common.delete")}</option>
              {/* (W6.2) where the mailbox has no Junk folder the option is greyed out and says so */}
              <option value="junk" disabled={junkProblem && action !== "junk"}>{junkProblem ? t("settings.filters.toJunkNone") : t("settings.filters.toJunk")}</option>
              <option value="read">{t("settings.action.read")}</option>
              <option value="star">{t("settings.action.flag")}</option>
              <option value="pin">{t("settings.action.pin")}</option>
            </select>
            {action === "move" && (
              <select
                ref={folderRef}
                aria-label={t("settings.filters.targetFolder")}
                aria-invalid={err?.kind === "folder" ? true : undefined}
                aria-describedby={err?.kind === "folder" ? "rd-err2" : missing ? "rd-miss" : undefined}
                value={pickerValue}
                onChange={(e) => {
                  if (e.target.value === NEW_FOLDER) return setNested(true);
                  setFolderKey(e.target.value);
                  setErr(null);
                }}
              >
                <option value="">{t("settings.filters.chooseFolder")}</option>
                {keptOption && <option value={keptOption.key} title={keptOption.title}>{keptOption.text}</option>}
                {options.map((o) => <option key={o.key} value={o.key} title={o.title}>{o.text}</option>)}
                {accountId && <option value={NEW_FOLDER}>{t("mail.folder.new")}</option>}
              </select>
            )}
          </div>
          {action === "junk" && junkProblem && <div className="muted small" role="note">{t("mail.junk.noneTip")}</div>}
          {missing && <div id="rd-miss" className="muted small" role="note">{t("settings.rules.folderMissing")}</div>}
          {err?.kind === "folder" && <div id="rd-err2" className="field-err" role="alert">{err.text}</div>}

          {applyLabel && (
            applyLabel.plain ? (
              <div className="muted small rd-now">{applyLabel.text}</div>
            ) : (
              <label className="rd-now rd-check">
                <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} />
                <span>{applyLabel.text}</span>
                {applyLabel.busy && <span className="spin busy-ring" aria-hidden />}
              </label>
            )
          )}

          <div className="field">
            <label htmlFor="rd-name">{t("settings.form.name")}</label>
            <input
              id="rd-name"
              autoComplete="off"
              placeholder={t("settings.filters.namePlaceholder")}
              value={shownName}
              onChange={(e) => (setName(e.target.value), setNameTouched(true))}
            />
          </div>
          <Switch checked={enabled} onChange={setEnabled} label={t("settings.filters.enabled")} />

          {err?.kind === "server" && <div className="field-err" role="alert">{err.text}</div>}
          <div className="row-inline rd-actions">
            <button type="button" className="btn" onClick={closeNow}>{t("common.cancel")}</button>
            <button type="button" className="btn primary" aria-busy={busy || undefined} disabled={busy} onClick={() => void save()}>
              {busy && <span className="spin" aria-hidden />}
              <span>{t("common.save")}</span>
            </button>
          </div>
        </div>
      </Modal>
      {nested && accountId && (
        <FolderDialog
          accountId={accountId}
          parentKey={null}
          onClose={() => {
            setNested(false);
            requestAnimationFrame(() => folderRef.current?.focus());
          }}
          onCreated={(key) => {
            setFolderKey(key);
            setErr(null);
          }}
        />
      )}
    </>
  );
}
