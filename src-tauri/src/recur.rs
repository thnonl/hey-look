//! Edits of a repeat rule for the scopes of a series (W7.1): the two rules after "this and following", whether a rule really changed, and
//! where a slot goes when the time of a series moves. Pure functions; `calseries.rs` (My events) and `calsync/series.rs` (Google, Outlook)
//! use them.
//!
//! A *slot* is the original start of one occurrence: the instant `ical::instances_budgeted` gives it, worked out in the zone of the series
//! (never the zone of the app) from the wall clock of DTSTART; for an all-day series the UTC midnight of its date.
use crate::ical;
use chrono::{DateTime, Datelike, Weekday};

/// The rule without its `RRULE:` prefix.
pub fn bare(rule: &str) -> &str {
    let r = rule.trim();
    r.strip_prefix("RRULE:").or_else(|| r.strip_prefix("rrule:")).unwrap_or(r).trim()
}

fn parts(rule: &str) -> Vec<(String, String)> {
    bare(rule).split(';').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().to_string())).collect()
}

fn join(p: &[(String, String)]) -> String {
    p.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(";")
}

/// The value of a part of the rule.
pub fn part(rule: &str, key: &str) -> Option<String> {
    parts(rule).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// The UNTIL value that ends a series just before `slot`: all day, the day before in DATE form; timed, one second before in UTC (RFC 5545 asks
/// for UTC when the start is zoned or UTC).
pub fn until_before(slot: i64, all_day: bool) -> String {
    let fmt = |ts: i64, f: &str| DateTime::from_timestamp(ts, 0).unwrap_or_default().format(f).to_string();
    if all_day {
        fmt(slot - 86_400, "%Y%m%d")
    } else {
        fmt(slot - 1, "%Y%m%dT%H%M%SZ")
    }
}

/// How many occurrences of the rule start before `slot`.
fn instances_before(rule: &str, start: i64, all_day: bool, tzid: Option<&str>, slot: i64) -> u32 {
    let mut budget = ical::MAX_EXPAND_STEPS;
    ical::expand_budgeted(start, start + 1, all_day, tzid, rule, &[], start - 1, slot, &mut budget).len() as u32
}

/// The two rules after a series is cut before `slot`: the old series ends before it, the new one starts at it.
pub struct Split {
    pub old: String,
    pub new: String,
}

/// Cut a rule before `slot` (an occurrence of the series after its first one). A rule with COUNT is divided (`k` occurrences stay, the rest
/// goes to the new series); any other rule gets UNTIL in the old series and stays as it is in the new one. `None` when the rule has no parts
/// or the cut leaves nothing on one side.
pub fn split(rule: &str, start: i64, all_day: bool, tzid: Option<&str>, slot: i64) -> Option<Split> {
    let mut p = parts(rule);
    if p.is_empty() || slot <= start {
        return None;
    }
    if let Some(i) = p.iter().position(|(k, _)| k == "COUNT") {
        let n: u32 = p[i].1.parse().ok()?;
        let k = instances_before(rule, start, all_day, tzid, slot);
        if k == 0 || k >= n {
            return None;
        }
        let mut old = p.clone();
        old[i].1 = k.to_string();
        p[i].1 = (n - k).to_string();
        return Some(Split { old: join(&old), new: join(&p) });
    }
    let new = join(&p);
    p.retain(|(k, _)| k != "UNTIL");
    p.push(("UNTIL".into(), until_before(slot, all_day)));
    Some(Split { old: join(&p), new })
}

fn weekday_code(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "MO",
        Weekday::Tue => "TU",
        Weekday::Wed => "WE",
        Weekday::Thu => "TH",
        Weekday::Fri => "FR",
        Weekday::Sat => "SA",
        Weekday::Sun => "SU",
    }
}

