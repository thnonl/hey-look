// Message importance (F-24): High / Low / Normal, chosen per message in Compose (like Outlook's two toggle buttons) and read from
// received mail. Normal is the default for every new message, reply and forward; nothing is remembered between messages.

export type Importance = "normal" | "high" | "low";

/** What a Compose starts with: a reopened draft / scheduled message brings its own, anything else is Normal. */
export function initialImportance(init: { importance?: Importance | null }): Importance {
  return init.importance === "high" || init.importance === "low" ? init.importance : "normal";
}

/** The two toggle buttons: pressing the one that is on goes back to Normal, pressing the other one switches over. */
export function pressImportance(current: Importance, pressed: "high" | "low"): Importance {
  return current === pressed ? "normal" : pressed;
}

/** The value sent to the backend: Normal is left out so that no importance header is written. */
export function draftImportance(i: Importance): "high" | "low" | undefined {
  return i === "normal" ? undefined : i;
}

/** The mark shown for a message or conversation (list row, reading pane): nothing for Normal / unknown. */
export function shownImportance(i: Importance | null | undefined): "high" | "low" | null {
  return i === "high" || i === "low" ? i : null;
}
