// The hour height of the Week view and the click-to-create time that follows it (W1.13 c, 1.0.7): src/weekHours.ts, and the wiring in Calendar.tsx / App.css.
// Run: node --experimental-strip-types scripts/test-week-hours.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOUR_PX_MAX, HOUR_PX_MIN, WORKDAY_HOURS, hourHeight, minuteFromY } from "../src/weekHours.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.equal(HOUR_PX_MIN, 32);
assert.equal(HOUR_PX_MAX, 48);
assert.equal(WORKDAY_HOURS, 12);

// 1. hourHeight = clamp(floor(visible grid height / 12), 32, 48)
assert.equal(hourHeight(560), 46, "1280 x 800: 560 px of grid -> 46");
assert.equal(hourHeight(300), 32, "a low window: never below 32");
assert.equal(hourHeight(900), 48, "a tall window: never above 48");
assert.equal(hourHeight(576), 48);
assert.equal(hourHeight(575), 47);
assert.equal(hourHeight(384), 32);
assert.equal(hourHeight(383), 32);
assert.equal(hourHeight(0), 32);
assert.equal(hourHeight(Number.NaN), 48, "not measured yet: the old height");
// 08:00 to 20:00 fits whenever the window is tall enough for the minimum
for (let h = 384; h <= 700; h++) assert.ok(WORKDAY_HOURS * hourHeight(h) <= h, `${h}: twelve hours of ${hourHeight(h)} px do not fit`);
// never below 32, never above 48, whole pixels, one pixel at a time
for (let h = 0; h <= 1200; h++) {
  const px = hourHeight(h);
  assert.ok(px >= 32 && px <= 48 && Number.isInteger(px));
  if (h > 0) assert.ok(px >= hourHeight(h - 1) && px - hourHeight(h - 1) <= 1);
}

// 2. the minute under a click, with the new height (the old math at 48 gives the old answers)
assert.equal(minuteFromY(0, 48), 0);
assert.equal(minuteFromY(15.5 * 48, 48), 15 * 60 + 30, "15:30 at 48 px");
assert.equal(minuteFromY(15.5 * 46, 46), 15 * 60 + 30, "15:30 at 46 px (AC-1.13.5)");
assert.equal(minuteFromY(15.5 * 32, 32), 15 * 60 + 30, "15:30 at 32 px");
assert.equal(minuteFromY(15.5 * 46 + 5, 46), 15 * 60 + 30, "a few pixels off: the nearest half hour");
assert.equal(minuteFromY(15 * 46 + 4, 46), 15 * 60, "4 px past 15:00 is 15:00");
assert.equal(minuteFromY(-20, 46), 0, "above the grid: 00:00");
assert.equal(minuteFromY(24 * 46, 46), 23 * 60 + 30, "at the bottom: 23:30 at the latest");
assert.equal(minuteFromY(19 * 46, 46), 19 * 60);
for (const px of [32, 40, 46, 48]) for (let m = 0; m < 24 * 60; m += 30) assert.equal(minuteFromY((m / 60) * px, px), m, `${m} min at ${px} px`);

// 3. the wiring: every place that used the fixed height uses the computed one (state hourPx, CSS variable --hour-px)
const cal = read("src/components/Calendar.tsx");
assert.ok(!/HOUR_PX\b/.test(cal), "no fixed HOUR_PX left in Calendar.tsx");
assert.match(cal, /hourHeight\(el\.clientHeight\)/, "measured from the visible part of the grid");
assert.match(cal, /new ResizeObserver\(fit\)/, "recomputed when the window is resized");
assert.match(cal, /minuteFromY\(e\.clientY - r\.top, hourPx\)/, "click to create");
assert.match(cal, /\* hourPx;/, "event top and height");
assert.match(cal, /\* hourPx \}\}/, "the now line");
assert.match(cal, /"--hour-px": `\$\{hourPx\}px`/, "the CSS variable");
assert.match(cal, /h \* hourPxRef\.current/, "the scroll to 08:00 (the rule is unchanged) uses the height in force");
const css = read("src/App.css");
assert.match(css, /\.wk-hour \{ height: var\(--hour-px, 48px\);/, "the hour labels");
assert.match(css, /\.wk-col \{[^}]*calc\(var\(--hour-px, 48px\) - 1px\)/, "the hour lines");
console.log("ok - test-week-hours");