/// The rule in one canonical form, with what DTSTART implies written out (a weekly rule without BYDAY repeats on the weekday of the start, ...),
/// so that two spellings of one rule compare equal and a rule that moved with its start compares different.
pub fn signature(rule: &str, start: i64, all_day: bool, tzid: Option<&str>) -> String {
    let mut p = parts(rule);
    let tz = tzid.and_then(ical::iana_for).filter(|_| !all_day);
    let d = ical::wall_in(tz, start).date();
    p.retain(|(k, v)| !(k == "INTERVAL" && v == "1") && !(k == "WKST" && v.eq_ignore_ascii_case("MO")));
    let has = |p: &[(String, String)], k: &str| p.iter().any(|(x, _)| x == k);
    let freq = p.iter().find(|(k, _)| k == "FREQ").map(|(_, v)| v.to_ascii_uppercase()).unwrap_or_default();
    match freq.as_str() {
        "WEEKLY" if !has(&p, "BYDAY") => p.push(("BYDAY".into(), weekday_code(d.weekday()).into())),
        "MONTHLY" if !has(&p, "BYDAY") && !has(&p, "BYMONTHDAY") => p.push(("BYMONTHDAY".into(), d.day().to_string())),
        "YEARLY" => {
            if !has(&p, "BYMONTH") {
                p.push(("BYMONTH".into(), d.month().to_string()));
            }
            if !has(&p, "BYDAY") && !has(&p, "BYMONTHDAY") {
                p.push(("BYMONTHDAY".into(), d.day().to_string()));
            }
        }
        _ => {}
    }
    for (k, v) in p.iter_mut() {
        if k == "BYDAY" || k == "BYMONTHDAY" || k == "BYMONTH" {
            let mut items: Vec<String> = v.split(',').map(|x| x.trim().to_ascii_uppercase()).collect();
            items.sort();
            *v = items.join(",");
        } else {
            *v = v.to_ascii_uppercase();
        }
    }
    p.sort();
    join(&p)
}

/// Whether two rules (each with the start it belongs to) are the same rule. An absent rule only equals an absent rule.
pub fn same_rule(a: Option<&str>, a_start: i64, b: Option<&str>, b_start: i64, all_day: bool, tzid: Option<&str>) -> bool {
    match (a.filter(|r| !r.trim().is_empty()), b.filter(|r| !r.trim().is_empty())) {
        (None, None) => true,
        (Some(x), Some(y)) => signature(x, a_start, all_day, tzid) == signature(y, b_start, all_day, tzid),
        _ => false,
    }
}

