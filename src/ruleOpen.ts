// Opens the Create rule dialog from a message (1.0.8): the list menu, the reading pane's More menu, a reader window's More menu and the command bar all come here. In a reader window the
// store's `setDialog` hands the dialog to the main window (popout/readerBridge.ts), so the same call works there.
import type { MessageFull } from "./api";
import { pickRuleMessage, ruleSourceOf } from "./ruleSource";
import { useStore } from "./store";

const mineOf = (): Set<string> => new Set(useStore.getState().accounts.map((a) => a.email.toLowerCase()));

/** The rule dialog for one message. */
export function openRuleFor(m: MessageFull): void {
  useStore.getState().setDialog({ type: "rule", source: ruleSourceOf(m, mineOf()) });
}

/** The rule dialog for a conversation: from its newest message that is not from one of the person's mailboxes (else its newest message). */
export function openRuleForThread(messages: readonly MessageFull[]): void {
  const m = pickRuleMessage(messages, mineOf());
  if (m) openRuleFor(m);
}
