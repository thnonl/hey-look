// Repeating events (W7.1): the questions and rules the calendar shares for changing or deleting one occurrence, this and the following ones, or the whole series.
// Pure functions without Tauri or React, so scripts/test-calendar-series.mjs can check them; the sentences live in the dictionary (i18n/ns/calendar.ts).
import type { CalEvent, SeriesScope } from "./api";
import { t } from "./i18n/index.ts"; // (explicit path: scripts/test-calendar-series.mjs loads this file with node)
import type { Key } from "./i18n/index.ts";

/** What the person chose in the question before an event of a series opens or is deleted. */
export type ScopeAnswer = SeriesScope | "cancel";

export interface ScopeAsk {
  title: string;
  body: string;
  choices: { id: ScopeAnswer; label: string; kind?: "primary" }[];
  /** Esc and a click outside */
  dismiss: ScopeAnswer;
}

/**
 * The one question before an event of a series is opened or deleted (REQ-7.1.1): This occurrence (primary, the first button, so it has the focus), This and following
 * (left out for the first occurrence of the series: that is the whole series), The whole series, Cancel. `after` is the sentence a synced calendar's delete adds to the body
 * (the service tells the guests).
 */
export function scopeAsk(mode: "open" | "delete", ev: Pick<CalEvent, "summary" | "firstOccurrence">, after?: string | null): ScopeAsk {
  const body = t(mode === "open" ? "calendar.series.openBody" : "calendar.series.deleteBody", { summary: ev.summary });
  return {
    title: t(mode === "open" ? "calendar.series.openTitle" : "calendar.series.deleteTitle"),
    body: after ? `${body} ${after}` : body,
    choices: [
      { id: "occurrence", label: t("calendar.series.this"), kind: "primary" },
      ...(ev.firstOccurrence ? [] : [{ id: "following" as const, label: t("calendar.series.following") }]),
      { id: "series", label: t("calendar.series.all") },
      { id: "cancel", label: t("common.cancel") },
    ],
    dismiss: "cancel",
  };
}

/** The title of the event form for a part of a series. */
export function dialogTitleKey(scope: SeriesScope | undefined, hasEvent: boolean): Key {
  switch (scope) {
    case "occurrence":
      return "calendar.dialog.editOccurrence";
    case "following":
      return "calendar.dialog.editFollowing";
    case "series":
      return "calendar.dialog.editSeries";
    default:
      return hasEvent ? "calendar.dialog.editTitle" : "calendar.newEvent";
  }
}

/** The muted line under the title: which occurrence the changes are for. The whole series says what it always said (the repeat note by the Repeat choice). */
export function scopeNote(scope: SeriesScope | undefined, date: string): string | null {
  if (scope === "occurrence") return t("calendar.dialog.occurrenceNote", { date });
  if (scope === "following") return t("calendar.dialog.followingNote", { date });
  return null;
}

/**
 * Whether saving must first ask "Change every occurrence?" (REQ-7.1.3): for the whole series and "this and following", when the time or the rule changed and some
 * occurrences were changed one by one; for a synced calendar always (the service applies its own rule to what it has).
 */
export function needsResetQuestion(o: { scope: SeriesScope | undefined; synced: boolean; changedCount: number; timeChanged: boolean; ruleChanged: boolean }): boolean {
  if (o.scope !== "series" && o.scope !== "following") return false;
  if (!o.timeChanged && !o.ruleChanged) return false;
  return o.synced || o.changedCount > 0;
}

/** The toast after a save. */
export function savedToastKey(scope: SeriesScope | undefined, isNew: boolean): Key {
  if (scope === "occurrence") return "calendar.toast.occurrenceSaved";
  if (scope === "following" || scope === "series") return "calendar.toast.seriesSaved";
  return isNew ? "calendar.toast.eventAdded" : "calendar.toast.eventSaved";
}

/** The toast after a delete (the plain ones are the callers'; this is the answer for a part of a series). */
export function deletedToast(scope: SeriesScope | undefined, date: string): string | null {
  if (scope === "occurrence") return t("calendar.toast.occurrenceDeleted");
  if (scope === "following") return t("calendar.toast.followingDeleted", { date });
  return null;
}

/** The slot an event stands for, to hand to the backend: undefined for an event that is not part of a series. */
export function slotOf(ev: Pick<CalEvent, "series" | "occurrenceStart">): number | undefined {
  return ev.series && ev.occurrenceStart != null ? ev.occurrenceStart : undefined;
}

