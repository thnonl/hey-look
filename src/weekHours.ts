// The hour height of the calendar's Week view (W1.13 c, 1.0.7). The grid used to be 48 px per hour whatever the window: at 1280 x 800 a 19:00 event was below the fold. Now the hours
// 08:00 to 20:00 (12 of them) fit the visible grid when the window allows, between 32 and 48 px per hour. Pure, so scripts/test-week-hours.mjs runs it as it is.

/** The least and the most height of an hour (px): below 32 the text of a half-hour event cannot be read, above 48 there is no gain. */
export const HOUR_PX_MIN = 32;
export const HOUR_PX_MAX = 48;
/** How many hours of the working day (08:00 to 20:00) the grid shows when it can. */
export const WORKDAY_HOURS = 12;

/** The height of an hour for a grid whose visible part is `gridHeight` px high: the working day fits, within the limits. */
export function hourHeight(gridHeight: number): number {
  if (!Number.isFinite(gridHeight)) return HOUR_PX_MAX;
  return Math.min(HOUR_PX_MAX, Math.max(HOUR_PX_MIN, Math.floor(gridHeight / WORKDAY_HOURS)));
}

/** The time a click at `y` px below the top of a day column is on, in minutes after midnight, to the nearest half hour (23:30 at the latest). */
export function minuteFromY(y: number, hourPx: number): number {
  return Math.max(0, Math.min(23 * 60 + 30, Math.round((y / hourPx) * 2) * 30));
}
