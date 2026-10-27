import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, type MessageFull } from "./api";
import { eff } from "./prefs";
import { useStore } from "./store";
import { normSender, remoteAllowed } from "./trustedRule";

export * from "./trustedRule";

/*
 * Senders whose remote content always loads (1.0.10). One global list in the app's database (remote_ok.rs); this is the page's side: a small store that every window keeps in step
 * through `remote-ok-changed`, and the helpers that read it. The rule itself is in trustedRule.ts.
 */

/** The rule for a message outside a component (the heavy-message wait, the quote of a reply): the setting of its mailbox, the list, its folder, the sender check. */
export function remoteAllowedFor(m: MessageFull, allow = false): boolean {
  const e = normSender(m.fromEmail);
  return remoteAllowed({ global: eff(useStore.getState().prefs, m.accountId, "loadRemote"), trusted: !!e && useTrusted.getState().emails.has(e), autoReason: m.autoReason, noAuto: !!e && useTrusted.getState().noAuto.has(e), folder: m.folder, encrypted: !!m.security?.encrypted, auth: m.auth, allow });
}

interface TrustedState {
  emails: Set<string>;
  /** the senders whose pictures are not shown automatically (people written to, well-known services) */
  noAuto: Set<string>;
  loaded: boolean;
}
export const useTrusted = create<TrustedState>(() => ({ emails: new Set(), noAuto: new Set(), loaded: false }));

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
    const [rows, off] = await Promise.all([api.listRemoteOk(), api.listRemoteNoauto()]);
    useTrusted.setState({ emails: new Set(rows.map((r) => r.email.toLowerCase())), noAuto: new Set(off.map((r) => r.email.toLowerCase())), loaded: true });
  } catch {
    /* the list stays as it was */
  }
}

/** The outcome of an add: "added", "already", "full" or "invalid" (never sent to the backend). */
export async function addTrusted(email: string): Promise<"added" | "already" | "full" | "invalid"> {
  const e = normSender(email);
  if (!e) return "invalid";
  const r = (await api.remoteOkAdd(e)) as "added" | "already" | "full";
  if (r !== "full") useTrusted.setState((s) => {
    const off = new Set(s.noAuto);
    off.delete(e); // "always show" takes the sender off the other list
    return { emails: new Set(s.emails).add(e), noAuto: off, loaded: s.loaded };
  });
  return r;
}

/** "Stop showing pictures" for a sender whose pictures showed by the rule of the backend (written to, a well-known service): the outcome as `addTrusted`. */
export async function addNoAuto(email: string): Promise<"added" | "already" | "full" | "invalid"> {
  const e = normSender(email);
  if (!e) return "invalid";
  const r = (await api.remoteNoautoAdd(e)) as "added" | "already" | "full";
  if (r !== "full")
    useTrusted.setState((s) => {
      const on = new Set(s.emails);
      on.delete(e);
      return { emails: on, noAuto: new Set(s.noAuto).add(e), loaded: s.loaded };
    });
  return r;
}

export async function removeNoAuto(email: string): Promise<void> {
  const e = normSender(email);
  if (!e) return;
  await api.remoteNoautoRemove(e);
  useTrusted.setState((s) => {
    const n = new Set(s.noAuto);
    n.delete(e);
    return { emails: s.emails, noAuto: n, loaded: s.loaded };
  });
}

export async function removeTrusted(email: string): Promise<void> {
  const e = normSender(email);
  if (!e) return;
  await api.remoteOkRemove(e);
  useTrusted.setState((s) => {
    const n = new Set(s.emails);
    n.delete(e);
    return { emails: n, noAuto: s.noAuto, loaded: s.loaded };
  });
}
