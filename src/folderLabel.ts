// The name of a folder as it is shown (header of a list, side menu, rule list, search rows). Pure (no store, no DOM), so scripts/test-folder-label.mjs runs it.
import { t } from "./i18n/index.ts";
import type { Key } from "./i18n/index.ts";

/** Dictionary key of the name of each built-in folder (the label itself comes from t(), in the language in use). */
export const ROLE_LABELS: Record<string, Key> = {
  inbox: "settings.folder.inbox",
  drafts: "settings.folder.drafts",
  sent: "settings.folder.sent",
  archive: "settings.folder.archive",
  junk: "settings.folder.junk",
  trash: "settings.folder.trash",
  starred: "settings.folder.starred",
  pinned: "settings.folder.pinned",
  snoozed: "settings.folder.snoozed",
  scheduled: "settings.folder.scheduled",
  unread: "settings.folder.unread",
  all: "settings.folder.all",
};

export function folderLabel(key: string, name?: string): string {
  if (ROLE_LABELS[key]) return t(ROLE_LABELS[key]);
  const n = name || key.replace(/^f:/, "");
  // (only when the folder list is not at hand, see `folderLabelIn`: the server's delimiter is not known here. A dot is part of a name as often as it is a delimiter ("QA-1.0.8", "Release v1.0"),
  // so only the slash cuts; the INBOX. namespace of a dot server is dropped)
  return n.replace(/^INBOX\./i, "").split("/").pop() || n;
}

/**
 * The name of a folder as the folder list gives it: its `label`, which the backend cut at the hierarchy delimiter of that server (so a dot in "QA-1.0.8" stays). `accountId` picks the
 * mailbox when the key exists in several (the same folder name is the same label); without a list entry (folders not loaded, folder removed) the fallback of `folderLabel`.
 */
export function folderLabelIn(folders: readonly { accountId: string; key: string; name: string; label?: string }[], key: string, accountId?: string | null): string {
  if (ROLE_LABELS[key]) return t(ROLE_LABELS[key]);
  const f = folders.find((x) => x.key === key && (!accountId || x.accountId === accountId)) ?? folders.find((x) => x.key === key);
  return f ? f.label ?? folderLabel(key, f.name) : folderLabel(key);
}
