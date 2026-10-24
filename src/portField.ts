// The port boxes of Settings > Add account (IMAP and SMTP). They are text boxes with a numeric keypad hint, not <input type="number">: a number box changes its value by one on
// ArrowUp / ArrowDown and on the mouse wheel over the focused box (a typed SMTP port 31501 was reported saved as 31502, D-006), shows "0" when it is emptied and takes "e", "-" and ".".
// Pure, so a plain Node script tests it (scripts/test-port-field.mjs).

/** The highest TCP port. */
export const MAX_PORT = 65535;

/** What the box shows for a port: nothing for 0 ("no port yet"; the placeholder shows the usual one). */
export const portText = (port: number): string => (port > 0 ? String(port) : "");

/**
 * The port for the text in the box. Digits only (a paste of " 587 " or "smtp:465" gives 587 / 465), no leading zeros, empty = 0; a number above 65535 is refused: the
 * previous port stays, so the backend never gets a number it cannot take.
 */
export function portFromText(text: string, previous: number): number {
  const digits = text.replace(/\D/g, "");
  if (digits === "") return 0;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n <= MAX_PORT ? n : previous;
}
