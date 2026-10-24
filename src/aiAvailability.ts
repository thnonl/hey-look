// Whether the AI Assistant may look at a conversation (1.0.7 W8.3). Confidential mail is never sent to it, so Summarize and Translate are greyed out, with the reason, where nothing of the
// conversation could be sent; a conversation with some confidential messages is summarised without them and the card says so. Pure, so scripts/test-ai-confidential.mjs runs it.

/**
 * - `off-confidential`: every message of the conversation is confidential: Summarize is off (title `reading.ai.noConfidential`).
 * - `on-partial`: some are: Summarize is on, the confidential ones are left out and the card says so (`reading.head.summaryNoConf`).
 * - `on`: none is (also an empty list). A conversation whose only readable messages are still locked is `on`: the click then says "unlock it first" (`reading.ai.unlockEncrypted`).
 */
export type AiAvailability = "off-confidential" | "on-partial" | "on";

export function aiAvailability(messages: readonly { confidential?: boolean | null }[]): AiAvailability {
  const conf = messages.filter((m) => !!m.confidential).length;
  if (conf === 0) return "on";
  return conf === messages.length ? "off-confidential" : "on-partial";
}
