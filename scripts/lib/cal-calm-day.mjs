// A calm day for the month view of the dev preview (src/devMock.ts, `__mockMoveEvent`).
//
// The month cell shows 3 chips (2 and "+N more" when it has more events), and the sample series of the preview (Standup every weekday, Weekly planning on Monday and
// Wednesday, Product sync on Wednesday) plus the sample events around today fill the cells of the next days: whether "Design review" (tomorrow) or "Lunch with Alice" is
// a chip, or "Q4 contract call" (today) next to the events a test adds, depends on the weekday of the run (Sunday to Thursday failed, Friday and Saturday passed).
// A test that needs sample events as month chips puts them on the first Saturday 11 or more days ahead: no series reaches a Saturday and the sample events end 9 days
// ahead, so the cell holds only what the test moved there, whatever day it runs on. The day is a local calendar day, like the mock's own `at()`.
//
//   const CALM = await calmDay(evaluate, [['e3', 15, 0], ['e2', 10, 30], ['e4', 12, 0]]);   // offset in days from today; openDay(CALM, 'month') shows them
//
// Run on another weekday with HEYLOOK_FAKE_NOW=2026-10-21T09:00:00 (scripts/cdp-harness.mjs moves the clock of the page).

/** Moves the mock events `[id, hour, minute]` to the calm day and resolves to its offset in days from today. */
export const calmDay = (evaluate, moves) => evaluate(`(() => {
  const t = new Date();
  let n = 11;
  while (new Date(t.getFullYear(), t.getMonth(), t.getDate() + n).getDay() !== 6) n++;
  for (const [id, h, m] of ${JSON.stringify(moves)}) window.__mockMoveEvent(id, Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n, h, m).getTime() / 1000));
  return n;
})()`);
