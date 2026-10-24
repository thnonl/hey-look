import { X } from "lucide-react";
import { chipLabel } from "../recipients";

/**
 * Recipient chips that are there only to take their room: the shell of a Reply / Reply all (components/Compose.tsx, ComposeFrame.tsx) draws the recipients the answer is expected
 * to have invisibly in the To and Cc rows, so a row that wraps (many or long addresses, a wide font) has its height from the first frame and the Subject row below does not move when
 * the finished message arrives (REQ-13.13.12, D-067). Same markup as a chip of RecipientField; nothing to read, press or focus.
 */
export function GhostChips({ values }: { values: readonly string[] | undefined }) {
  return (
    <>
      {values?.map((v) => (
        <span key={v} className="rchip" aria-hidden style={{ visibility: "hidden" }}>
          <span className="ellipsis">{chipLabel(v)}</span>
          <button type="button" tabIndex={-1}><X size={11} /></button>
        </span>
      ))}
    </>
  );
}
