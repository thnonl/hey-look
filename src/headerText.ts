// Text that goes into a message header and comes from a received message (the Subject a reply is made from, the names and addresses of the people it is
// answered to) must not carry line breaks or other control characters. A header injection needs a CR LF; here that is not possible (the sender encodes it and
// the mail library encodes it again), but the bytes still came out the other side inside the encoded word: a reply to `O04<CR><LF>Bcc: x` was sent with a Subject
// that decodes to those two lines (v1.0.6 QA round 2, BUG-1). The backend cleans the same way when it builds the message (src-tauri/src/smtp.rs `clean_header_text`).
// Pure: scripts/test-header-text.mjs.

// built from code points, not written as a literal: U+2028 / U+2029 are line terminators in a JavaScript source and would end the literal
const BREAKS = new RegExp(`\r\n|[\r\n\t\v\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, "g");
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A line break (CR LF as one, CR, LF, NEL, line / paragraph separator), a tab, a vertical tab and a form feed become ONE space each; every other control
 * character (C0, DEL, C1) is dropped. Nothing else changes: spaces, case, the order, every other character stay as they are.
 */
export function cleanHeaderText(s: string): string {
  return s.replace(BREAKS, " ").replace(CONTROLS, "");
}
