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
