// What a message starts with, made from its `ComposeInit`: the recipients and the rows that show them, the attachments, the Encrypt / Sign start values. ONE place for the
// two ways a Compose gets its content (1.0.7 WP13f-3, DEC-023, REQ-13.13.11): a fresh mount (the `useState` start values of components/Compose.tsx) and the in-place fill of
// a Reply / Forward shell (the same fields, set when the finished message replaces the shell). Pure (types only are imported), so scripts/test-compose-start.mjs runs it in plain Node.
import type { Att } from "./api.ts";
import type { ComposeInit } from "./store.ts";
import { outgoingNames } from "./attachName.ts";
import { cleanHeaderText } from "./headerText.ts";

/** A new message or a forward (not a reply, an opened draft, a scheduled message or a restored one): it starts with the account's Auto Cc / Bcc. */
export const isFreshMessage = (init: Pick<ComposeInit, "replaces" | "isReply" | "outboxId" | "restore">): boolean => !init.replaces && !init.isReply && !init.outboxId && !init.restore;

/**
 * To, Cc and Bcc as Compose opens them (from a received message, a draft or a link: never a line break in a header), and whether the Cc and Bcc rows are shown. The rows are shown when
 * either has someone, and also when the shell of a Reply all says that Cc recipients are expected (`preparing.cc`, REQ-13.13.12: the row is in the shell, nothing appears at the fill).
 * `auto`: the Auto Cc / Bcc of the From account (used for a fresh message only).
 */
export function startRecipients(init: ComposeInit, auto: { cc: string; bcc: string }): { to: string[]; cc: string[]; bcc: string[]; showCc: boolean } {
  const fresh = isFreshMessage(init);
  const autoCc = fresh ? auto.cc.trim() : "";
  const autoBcc = fresh ? auto.bcc.trim() : "";
  const to = (init.to ?? []).map(cleanHeaderText);
  const cc = [...(init.cc ?? []).map(cleanHeaderText), ...(autoCc ? [autoCc] : [])];
  const bcc = [...(init.bcc ?? []).map(cleanHeaderText), ...(autoBcc ? [autoBcc] : [])];
  return { to, cc, bcc, showCc: cc.length > 0 || bcc.length > 0 || !!init.preparing?.cc };
}

/** The attachments of an opened draft / forward are shown (and sent) under a clean name: no folder, no hidden characters (O-05). */
export function startAttachments(init: Pick<ComposeInit, "attachments">): Att[] {
  const names = outgoingNames((init.attachments ?? []).map((a) => a.filename));
  return (init.attachments ?? []).map((a, i) => ({ ...a, filename: names[i] }));
}

/**
 * Encrypt, Sign and "attach my public key" at the start: as the reopened message had them (`restore`), as its security says (an answer to encrypted mail is encrypted), else
 * from the account's settings (`pgp.encrypt`: always | possible | never).
 */
export function startSecurity(init: Pick<ComposeInit, "restore" | "security">, pgp: { encrypt: string; sign: boolean; attachKey: boolean }): { encIntent: "on" | "off" | "auto"; sign: boolean; attachKey: boolean } {
  return {
    encIntent: init.restore ? init.restore.encrypt : init.security ? (init.security.encrypt ? "on" : "off") : pgp.encrypt === "always" ? "on" : pgp.encrypt === "possible" ? "auto" : "off",
    sign: init.restore ? init.restore.sign : init.security ? init.security.sign : pgp.sign,
    attachKey: init.restore ? init.restore.attachKey : init.security ? init.security.attachPublicKey : pgp.attachKey,
  };
}
