// A diagnostic for the reader window (1.0.12, Windows QA round 9: the body of an open reader was empty for 1-3 s, without the "Opening message…" cover, three times in 30 samples). It only LOGS,
// through `popout_note` "info" (the line lands in startup.log of the data folder as `<time> popout: reader-N: page says info: diag …`); it changes nothing the person sees. Ids and states
// only - no subject, address or text. At most 60 lines a minute (the lines about a blank body are always written). Off outside the reader window (the reading pane of the main page shares the code that calls it).
import { api } from "../api";

const T0 = typeof performance === "undefined" ? 0 : performance.now();
const stamps: number[] = [];
let on = false;
/** What happened last (ms on the page clock): a refresh and why, a document rewrite, a card mount. */
export const diagState = { why: "-", refreshAt: 0, rewriteAt: 0, mountAt: 0 };
export const diagOn = (v: boolean) => { on = v; };
export const nowMs = () => Math.round(performance.now() - T0);
export const ago = (at: number) => (at ? `${nowMs() - at}ms` : "never");

/** One line: `diag t=<ms since the page started> <text>`, rate limited. */
export function diag(text: string, always = false): void {
  if (!on) return;
  const now = Date.now();
  while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
  if (stamps.length >= 60 && !always) return;
  stamps.push(now);
  void api.popoutNote("info", `diag t=${nowMs()} ${text}`).catch(() => undefined);
}
