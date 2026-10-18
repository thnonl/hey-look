// The date and time fields of the event dialog, the meeting strip, Send later and the search filters (components/DateTimeFields.tsx):
// how a value is written in every language and in the 12 / 24-hour clock, how typed text is read back, the arithmetic of the arrow keys,
// and that no native <input type="date"> / type="time" is left in src/ (they ignore the app language, see CONTRIBUTING.md).
// Run: node --experimental-strip-types scripts/test-datetime-fields.mjs
// The time zone is set before any date is made: the arithmetic must not move with a clock change.
process.env.TZ = "Europe/Berlin";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const { setLangPref, LANGUAGES } = await import("../src/i18n/index.ts");
const f = await import("../src/dateTimeFields.ts");

const LANGS = LANGUAGES.map((l) => l.code);
assert.equal(LANGS.length, 8);

// ---- how a date is written: the app's own "d MMM yyyy" of the language (not the OS / browser format: 10/16/2026)
const DATE = {
  en: "16 Oct 2026", vi: "16 thg 10 2026", fr: "16 oct. 2026", "zh-Hans": "2026年10月16日", es: "16 oct 2026", ja: "2026年10月16日", de: "16. Okt. 2026", ru: "16 окт. 2026",
};
// ---- 12-hour clock: the language's am / pm words after the time, like the calendar's own clock
const PM = { en: "3:05 PM", vi: "3:05 CH", fr: "3:05 PM", "zh-Hans": "3:05 下午", es: "3:05 p. m.", ja: "3:05 午後", de: "3:05 PM", ru: "3:05 PM" };
const AM = { en: "9:05 AM", vi: "9:05 SA", fr: "9:05 AM", "zh-Hans": "9:05 上午", es: "9:05 a. m.", ja: "9:05 午前", de: "9:05 AM", ru: "9:05 AM" };
for (const l of LANGS) {
  setLangPref(l);
  assert.equal(f.formatDate("2026-10-16"), DATE[l], `${l}: date`);
  assert.ok(!/10\/16\/2026|16\/10\/2026/.test(f.formatDate("2026-10-16")), `${l}: not a numeric OS-style date`);
  assert.equal(f.formatDate(""), "");
  assert.equal(f.formatDate("2026-02-31"), "", "a date that does not exist is not shown");
  assert.equal(f.formatTime("15:05", true), PM[l], `${l}: 12 h pm`);
  assert.equal(f.formatTime("09:05", true), AM[l], `${l}: 12 h am`);
  assert.equal(f.formatTime("15:05", false), "15:05", `${l}: 24 h`);
  assert.equal(f.formatTime("00:00", false), "00:00");
  assert.match(f.formatTime("00:00", true), /^12:00 /, "midnight is 12:00 am");
  assert.match(f.formatTime("12:00", true), /^12:00 /, "noon is 12:00 pm");
  assert.notEqual(f.formatTime("00:00", true), f.formatTime("12:00", true));
  assert.equal(f.formatTime("24:00", false), "");
  assert.equal(f.formatTime("", true), "");
}

// ---- what the field shows is read back unchanged: every day of 2026 and a leap day, every minute of the day, in every language
for (const l of LANGS) {
  setLangPref(l);
  const days = ["2024-02-29", "2028-02-29", "2099-12-31", "1999-01-01"];
  for (let i = 0; i < 365; i++) days.push(f.addDaysIso("2026-01-01", i));
  for (const d of days) assert.equal(f.parseDate(f.formatDate(d), "2026-05-03"), d, `${l}: ${d} -> ${f.formatDate(d)}`);
  for (let m = 0; m < 1440; m++) {
    const v = f.toTime(m);
    assert.equal(f.parseTime(f.formatTime(v, true)), v, `${l}: 12 h ${v} -> ${f.formatTime(v, true)}`);
    assert.equal(f.parseTime(f.formatTime(v, false)), v, `${l}: 24 h ${v}`);
  }
}

