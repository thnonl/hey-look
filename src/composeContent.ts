// What counts as something the person wrote in a message being composed. One rule for everything that has to ask or keep: the Discard button
// (a message with nothing written closes without "Discard this message?", like an empty new one), leaving the message for another mail, closing a
// compose window, the draft autosave and the crash snapshot (src/components/Compose.tsx `probe`; tests: scripts/test-compose-content.mjs).
//
// A reply or forward opens with things Compose put there: the recipients, the subject, the quoted message (a protected block) and the signature.
// They are the BASELINE. Only a difference from it is "written": a letter typed in the body or subject, an address added to or taken from the
// recipients, a picture or an attachment added by the person. The signature region is not part of the text compared, and the quote is the same
// text at the start and now, so neither counts until the person changes it.

/** The parts of a message that the person can change, as numbers and text that can be compared. */
export interface ComposeParts {
  /** the text of the body (the quote included; not the signature region), trimmed */
  text: string;
  /** pictures in the body (not the quote's) */
  pics: number;
  to: string[];
  cc: number;
  bcc: number;
  subject: string;
  /** attachments */
  atts: number;
}

/**
 * Is there anything in `now` that the person wrote, compared with the message as it was opened (`opened`)?
 * `touched`: the person did something in the message since it opened (a message nobody touched is never content). A restored message (crash
 * snapshot) or one carried over from another window has an empty `opened`: all of it is the person's writing.
 */
export function composeHasContent(touched: boolean, now: ComposeParts, opened: ComposeParts): boolean {
  if (!touched) return false;
  return (
    now.text !== opened.text ||
    now.pics !== opened.pics ||
    now.to.length !== opened.to.length || now.to.some((x, i) => x !== opened.to[i]) ||
    now.cc > opened.cc || now.bcc > opened.bcc ||
    now.subject.trim() !== opened.subject.trim() ||
    now.atts !== opened.atts
  );
}

/** The part of a ProseMirror transaction `touched` is decided from. */
export interface EditTransaction {
  docChanged: boolean;
  getMeta(key: string): unknown;
}

/**
 * Does an `onUpdate` of the editor mean that the person edited? Not the editor tidying itself: Compose's own signature set-up (`signatureInit`),
 * and the guards of the quote and the signature adding an empty paragraph after a plain focus or selection move (the root transaction changed
 * nothing, only the transaction a guard appended did: a reply opened with `touched` already set, and asked "Discard this message?" at once).
 */
export function isPersonEdit(tr: EditTransaction): boolean {
  return tr.docChanged && !tr.getMeta("signatureInit");
}

/** The parts of a message beyond `ComposeParts` that the draft rule needs. */
export interface DraftExtra {
  /** the place typed into the meeting strip now (empty: no meeting, or none typed) */
  meetingWhere: string;
  /** the place the meeting had when the message opened (a restored or carried message: empty, all of it is the person's) */
  openedWhere: string;
  /** the message is a draft that is already in Drafts (opened from there): see below */
  existing: boolean;
}

/**
 * Is there anything in `now` that is worth a draft on the server (W13.5)? Narrower than `composeHasContent`, which decides what the local crash
 * snapshot keeps: a draft is only written when the message holds
 *  - body text of the person's (not whitespace, not the signature region, not an untouched quote), or
 *  - a subject of the person's (not the one Compose filled in for a reply / forward), or
 *  - a picture in the body or an attachment that the person added (the ones a forward carries are in `opened`), or
 *  - a meeting with a place typed.
 * Recipients, From, Importance, the Encrypt / Sign / Confidential switches and the signature choice are not content: a message with only those is
 * closed without a question and nothing of it reaches the server.
 * A draft that is already in Drafts (`extra.existing`) also counts a change of its recipients, pictures or attachments, so an edit to it is not
 * thrown away silently, as long as it has a subject, text, a picture or an attachment (else the server copy is empty anyway and `save_draft` refuses it).
 */
export function draftContent(touched: boolean, now: ComposeParts, opened: ComposeParts, extra: DraftExtra): boolean {
  if (!touched) return false;
  const subject = now.subject.trim();
  if (subject && subject !== opened.subject.trim()) return true;
  if (now.text && now.text !== opened.text) return true;
  if (now.pics > opened.pics || now.atts > opened.atts) return true;
  const where = extra.meetingWhere.trim();
  if (where && where !== extra.openedWhere.trim()) return true;
  const substance = !!subject || !!now.text || now.pics > 0 || now.atts > 0;
  return extra.existing && substance && composeHasContent(touched, now, opened);
}
