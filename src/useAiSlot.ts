// A button that runs one AI Assistant call (Summarize, Write with AI): the running state with its start time, Cancel, and leaving
// (the component goes away) drops the request. See src/aiCall.ts for the rules.
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { createAiSlot, type AiOutcome } from "./aiCall";

export function useAiSlot(kind: string) {
  const slot = useMemo(() => createAiSlot({ complete: api.aiComplete, cancel: (id) => void api.aiCancel(id).catch(() => {}) }, kind), [kind]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => () => void slot.cancel(), [slot]);
  return {
    running: startedAt !== null,
    startedAt,
    /** The outcome, or `null` when a call was under way already or this one was cancelled: then there is nothing to show. */
    async run(system: string, prompt: string): Promise<AiOutcome> {
      const started = slot.start(system, prompt);
      if (!started) return null;
      setStartedAt(Date.now());
      const out = await started;
      if (out) setStartedAt(null);
      return out;
    },
    cancel() {
      if (slot.cancel()) setStartedAt(null);
    },
  };
}