// ---- lenient date parsing (ref = the value the field had)
const REF = "2026-05-03";
const dates = (lang, table) => {
  setLangPref(lang);
  for (const [text, want] of Object.entries(table)) assert.equal(f.parseDate(text, REF), want, `${lang}: ${JSON.stringify(text)}`);
};
dates("en", {
  "16/10/2026": "2026-10-16", "16.10.2026": "2026-10-16", "16-10-2026": "2026-10-16", "16 10 2026": "2026-10-16", "2026-10-16": "2026-10-16", "2026/10/16": "2026-10-16",
  "20261016": "2026-10-16", "16/10/26": "2026-10-16", "1/2/2026": "2026-02-01", " 16 Oct 2026 ": "2026-10-16", "16 October 2026": "2026-10-16", "Oct 16, 2026": "2026-10-16",
  "October 16 2026": "2026-10-16", "16 octo 2026": "2026-10-16", "16 oct": "2026-10-16", "16/10": "2026-10-16", "16": "2026-05-16", "1": "2026-05-01",
  "10/16/2026": "2026-10-16", // month 16 does not exist: read the other way round
  "29 feb 2028": "2028-02-29", "２０２６/１０/１６": "2026-10-16", // full-width digits
  "31/02/2026": null, "29 Feb 2026": null, "32/1/2026": null, "13/13/2026": null, "": null, "   ": null, "abc": null, "oct": null, "2026-10": null, "16/10/202": null, "1/2/3/4": null,
});
dates("de", { "16.10.2026": "2026-10-16", "16. Okt. 2026": "2026-10-16", "16. Oktober 2026": "2026-10-16", "16 oktober": "2026-10-16", "16.10.": "2026-10-16", "16.10.26": "2026-10-16", "März 3, 2026": "2026-03-03", "3 maerz": null });
dates("ja", { "2026年10月16日": "2026-10-16", "2026/10/16": "2026-10-16", "2026-10-16": "2026-10-16", "10月16日": "2026-10-16", "10/16": "2026-10-16", "26/10/16": "2026-10-16", "16": "2026-05-16" });
dates("zh-Hans", { "2026年10月16日": "2026-10-16", "2026/10/16": "2026-10-16", "10月16日": "2026-10-16" });
dates("es", { "16 de octubre de 2026": "2026-10-16", "16 oct 2026": "2026-10-16", "16/10/2026": "2026-10-16", "16 sept 2026": "2026-09-16", "16 septiembre": "2026-09-16" });
dates("fr", { "16 octobre 2026": "2026-10-16", "16 oct. 2026": "2026-10-16", "16/10/2026": "2026-10-16", "1 février 2026": "2026-02-01", "1 fevrier 2026": "2026-02-01", "16 déc. 2026": "2026-12-16" });
dates("vi", { "16 thg 10 2026": "2026-10-16", "16/10/2026": "2026-10-16", "16 tháng 10, 2026": "2026-10-16" });
dates("ru", { "16 окт. 2026": "2026-10-16", "16.10.2026": "2026-10-16", "16 октября 2026": "2026-10-16", "16 ОКТЯБРЯ": "2026-10-16" });
// English month names are understood in every language
setLangPref("de");
assert.equal(f.parseDate("16 Oct 2026", REF), "2026-10-16");
setLangPref("ja");
assert.equal(f.parseDate("16 Oct 2026", REF), "2026-10-16");
// the number order is the language's: 2026/10/16 languages read two numbers as month and day, the others as day and month
setLangPref("en");
assert.equal(f.numericOrder(), "dmy");
assert.equal(f.parseDate("3/4", REF), "2026-04-03");
for (const l of ["ja", "zh-Hans"]) (setLangPref(l), assert.equal(f.numericOrder(), "ymd"));
setLangPref("ja");
assert.equal(f.parseDate("3/4", REF), "2026-03-04");
for (const l of ["en", "vi", "fr", "es", "de", "ru"]) (setLangPref(l), assert.equal(f.numericOrder(), "dmy", l));
// a date with no year or day takes them from the value the field had; without one, from today
setLangPref("en");
assert.equal(f.parseDate("16/10", "2031-01-01"), "2031-10-16");
assert.match(f.parseDate("16/10", "") ?? "", /^\d{4}-10-16$/);

