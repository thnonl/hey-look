// Moving an event to another calendar (W7.5, D-7.5a): which calendars an event can go to, and when guests stop the move. The backend decides again (calsync/write.rs `move_event`); these rules only decide what is offered.
import type { CalEvent, CalendarInfo } from "./api";

const LOCAL = "local";

/**
 * The calendars an event can be moved to. An event of a synced calendar goes to another writable synced calendar of the same mailbox; an event of My events to any writable synced calendar. An invitation, an
 * event of a read-only calendar and an event only its organizer may change are not moved.
 */
export function moveTargets(ev: Pick<CalEvent, "calendarId" | "readOnly">, cals: CalendarInfo[]): CalendarInfo[] {
  if (ev.readOnly) return [];
  const writable = cals.filter((c) => c.remote && c.writable && !c.foldedInto && c.id !== ev.calendarId);
  if (ev.calendarId === LOCAL) return writable;
  const from = cals.find((c) => c.id === ev.calendarId);
  return from?.remote && from.writable ? writable.filter((c) => c.accountId === from.accountId) : [];
}

/** How many people other than the user an event has (the chair entry of an event the user organizes is not one). */
export const guestCount = (ev: Pick<CalEvent, "attendees">) => ev.attendees.filter((a) => a.role !== "chair").length;

/**
 * The name of the service that cannot move this event because it has guests (Outlook has no move and would send the invitations again; a CalDAV server that sends them would too; an event of My events with
 * guests is not made in a service from here), or null when the move is possible.
 */
export function guestsBlock(ev: Pick<CalEvent, "calendarId" | "attendees">, cals: CalendarInfo[], targets: CalendarInfo[]): string | null {
  if (guestCount(ev) === 0) return null;
  if (ev.calendarId === LOCAL) return targets[0]?.service ?? "";
  const from = cals.find((c) => c.id === ev.calendarId);
  return from && from.movesGuests === false ? from.service ?? "" : null;
}
