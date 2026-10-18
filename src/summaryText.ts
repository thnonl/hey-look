// What Summarize sends to the AI Assistant: every message cut to its first 4,000 characters, the whole text to 24,000. It says whether anything was cut,
// so the summary can tell the person (v1.0.6 QA round 3, observation O-1: Translate said "Only the first 60,000 characters were translated", Summarize said nothing).
// Pure (scripts/test-summary-text.mjs).

export const SUMMARY_PER_MESSAGE = 4000;
export const SUMMARY_TOTAL = 24000;

/** `items`: the readable messages in order, `head` = their From / Date lines, `text` = the plain text. */
export function summaryBody(items: { head: string; text: string }[]): { body: string; cut: boolean } {
  const joined = items.map((m) => `${m.head}\n\n${m.text.slice(0, SUMMARY_PER_MESSAGE)}`).join("\n\n-----\n\n");
  return { body: joined.slice(0, SUMMARY_TOTAL), cut: items.some((m) => m.text.length > SUMMARY_PER_MESSAGE) || joined.length > SUMMARY_TOTAL };
}