// ---- lenient time parsing
setLangPref("en");
const times = {
  "15:00": "15:00", "15.00": "15:00", "1500": "15:00", "930": "09:30", "9": "09:00", "09": "09:00", "0:00": "00:00", "23:59": "23:59", "15h30": "15:30", "15 h 30": "15:30", "15": "15:00",
  "3pm": "15:00", "3 PM": "15:00", "3:30 pm": "15:30", "3.30pm": "15:30", "3 p.m.": "15:00", "12am": "00:00", "12 AM": "00:00", "12pm": "12:00", "12:30 am": "00:30", "11:59 pm": "23:59",
  "9a": "09:00", "9p": "21:00", "  7:05  ": "07:05", "７：３０": "07:30", "3:00": "03:00", // without am / pm the number is a 24-hour time
  "24:00": null, "25": null, "13pm": null, "0am": null, "9:60": null, "9:5": null, "abc": null, "": null, "3 xm": null, "1:2:3": null, "15:00:00": null,
};
for (const [text, want] of Object.entries(times)) assert.equal(f.parseTime(text), want, `en: ${JSON.stringify(text)}`);
// the words of the language
const words = {
  ja: { "午後3:30": "15:30", "3:30午後": "15:30", "午前9:05": "09:05", "3:30 午後": "15:30", "15時30分": "15:30", "15時": "15:00" },
  "zh-Hans": { "下午3:30": "15:30", "3:30 下午": "15:30", "上午9:05": "09:05" },
  es: { "3:30 p. m.": "15:30", "3:30 pm": "15:30", "9 a. m.": "09:00", "15:30": "15:30" },
  vi: { "3:30 CH": "15:30", "9:05 SA": "09:05", "3:30 pm": "15:30" },
  de: { "15 Uhr": "15:00", "15:30 Uhr": "15:30", "3:30 PM": "15:30" },
  fr: { "15 h 30": "15:30", "15h": "15:00", "3:30 PM": "15:30" },
};
for (const [l, table] of Object.entries(words)) {
  setLangPref(l);
  for (const [text, want] of Object.entries(table)) assert.equal(f.parseTime(text), want, `${l}: ${JSON.stringify(text)}`);
}

// ---- arithmetic of the arrow keys: calendar days and minutes of the day, never hours of 24 h across a clock change
assert.equal(f.addDaysIso("2026-10-16", 1), "2026-10-17");
assert.equal(f.addDaysIso("2026-10-31", 1), "2026-11-01");
assert.equal(f.addDaysIso("2026-12-31", 1), "2027-01-01");
assert.equal(f.addDaysIso("2026-01-01", -1), "2025-12-31");
assert.equal(f.addDaysIso("2028-02-28", 1), "2028-02-29");
assert.equal(f.addDaysIso("2027-02-28", 1), "2027-03-01");
assert.equal(f.addDaysIso("2026-10-16", 0), "2026-10-16");
assert.equal(f.addDaysIso("nope", 1), null);
// the clock changes of 2026: Europe/Berlin 29 March (23 h day) and 25 October (25 h day), US 8 March (the zone set above is Berlin)
for (const start of ["2026-03-27", "2026-10-23"]) {
  let d = start;
  const seen = [];
  for (let i = 0; i < 6; i++) (seen.push(d), (d = f.addDaysIso(d, 1)));
  const want = [];
  for (let i = 0; i < 6; i++) want.push(new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8)) + i)).toISOString().slice(0, 10));
  assert.deepEqual(seen, want, `${start}: six consecutive days across a clock change`);
}
for (const d of ["2026-03-29", "2026-03-08", "2026-10-25", "2026-11-01"]) {
  setLangPref("en");
  assert.equal(f.formatDate(d), `${Number(d.slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]} 2026`, `${d} is shown as itself`);
  assert.equal(f.addDaysIso(f.addDaysIso(d, 1), -1), d);
}
assert.equal(f.addMonthsIso("2026-01-31", 1), "2026-02-28", "the last day of a shorter month");
assert.equal(f.addMonthsIso("2028-01-31", 1), "2028-02-29");
assert.equal(f.addMonthsIso("2026-12-15", 1), "2027-01-15");
assert.equal(f.addMonthsIso("2026-01-15", -1), "2025-12-15");
assert.equal(f.addMonthsIso("2026-03-31", -1), "2026-02-28");
assert.equal(f.addMonthsIso("2026-10-16", 12), "2027-10-16");
assert.equal(f.addMinutesOfDay("10:00", 15), "10:15");
assert.equal(f.addMinutesOfDay("10:50", 15), "11:05");
assert.equal(f.addMinutesOfDay("23:50", 15), "00:05", "wraps at midnight (the date is not touched)");
assert.equal(f.addMinutesOfDay("00:05", -15), "23:50");
assert.equal(f.addMinutesOfDay("10:07", 1), "10:08");
assert.equal(f.addMinutesOfDay("10:00", 60), "11:00");
assert.equal(f.addMinutesOfDay("02:30", 60 * 24), "02:30");
assert.equal(f.addMinutesOfDay("x", 15), null);
// (every value of the clock-change nights exists: no time is skipped by the field itself; the dialog's own check handles a gap)
assert.equal(f.addMinutesOfDay("02:00", 30), "02:30");

