import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, type MessageFull } from "./api";
import { eff } from "./prefs";
import { useStore } from "./store";

/*
 * Senders whose remote content always loads (1.0.10). One global list in the app's database (remote_ok.rs); this is the page's side: the normal form of an address, the rule that
 * decides whether a message loads its content, the states of the notice above the message, and a small store that every window keeps in step through `remote-ok-changed`.
 */

/** The list holds at most this many addresses (the same number as in remote_ok.rs). */
export const MAX_TRUSTED = 1000;

/** The stored form of an address (Unicode normal form C, lower case, trimmed), or null when it is not one the list takes: one `@` with something on both sides, at most 320 characters. */
export function normSender(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().normalize("NFC").toLowerCase();
  if (!e || [...e].length > 320 || /[\s\u0000-\u001f\u007f]/.test(e)) return null;
  const parts = e.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return e;
}

export interface RemoteInput {
  /** the setting "Always load remote content" in force for the message's mailbox */
  global: boolean;
  /** the exact From address is on the list */
  trusted: boolean;
  folder: string;
  encrypted: boolean;
  /** the server's sender check: "pass", "fail", or nothing (not checked) */
  auth: "pass" | "fail" | null | undefined;
  /** "Load content" was pressed for this message */
  allow: boolean;
}

/** The list loads a message's content by itself: the sender is on it, and the message is not in Junk, not encrypted and did not fail the sender check. */
export const autoOk = (i: Pick<RemoteInput, "trusted" | "folder" | "encrypted" | "auth">): boolean =>
  i.trusted && i.folder !== "junk" && !i.encrypted && i.auth !== "fail";

/** The one rule for the reading pane, the pop-out reader, printing and the quote of a reply. */
export const remoteAllowed = (i: RemoteInput): boolean => i.global || autoOk(i) || i.allow;

/** The rule for a message outside a component (the heavy-message wait, the quote of a reply): the setting of its mailbox, the list, its folder, the sender check. */
export function remoteAllowedFor(m: MessageFull, allow = false): boolean {
  const e = normSender(m.fromEmail);
  return remoteAllowed({ global: eff(useStore.getState().prefs, m.accountId, "loadRemote"), trusted: !!e && useTrusted.getState().emails.has(e), folder: m.folder, encrypted: !!m.security?.encrypted, auth: m.auth, allow });
}

/** May the notice offer to add this sender: a valid address that is not one of the person's own, and the message is one the list would load (not Junk, not encrypted, not failed). */
export function canOffer(fromEmail: string | null | undefined, ownEmails: readonly string[], m: Pick<RemoteInput, "folder" | "encrypted" | "auth">): boolean {
  const e = normSender(fromEmail);
  if (!e) return false;
  if (m.folder === "junk" || m.encrypted || m.auth === "fail") return false;
  return !ownEmails.some((o) => normSender(o) === e);
}

/** What the notice above a message shows (spec §5): none; the blocked notice with the offer (S1), without it (S2), for a trusted sender that is held back (S5, S6); the info line (S4). */
export type NoticeState = "none" | "offer" | "plain" | "held" | "heldFailed" | "auto";

export function noticeState(i: RemoteInput, hasRemote: boolean, offer: boolean): NoticeState {
  if (i.global || !hasRemote) return "none";
  if (autoOk(i)) return "auto";
  if (remoteAllowed(i)) return "none"; // "Load content" for this message (S3)
  if (i.trusted) return i.auth === "fail" ? "heldFailed" : "held";
  return offer ? "offer" : "plain";
}

interface TrustedState {
  emails: Set<string>;
  loaded: boolean;
}
export const useTrusted = create<TrustedState>(() => ({ emails: new Set(), loaded: false }));

let started = false;
/** Reads the list and keeps it current: every window that shows a message or the list calls this once. */
export function ensureTrustedLoaded(): void {
  if (started) return;
  started = true;
  void reloadTrusted();
  void listen("remote-ok-changed", () => void reloadTrusted());
}

export async function reloadTrusted(): Promise<void> {
  try {
    const rows = await api.listRemoteOk();
    useTrusted.setState({ emails: new Set(rows.map((r) => r.email.toLowerCase())), loaded: true });
  } catch {
    /* the list stays as it was */
  }
}

/** The outcome of an add: "added", "already", "full" or "invalid" (never sent to the backend). */
export async function addTrusted(email: string): Promise<"added" | "already" | "full" | "invalid"> {
  const e = normSender(email);
  if (!e) return "invalid";
  const r = (await api.remoteOkAdd(e)) as "added" | "already" | "full";
  if (r !== "full") useTrusted.setState((s) => ({ emails: new Set(s.emails).add(e), loaded: s.loaded }));
  return r;
}

export async function removeTrusted(email: string): Promise<void> {
  const e = normSender(email);
  if (!e) return;
  await api.remoteOkRemove(e);
  useTrusted.setState((s) => {
    const n = new Set(s.emails);
    n.delete(e);
    return { emails: n, loaded: s.loaded };
  });
}
