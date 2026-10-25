// The message a rule is made from ("Create rule…" in the list menu, the reading pane, a reader window and the command bar): what the rule dialog needs of it, and nothing more.
// Plain data, so a reader window can hand it to the main window (src/popout/requestKinds.ts checks it with `parseRuleSource`). Pure: scripts/test-rule-suggest.mjs runs it.

import type { Rule } from "./api";

export interface RuleSource {
  accountId: string;
  /** the folder the message is in: a role or folder key (`inbox`, `archive`, `f:Projects`) */
  folder: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  /** the first 2,000 characters of the message text; null for confidential mail and for encrypted mail that is not readable */
  text: string | null;
  /** the sender is one of the person's own mailboxes */
  mine: boolean;
}

/** The parts of a message `ruleSourceOf` reads (a `MessageFull`). */
export interface MessageLike {
  accountId: string;
  folder: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  text: string | null;
  html?: string | null;
  confidential?: boolean;
  security?: { encrypted: boolean; decryption: string } | null;
}

/** The message a conversation's rule is made from: the newest one from someone who is not one of the person's mailboxes, else the newest (a conversation they started). */
export function pickRuleMessage<M extends { fromEmail: string }>(messages: readonly M[], mine: ReadonlySet<string>): M | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].fromEmail && !mine.has(messages[i].fromEmail.toLowerCase())) return messages[i];
  return messages[messages.length - 1] ?? null;
}

/** The text of a message for the suggested words: none for confidential mail or encrypted mail that has not been decrypted. */
function readableText(m: MessageLike): string | null {
  if (m.confidential) return null;
  if (m.security?.encrypted && m.security.decryption !== "ok") return null;
  const text = m.text?.trim() ? m.text : htmlText(m.html);
  return text.slice(0, 2000);
}

/** The text of an HTML-only message (tags and style / script blocks off): enough to find words in. */
function htmlText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ");
}

export function ruleSourceOf(m: MessageLike, mine: ReadonlySet<string>): RuleSource {
  return {
    accountId: m.accountId,
    folder: m.folder,
    fromName: m.fromName,
    fromEmail: m.fromEmail.trim(),
    subject: m.subject,
    text: readableText(m),
    mine: mine.has(m.fromEmail.trim().toLowerCase()),
  };
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** A source received from another window, checked field by field (or null). */
export function parseRuleSource(v: unknown): RuleSource | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const accountId = str(o.accountId, 200);
  const folder = str(o.folder, 200);
  const fromEmail = str(o.fromEmail, 320);
  const subject = str(o.subject, 1000);
  const fromName = str(o.fromName, 400);
  if (!accountId || !folder || fromEmail === null || subject === null || fromName === null) return null;
  return { accountId, folder, fromName, fromEmail, subject, text: o.text === null ? null : str(o.text, 2000), mine: o.mine === true };
}

const FIELDS = new Set(["from", "to", "subject", "body", "subjectBody", "any"]);
const ACTIONS = new Set(["archive", "trash", "junk", "read", "star", "pin", "move"]);

/** A rule received from the Settings window (Run now): checked field by field, cut to what the matcher reads (or null). */
export function parseRuleDraft(v: unknown): Rule | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.action !== "string" || !ACTIONS.has(o.action) || !Array.isArray(o.conditions) || o.conditions.length === 0 || o.conditions.length > 10) return null;
  const conditions: Rule["conditions"] = [];
  for (const c of o.conditions) {
    const k = c as Record<string, unknown> | null;
    if (!k || typeof k.field !== "string" || !FIELDS.has(k.field) || !Array.isArray(k.values) || k.values.length > 50) return null;
    const values = k.values.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500));
    if (values.length === 0) return null;
    conditions.push({ field: k.field as Rule["conditions"][number]["field"], op: k.op === "equals" ? "equals" : "contains", values });
  }
  const accountId = typeof o.accountId === "string" && o.accountId ? o.accountId.slice(0, 200) : null;
  const arg = typeof o.arg === "string" && o.arg ? o.arg.slice(0, 400) : null;
  return { id: typeof o.id === "string" ? o.id.slice(0, 100) : "draft", accountId, name: typeof o.name === "string" ? o.name.slice(0, 400) : "", conditions, action: o.action as Rule["action"], arg, enabled: o.enabled !== false };
}
