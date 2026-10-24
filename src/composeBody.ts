// The first content of the editor of a new message, a reply or a forward (everything but an opened draft, which has its own stored body): an empty line to type in, the signature
// region, then the quoted original as a protected block. Made once for BOTH ways a Compose gets its content (1.0.7 WP13f-3, DEC-023, REQ-13.13.11): the editor that is mounted fresh
// (`content` of components/Compose.tsx) and the editor of a Reply / Forward shell that is filled in place. A remote picture never comes into the editor (the reader's "Load pictures"
// is the only place they load). Pure apart from the two helpers it calls, which have no DOM either, so scripts/test-compose-start.mjs runs it.
import { extractQuote } from "./editor/quoteBlock.ts";
import { stripRemotePictures } from "./pastedHtml.ts";
import { SIG_MARK } from "./signature.ts";

/** The HTML the editor starts from: `bodyHtml` of the `ComposeInit` (the quote block of an answer, or nothing for a new message). */
export function answerBodyHtml(bodyHtml: string | undefined): string {
  return stripRemotePictures(`<p></p>${SIG_MARK}${extractQuote(bodyHtml ?? "<p></p>").html}`).html;
}