// ---- the time list: every 15 minutes, plus the value when it is between two of them
const slots = f.timeSlots("");
assert.equal(slots.length, 96);
assert.equal(slots[0], "00:00");
assert.equal(slots[95], "23:45");
assert.equal(f.timeSlots("10:07").length, 97);
assert.ok(f.timeSlots("10:07").includes("10:07"));
assert.deepEqual(f.timeSlots("10:07").slice(40, 43), ["10:00", "10:07", "10:15"], "kept in order");
assert.equal(f.timeSlots("10:15").length, 96);
assert.equal(f.slotFor(slots, "10:15"), "10:15");
assert.equal(f.slotFor(slots, "10:07"), "10:15", "a value between two rows opens the list on the next one");
assert.equal(f.slotFor(slots, "23:50"), "23:45");
assert.equal(f.slotFor(slots, ""), "00:00");
assert.equal(f.readIso("2026-10-16")?.d, 16);
assert.equal(f.readIso("2026-13-01"), null);
assert.equal(f.readIso("26-10-16"), null);
assert.equal(f.readTime("15:30"), 930);
assert.equal(f.readTime("24:00"), null);
assert.equal(f.readTime("3:30"), null);

// ---- no native date / time input is left (they show the OS format, not the app language)
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const NATIVE = /type\s*=\s*\{?\s*["'`](date|time|datetime-local|month|week)["'`]|\[type\s*=\s*["']?(date|time|datetime-local|month|week)["']?\]|createElement\(\s*["']input["'][^)]*["'](date|time)["']/;
const ALLOWED = []; // none: a place that genuinely needs one must be listed here with the reason
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1"); // (comments may name them)
const hits = [];
for (const file of walk("src").filter((x) => /\.(tsx?|css|html)$/.test(x))) {
  const text = bare(readFileSync(file, "utf8"));
  if (NATIVE.test(text) && !ALLOWED.includes(file.replaceAll("\\", "/"))) hits.push(file);
}
assert.deepEqual(hits, [], `native date / time inputs in ${hits.join(", ")}: use DateField / TimeField (components/DateTimeFields.tsx)`);
assert.ok(!NATIVE.test(readFileSync("index.html", "utf8")));

// ---- the places that had them use the fields
const src = (p) => readFileSync(p, "utf8");
const count = (text, re) => (text.match(re) ?? []).length;
const cal = src("src/components/Calendar.tsx");
assert.equal(count(cal, /<DateField\b/g), 4, "event dialog (start, end) and meeting strip (start, end)");
assert.equal(count(cal, /<TimeField\b/g), 4);
assert.equal(count(src("src/components/SchedulePicker.tsx"), /<(DateField|TimeField)\b/g), 2, "Send later");
assert.equal(count(src("src/components/SearchBox.tsx"), /<DateField\b/g), 1, "the search date filters (after: / before:)");
// the start and the end of the dialog have their own accessible names
for (const k of ["startDate", "startTime", "endDate", "endTime"]) assert.ok(cal.includes(`label={t("calendar.dialog.${k}")}`), k);

// ---- the popups: a press outside is found with contains(), never with blur or focus (WebKit does not focus a button on a mouse click)
const ui = src("src/components/DateTimeFields.tsx");
const popup = ui.slice(ui.indexOf("function FieldPopup"), ui.indexOf("// ================================================================ time list"));
assert.ok(/addEventListener\("mousedown"/.test(popup) && /anchor\.current\?\.contains\(n\)/.test(popup) && /pop\.current\?\.contains\(n\)/.test(popup), "outside press by contains()");
assert.ok(!/onBlur|focusout|blur\(/.test(popup), "the popup does not close on blur");
assert.ok(/menuOwners\.set\(el, anchor\)/.test(popup), "a popover around the field does not take a press on the popup for an outside press (pressInside.ts)");
assert.ok(/className="dd-fixed fld-pop"/.test(popup), "drawn like the menus (above dialogs)");
assert.ok(/e\.stopPropagation\(\)/.test(popup), "keys typed in the popup do not reach the popover or the app's shortcuts around it");
assert.ok(/Escape/.test(popup) && /preventDefault/.test(popup));
assert.ok(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/.test(ui), "the button press does not take the focus (Chromium scrolls the dialog body to it)");
// the fields read the language and the Time format setting
assert.ok(/prefs\.timeFormat === "12"/.test(ui) && /formatTime\(v, hour12\)/.test(ui));
assert.ok(/week[Ss]tart/.test(ui), "the month grid starts the week where the setting says");
// the labels of the two buttons are in every language
for (const l of LANGS) {
  setLangPref(l);
  const { t } = await import("../src/i18n/index.ts");
  for (const k of ["calendar.dialog.pickDate", "calendar.dialog.pickTime"]) assert.ok(t(k) && t(k) !== k, `${l}: ${k}`);
}
setLangPref("en");
const { t } = await import("../src/i18n/index.ts");
assert.equal(t("calendar.dialog.pickDate"), "Choose date");
assert.equal(t("calendar.dialog.pickTime"), "Choose time");

// ---- the Send later popover stays inside the window (QA round 9, BUG-1: it was 9 px wider than the window at the minimum width of 960 px)
const { fitInWindow } = await import("../src/fitInWindow.ts");
const box = (left, width, top, height) => ({ left, right: left + width, top, bottom: top + height });
assert.deepEqual(fitInWindow(box(100, 300, 100, 200), 944, 560), { shift: 0, maxHeight: null }, "fits: untouched");
assert.deepEqual(fitInWindow(box(668, 300, 197, 417), 944, 780), { shift: -32, maxHeight: null }, "the round 9 case: 22 px past the right edge, 8 px of margin");
assert.equal(fitInWindow(box(668, 300, 197, 200), 944, 560).shift, -32);
assert.deepEqual(fitInWindow(box(641, 295, 200, 417), 944, 560), { shift: 0, maxHeight: 352 }, "taller than the room below: scrolls inside");
assert.equal(fitInWindow(box(10, 300, 500, 417), 944, 560).maxHeight, 160, "never made smaller than 160 px");
assert.equal(fitInWindow(box(-20, 300, 0, 100), 944, 560).shift, 28, "past the left edge: moved back in");
assert.equal(fitInWindow(box(300, 400, 0, 100), 320, 560).shift, -292, "window narrower than the popover: the left edge wins");
// every window size and popover position: after the shift the box is inside, or its left edge is at the margin when it is wider than the window
for (let vw = 320; vw <= 1920; vw += 40) {
  for (let left = -50; left <= vw; left += 37) {
    for (const w of [200, 300, vw - 16, vw + 100]) {
      const { shift } = fitInWindow(box(left, w, 0, 100), vw, 600);
      const l = left + shift, r = l + w;
      assert.ok(l >= 8 - 1e-9, `vw ${vw} left ${left} w ${w}: left edge ${l}`);
      assert.ok(r <= vw - 8 + 1e-9 || l <= 8 + 1e-9, `vw ${vw} left ${left} w ${w}: right edge ${r}`);
    }
  }
}
{
  const css = src("src/App.css");
  const rule = css.match(/\.popover\.up\.sched-pop\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(/width:\s*min\(\s*300px\s*,\s*calc\(100vw - 16px\)\s*\)/.test(rule), "Send later is never wider than the window");
  // (the dialog inside the frame is the one box that scrolls: a box of its own taller than its frame stuck out of the window, QA round 3 BUG-R3-1)
  assert.ok(/\.sched-pop > \.sched-picker\s*\{[^}]*overflow-y:\s*auto/.test(css), "and scrolls when it is taller than the room");
  assert.ok(/\.sched-custom \.sched-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(css), "Cancel / Schedule wrap in a narrow popover (longest labels: de, ru, vi, fr)");
  const compose = src("src/components/Compose.tsx");
  // (placed by usePinnedBelow: fixed under the split button, moved sideways / made scrollable to stay inside the window; the header of the pane scrolls and would cut off an absolute popover)
  assert.ok(/usePinnedBelow\(schedPopRef, schedRef, schedOpen\)/.test(compose) && /className="popover up sched-pop pinned" ref=\{schedPopRef\}/.test(compose), "Compose keeps the popover inside the window");
  assert.ok(/\.popover\.up\.pinned\s*\{[^}]*position:\s*fixed/.test(css), "a pinned popover is fixed");
}

// ---- an all-day event chip draws its title once (QA round 9, BUG-2 was not a drawing bug: the title typed into the dialog was already doubled)
{
  const chip = cal.slice(cal.indexOf("function Chip("), cal.indexOf("const MAX_CHIPS"));
  assert.equal(count(chip, /\{ev\.summary\}/g), 1, "the chip shows the summary once");
  assert.equal(count(chip, /aria-label=\{eventLabel\(ev, tz\)\}/g), 1, "the accessible name is the one label, not the text plus the label");
  assert.ok(!/sr-only|visually-hidden/.test(chip), "no hidden duplicate of the title");
}

console.log("datetime fields: ok");
