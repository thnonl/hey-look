// Which text names the problem with a recipient's key (compose security strip, recipient chip popover). Kept free of React and of the dictionaries
// themselves so scripts/test-key-status.mjs can run it. `signOnly` (1.0.7): the stored key can check signatures but has no key to encrypt with.
import type { Key } from "./i18n";

export type KeyProblem = "missing" | "expired" | "revoked" | "signOnly";

/** Where the text is shown: the security strip under the header, the title of the chip popover, its help line. */
export type KeyText = "strip" | "chipTitle" | "chipHelp";

const KEYS: Record<KeyProblem, Record<KeyText, Key>> = {
  missing: { strip: "compose.sec.noKey", chipTitle: "compose.rcpt.keyMissing", chipHelp: "compose.rcpt.missingHelp" },
  expired: { strip: "compose.sec.theirExpired", chipTitle: "compose.rcpt.keyExpired", chipHelp: "compose.rcpt.unusableHelp" },
  revoked: { strip: "compose.sec.theirRevoked", chipTitle: "compose.rcpt.keyRevoked", chipHelp: "compose.rcpt.unusableHelp" },
  signOnly: { strip: "compose.sec.theirSignOnly", chipTitle: "compose.rcpt.keySignOnly", chipHelp: "compose.rcpt.signOnlyHelp" },
};

/** The dictionary key for a recipient whose key status is `status` ("ok" and anything unknown read as a missing key, like every other status did). */
export function keyProblemKey(status: string | undefined, where: KeyText): Key {
  return KEYS[(status as KeyProblem) in KEYS ? (status as KeyProblem) : "missing"][where];
}