/// Where a slot goes when the start of its series moves from `old_start` to `new_start`: the wall clock moves by the same amount in the zone of
/// the series (so 09:00 -> 10:00 stays 09:00 -> 10:00 across a daylight saving change); all-day slots move by whole days.
pub fn shift_slot(slot: i64, old_start: i64, new_start: i64, all_day: bool, tzid: Option<&str>) -> i64 {
    if all_day {
        return slot + (new_start - old_start);
    }
    let tz = tzid.and_then(ical::iana_for);
    let delta = ical::wall_in(tz, new_start) - ical::wall_in(tz, old_start);
    match ical::wall_in(tz, slot).checked_add_signed(delta) {
        Some(n) => ical::instant_of(tz, n),
        None => slot + (new_start - old_start),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone};
    use chrono_tz::Tz;

    fn utc(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp()
    }
    fn local(z: &str, y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        let tz: Tz = z.parse().unwrap();
        tz.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, 0).unwrap()).earliest().unwrap().timestamp()
    }
    fn slots(rule: &str, start: i64, all_day: bool, tz: Option<&str>, to: i64) -> Vec<i64> {
        let mut budget = ical::MAX_EXPAND_STEPS;
        ical::expand_budgeted(start, start + 3600, all_day, tz, rule, &[], start - 1, to, &mut budget).into_iter().map(|(s, _)| s).collect()
    }

    /// The old series and the new one together give exactly the slots of the original rule, each once.
    fn check_split(rule: &str, start: i64, all_day: bool, tz: Option<&str>, cut_index: usize, horizon: i64) {
        let all = slots(rule, start, all_day, tz, horizon);
        assert!(all.len() > cut_index, "{rule}: only {} slots", all.len());
        let slot = all[cut_index];
        let sp = split(rule, start, all_day, tz, slot).unwrap_or_else(|| panic!("{rule}: no split"));
        let old = slots(&sp.old, start, all_day, tz, horizon);
        let new = slots(&sp.new, slot, all_day, tz, horizon);
        let mut joined = old.clone();
        joined.extend(new.clone());
        assert_eq!(joined, all, "{rule} cut at {cut_index}: old {} + new {}", sp.old, sp.new);
        assert!(old.iter().all(|s| *s < slot) && new.iter().all(|s| *s >= slot));
    }

    #[test]
    fn following_split_keeps_every_slot_once() {
        let berlin = Some("Europe/Berlin");
        let tue9 = local("Europe/Berlin", 2026, 10, 13, 9, 0);
        let h = utc(2028, 1, 1, 0, 0);
        // COUNT is divided, UNTIL and unlimited rules get UNTIL in the old series
        check_split("FREQ=WEEKLY;BYDAY=TU;COUNT=8", tue9, false, berlin, 3, h);
        check_split("FREQ=WEEKLY;BYDAY=TU;COUNT=8", tue9, false, berlin, 7, h);
        check_split("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T230000Z", tue9, false, berlin, 5, h);
        check_split("FREQ=WEEKLY;BYDAY=TU", tue9, false, berlin, 12, h);
        check_split("FREQ=DAILY;INTERVAL=2", tue9, false, berlin, 9, h);
        // every second week on two days: the cut lands on the second day of a week
        check_split("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", local("Europe/Berlin", 2026, 10, 12, 9, 0), false, berlin, 5, h);
        // monthly on the 31st: only months with 31 days have an occurrence
        let jan31 = local("Europe/Berlin", 2026, 1, 31, 8, 30);
        check_split("FREQ=MONTHLY;BYMONTHDAY=31", jan31, false, berlin, 3, h);
        check_split("FREQ=MONTHLY", jan31, false, berlin, 4, h);
        // yearly on 29 February
        let feb29 = local("Europe/Berlin", 2024, 2, 29, 12, 0);
        check_split("FREQ=YEARLY", feb29, false, berlin, 1, utc(2040, 1, 1, 0, 0));
        // all day
        let mon = utc(2026, 10, 12, 0, 0);
        check_split("FREQ=WEEKLY;BYDAY=MO", mon, true, None, 4, h);
        check_split("FREQ=WEEKLY;BYDAY=MO;COUNT=10", mon, true, None, 4, h);
        // no zone (UTC)
        check_split("FREQ=DAILY;COUNT=5", utc(2026, 10, 12, 8, 0), false, None, 2, h);
    }

    #[test]
    fn a_cut_that_leaves_nothing_is_refused() {
        let s = utc(2026, 10, 12, 8, 0);
        assert!(split("FREQ=DAILY;COUNT=3", s, false, None, s).is_none(), "the first occurrence is the whole series");
        assert!(split("FREQ=DAILY;COUNT=3", s, false, None, s + 10 * 86400).is_none(), "a slot after the last one");
        assert!(split("", s, false, None, s + 86400).is_none());
    }

    #[test]
    fn all_day_recurrence_id_and_until_are_dates() {
        let mon = utc(2026, 11, 2, 0, 0);
        assert_eq!(until_before(mon, true), "20261101", "the day before, in DATE form");
        let slot = local("Europe/Berlin", 2026, 11, 3, 9, 0);
        assert_eq!(until_before(slot, false), "20261103T075959Z", "one second before, in UTC (09:00 Berlin is 08:00Z in November)");
        let sp = split("FREQ=WEEKLY;BYDAY=MO", utc(2026, 10, 12, 0, 0), true, None, mon).unwrap();
        assert_eq!(sp.old, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101");
        assert_eq!(sp.new, "FREQ=WEEKLY;BYDAY=MO");
        // a series that already had UNTIL keeps it in the new part and gets the cut in the old part
        let sp = split("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231", utc(2026, 10, 12, 0, 0), true, None, mon).unwrap();
        assert_eq!((sp.old.as_str(), sp.new.as_str()), ("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101", "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231"));
        // a DATE-form UNTIL is read as the end of that day
        let all = slots("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101", utc(2026, 10, 12, 0, 0), true, None, utc(2027, 1, 1, 0, 0));
        assert_eq!(all, vec![utc(2026, 10, 12, 0, 0), utc(2026, 10, 19, 0, 0), utc(2026, 10, 26, 0, 0)]);
    }

    #[test]
    fn dst_end_berlin_weekly_keeps_wall_clock() {
        // 25 Oct 2026 is the end of summer time in Berlin: every Tuesday stays at 09:00 local, the UTC instant moves by an hour
        let start = local("Europe/Berlin", 2026, 10, 13, 9, 0);
        let all = slots("FREQ=WEEKLY;BYDAY=TU", start, false, Some("Europe/Berlin"), utc(2026, 11, 20, 0, 0));
        let hours: Vec<u32> = all.iter().map(|s| chrono::DateTime::from_timestamp(*s, 0).unwrap().format("%H").to_string().parse().unwrap()).collect();
        assert_eq!(hours, vec![7, 7, 8, 8, 8, 8], "07:00Z before the change, 08:00Z after (13 and 20 Oct, then 27 Oct ...)");
        // moving the series one hour later moves every slot by one wall-clock hour on both sides of the change
        let new_start = local("Europe/Berlin", 2026, 10, 13, 10, 0);
        assert_eq!(shift_slot(local("Europe/Berlin", 2026, 10, 20, 9, 0), start, new_start, false, Some("Europe/Berlin")), local("Europe/Berlin", 2026, 10, 20, 10, 0));
        assert_eq!(shift_slot(local("Europe/Berlin", 2026, 11, 3, 9, 0), start, new_start, false, Some("Europe/Berlin")), local("Europe/Berlin", 2026, 11, 3, 10, 0), "after the change: still +1 h local, not +1 h UTC of the old offset");
    }

    #[test]
    fn dst_us_ambiguous_and_gap_times() {
        // 01:30 on 1 Nov 2026 happens twice in New York: the first one counts
        let tz = Some("America/New_York");
        let start = local("America/New_York", 2026, 10, 25, 1, 30);
        let all = slots("FREQ=WEEKLY;BYDAY=SU", start, false, tz, utc(2026, 11, 20, 0, 0));
        assert_eq!(all[1], utc(2026, 11, 1, 5, 30), "the first 01:30 (EDT, UTC-4), not the second (EST)");
        // 02:30 on 14 Mar 2027 does not exist: it moves forward by the gap
        let start = local("America/New_York", 2027, 3, 7, 2, 30);
        let all = slots("FREQ=WEEKLY;BYDAY=SU", start, false, tz, utc(2027, 3, 30, 0, 0));
        assert_eq!(all[1], utc(2027, 3, 14, 7, 30), "03:30 EDT = 07:30Z");
        assert_eq!(all[2], local("America/New_York", 2027, 3, 21, 2, 30), "and the week after is 02:30 again");
    }

    #[test]
    fn event_zone_differs_from_app_zone() {
        // a New York series is viewed from Ho Chi Minh: its slots are the New York wall clock, whatever the app zone is
        let start = local("America/New_York", 2026, 10, 27, 9, 0);
        let all = slots("FREQ=WEEKLY;BYDAY=TU", start, false, Some("America/New_York"), utc(2026, 11, 20, 0, 0));
        assert_eq!(all, vec![utc(2026, 10, 27, 13, 0), utc(2026, 11, 3, 14, 0), utc(2026, 11, 10, 14, 0), utc(2026, 11, 17, 14, 0)], "13:00Z in EDT, 14:00Z once EST starts on 1 Nov");
        // the cut is one second before the slot in UTC, whichever zone the person sees it in
        assert_eq!(until_before(all[1], false), "20261103T135959Z");
        // the implied weekday of a rule is the weekday in the zone of the series: Tue 09:00 in New York is Tue 20:00 in Ho Chi Minh, and Wed 22:00 in Tokyo
        // in winter, but the rule of the New York series stays "Tuesday"
        assert_eq!(signature("FREQ=WEEKLY", start, false, Some("America/New_York")), "BYDAY=TU;FREQ=WEEKLY");
        // Tue 20:00 in New York is Wed 09:00 in Tokyo: the weekday depends on the zone it is read in, which is why a series is always worked out in its own zone
        let evening = local("America/New_York", 2026, 10, 27, 20, 0);
        assert_eq!(signature("FREQ=WEEKLY", evening, false, Some("America/New_York")), "BYDAY=TU;FREQ=WEEKLY");
        assert_eq!(signature("FREQ=WEEKLY", evening, false, Some("Asia/Tokyo")), "BYDAY=WE;FREQ=WEEKLY");
    }

    #[test]
    fn rules_are_compared_by_what_they_mean() {
        let tue = local("Europe/Berlin", 2026, 10, 13, 9, 0);
        let wed = local("Europe/Berlin", 2026, 10, 14, 9, 0);
        let z = Some("Europe/Berlin");
        assert!(same_rule(Some("FREQ=WEEKLY"), tue, Some("RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=1"), tue, false, z), "the weekday of the start is implied");
        assert!(!same_rule(Some("FREQ=WEEKLY;BYDAY=TU"), tue, Some("FREQ=WEEKLY;BYDAY=WE"), wed, false, z), "moving a weekly series to another weekday changes its rule");
        assert!(same_rule(Some("FREQ=WEEKLY;BYDAY=TU,TH"), tue, Some("freq=weekly;byday=th,tu"), tue, false, z));
        assert!(!same_rule(Some("FREQ=WEEKLY"), tue, Some("FREQ=WEEKLY;COUNT=4"), tue, false, z));
        assert!(!same_rule(Some("FREQ=DAILY"), tue, None, tue, false, z));
        assert!(same_rule(None, tue, Some(" "), tue, false, z));
        assert!(same_rule(Some("FREQ=MONTHLY"), tue, Some("FREQ=MONTHLY;BYMONTHDAY=13"), tue, false, z));
        assert!(same_rule(Some("FREQ=YEARLY"), tue, Some("FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=13"), tue, false, z));
    }

    #[test]
    fn slots_move_with_the_start_of_their_series() {
        let all_day_old = utc(2026, 10, 12, 0, 0);
        assert_eq!(shift_slot(utc(2026, 10, 26, 0, 0), all_day_old, utc(2026, 10, 13, 0, 0), true, None), utc(2026, 10, 27, 0, 0), "all day: a day later");
        let a = utc(2026, 10, 12, 8, 0);
        assert_eq!(shift_slot(utc(2026, 10, 19, 8, 0), a, utc(2026, 10, 12, 9, 30), false, None), utc(2026, 10, 19, 9, 30), "no zone: plain seconds");
    }
}
