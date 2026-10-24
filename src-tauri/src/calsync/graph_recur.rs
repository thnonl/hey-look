//! Outlook / Microsoft 365 (Graph) repeat patterns and the repeat rules of the app, both ways (D-7.1e).
//!
//! Graph has no RRULE: a series master carries a `patternedRecurrence` (a `pattern` and a `range`). The app maps the rules it makes itself (every day, every weekday,
//! weekly on days, monthly on a day or on the n-th weekday, yearly on a date or on the n-th weekday of a month, each with INTERVAL; COUNT becomes a numbered range, UNTIL
//! an end date, no end stays open). A pattern outside that set is `Err(Unsupported)`: the series keeps its rule and the form cannot change it.
use crate::ical;
use chrono::{DateTime, Datelike, NaiveDate, Weekday};
use serde_json::{json, Value};

/// A Graph pattern Hey Look! cannot express as a rule.
#[derive(Debug, PartialEq)]
pub struct Unsupported;

const DAYS: [(&str, &str, Weekday); 7] = [
    ("MO", "monday", Weekday::Mon),
    ("TU", "tuesday", Weekday::Tue),
    ("WE", "wednesday", Weekday::Wed),
    ("TH", "thursday", Weekday::Thu),
    ("FR", "friday", Weekday::Fri),
    ("SA", "saturday", Weekday::Sat),
    ("SU", "sunday", Weekday::Sun),
];

const INDEX: [(&str, i32); 5] = [("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("last", -1)];

fn day_name(code: &str) -> Option<&'static str> {
    DAYS.iter().find(|(c, _, _)| c.eq_ignore_ascii_case(code)).map(|(_, n, _)| *n)
}

fn day_code(name: &str) -> Option<&'static str> {
    DAYS.iter().find(|(_, n, _)| n.eq_ignore_ascii_case(name)).map(|(c, _, _)| *c)
}

fn weekday_code(w: Weekday) -> &'static str {
    DAYS.iter().find(|(_, _, d)| *d == w).map(|(c, _, _)| *c).unwrap_or("MO")
}

/// The calendar date of the first occurrence in the zone of the series (the UTC date for an all-day series).
fn first_date(start: i64, all_day: bool, tzid: Option<&str>) -> NaiveDate {
    let tz = tzid.and_then(ical::iana_for).filter(|_| !all_day);
    ical::wall_in(tz, start).date()
}

/// The rule's parts, or `None` for a part Graph has no word for.
fn parts(rule: &str) -> Option<Vec<(String, String)>> {
    let mut out = vec![];
    for kv in crate::recur::bare(rule).split(';').filter(|x| !x.trim().is_empty()) {
        let (k, v) = kv.split_once('=')?;
        let k = k.trim().to_ascii_uppercase();
        if !matches!(k.as_str(), "FREQ" | "INTERVAL" | "COUNT" | "UNTIL" | "BYDAY" | "BYMONTHDAY" | "BYMONTH" | "WKST") {
            return None;
        }
        out.push((k, v.trim().to_string()));
    }
    Some(out)
}

/// An RRULE as Graph's `patternedRecurrence`; `start` is the first occurrence. `None` when the rule is outside the mapped set.
pub fn to_graph(rrule: &str, start: i64, all_day: bool, tzid: Option<&str>) -> Option<Value> {
    let p = parts(rrule)?;
    let get = |k: &str| p.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
    let d = first_date(start, all_day, tzid);
    let interval: u32 = get("INTERVAL").map(|v| v.parse().ok().filter(|n| (1..=99).contains(n))).unwrap_or(Some(1))?;
    // BYDAY: plain weekdays, or one weekday with an ordinal
    let by_day: Vec<(i32, &str)> = match get("BYDAY") {
        None => vec![],
        Some(v) => v
            .split(',')
            .map(|x| {
                let x = x.trim();
                let (num, code) = x.split_at(x.len().checked_sub(2)?);
                let ord: i32 = if num.is_empty() { 0 } else { num.trim_start_matches('+').parse().ok()? };
                day_name(code).map(|_| (ord, code))
            })
            .collect::<Option<Vec<_>>>()?,
    };
    let by_month_day: Vec<i32> = match get("BYMONTHDAY") {
        None => vec![],
        Some(v) => v.split(',').map(|x| x.trim().parse::<i32>().ok()).collect::<Option<Vec<_>>>()?,
    };
    let by_month: Vec<u32> = match get("BYMONTH") {
        None => vec![],
        Some(v) => v.split(',').map(|x| x.trim().parse::<u32>().ok().filter(|m| (1..=12).contains(m))).collect::<Option<Vec<_>>>()?,
    };
    let index_of = |ord: i32| INDEX.iter().find(|(_, n)| *n == ord).map(|(w, _)| *w);
    let pattern = match get("FREQ")?.to_ascii_uppercase().as_str() {
        "DAILY" if by_day.is_empty() && by_month_day.is_empty() && by_month.is_empty() => json!({ "type": "daily", "interval": interval }),
        "WEEKLY" if by_month_day.is_empty() && by_month.is_empty() && by_day.iter().all(|(o, _)| *o == 0) => {
            let mut days: Vec<&str> = by_day.iter().map(|(_, c)| *c).collect();
            if days.is_empty() {
                days.push(weekday_code(d.weekday()));
            }
            days.sort_by_key(|c| DAYS.iter().position(|(x, _, _)| x.eq_ignore_ascii_case(c)));
            days.dedup();
            let first = get("WKST").and_then(day_name).unwrap_or("monday");
            json!({ "type": "weekly", "interval": interval, "daysOfWeek": days.iter().filter_map(|c| day_name(c)).collect::<Vec<_>>(), "firstDayOfWeek": first })
        }
        "MONTHLY" if by_month.is_empty() => match (by_day.as_slice(), by_month_day.as_slice()) {
            ([], []) => json!({ "type": "absoluteMonthly", "interval": interval, "dayOfMonth": d.day() }),
            ([], [m]) if (1..=31).contains(m) => json!({ "type": "absoluteMonthly", "interval": interval, "dayOfMonth": m }),
            ([(o, c)], []) if *o != 0 => json!({ "type": "relativeMonthly", "interval": interval, "daysOfWeek": [day_name(c)?], "index": index_of(*o)? }),
            _ => return None,
        },
        "YEARLY" => {
            let month = match by_month.as_slice() {
                [] => d.month(),
                [m] => *m,
                _ => return None,
            };
            match (by_day.as_slice(), by_month_day.as_slice()) {
                ([], []) if by_month.is_empty() => json!({ "type": "absoluteYearly", "interval": interval, "dayOfMonth": d.day(), "month": d.month() }),
                ([], [m]) if (1..=31).contains(m) => json!({ "type": "absoluteYearly", "interval": interval, "dayOfMonth": m, "month": month }),
                ([(o, c)], []) if *o != 0 && !by_month.is_empty() => json!({ "type": "relativeYearly", "interval": interval, "month": month, "daysOfWeek": [day_name(c)?], "index": index_of(*o)? }),
                _ => return None,
            }
        }
        _ => return None,
    };
    let zone = tzid.filter(|z| !all_day && ical::iana_for(z).is_some()).unwrap_or("UTC");
    let start_date = d.format("%Y-%m-%d").to_string();
    let range = match (get("COUNT"), get("UNTIL")) {
        (Some(n), _) => json!({ "type": "numbered", "startDate": start_date, "numberOfOccurrences": n.parse::<u32>().ok().filter(|n| *n >= 1)?, "recurrenceTimeZone": zone }),
        (None, Some(u)) => {
            let end = until_date(u, all_day, tzid, start)?;
            json!({ "type": "endDate", "startDate": start_date, "endDate": end.format("%Y-%m-%d").to_string(), "recurrenceTimeZone": zone })
        }
        _ => json!({ "type": "noEnd", "startDate": start_date, "recurrenceTimeZone": zone }),
    };
    Some(json!({ "pattern": pattern, "range": range }))
}

/// The last day of a series with UNTIL, in the zone of the series: the date of the last occurrence that starts at or before UNTIL (an occurrence on the UNTIL day
/// that starts after it is not part of the series, though a date-only end would include it).
fn until_date(until: &str, all_day: bool, tzid: Option<&str>, start: i64) -> Option<NaiveDate> {
    let u = until.trim();
    if u.len() == 8 {
        return NaiveDate::parse_from_str(u, "%Y%m%d").ok();
    }
    let tz = tzid.and_then(ical::iana_for).filter(|_| !all_day);
    let n = chrono::NaiveDateTime::parse_from_str(u.trim_end_matches(['Z', 'z']), "%Y%m%dT%H%M%S").ok()?;
    let (day, tod_ok) = if u.ends_with(['Z', 'z']) {
        let at = n.and_utc().timestamp();
        let local = ical::wall_in(tz, at);
        (local.date(), ical::instant_of(tz, local.date().and_time(ical::wall_in(tz, start).time())) <= at)
    } else {
        (n.date(), n.time() >= ical::wall_in(tz, start).time())
    };
    if tod_ok || all_day { Some(day) } else { day.pred_opt() }
}

/// Graph's `patternedRecurrence` as an RRULE (without the prefix); `start` is the first occurrence of the series.
pub fn from_graph(rec: &Value, start: i64, all_day: bool, tzid: Option<&str>) -> Result<String, Unsupported> {
    let p = &rec["pattern"];
    let r = &rec["range"];
    let d = first_date(start, all_day, tzid);
    let interval = p["interval"].as_u64().filter(|n| (1..=99).contains(n)).unwrap_or(1);
    let iv = if interval == 1 { String::new() } else { format!(";INTERVAL={interval}") };
    let one_day = |p: &Value| -> Result<&'static str, Unsupported> {
        let days = p["daysOfWeek"].as_array().ok_or(Unsupported)?;
        match days.as_slice() {
            [x] => x.as_str().and_then(day_code).ok_or(Unsupported),
            _ => Err(Unsupported),
        }
    };
    let ord = |p: &Value| -> Result<i32, Unsupported> { INDEX.iter().find(|(w, _)| Some(*w) == p["index"].as_str()).map(|(_, n)| *n).ok_or(Unsupported) };
    let mut rule = match p["type"].as_str().ok_or(Unsupported)? {
        "daily" => format!("FREQ=DAILY{iv}"),
        "weekly" => {
            let mut days: Vec<&str> = p["daysOfWeek"].as_array().ok_or(Unsupported)?.iter().map(|x| x.as_str().and_then(day_code).ok_or(Unsupported)).collect::<Result<_, _>>()?;
            if days.is_empty() {
                return Err(Unsupported);
            }
            days.sort_by_key(|c| DAYS.iter().position(|(x, _, _)| x == c));
            days.dedup();
            format!("FREQ=WEEKLY{iv};BYDAY={}", days.join(","))
        }
        "absoluteMonthly" => format!("FREQ=MONTHLY{iv};BYMONTHDAY={}", p["dayOfMonth"].as_u64().filter(|n| (1..=31).contains(n)).ok_or(Unsupported)?),
        "relativeMonthly" => format!("FREQ=MONTHLY{iv};BYDAY={}{}", ord(p)?, one_day(p)?),
        "absoluteYearly" => {
            let (m, day) = (p["month"].as_u64().filter(|n| (1..=12).contains(n)).ok_or(Unsupported)?, p["dayOfMonth"].as_u64().filter(|n| (1..=31).contains(n)).ok_or(Unsupported)?);
            // the preset "every year" is the rule without a month and day: they are those of the start
            if interval == 1 && m == d.month() as u64 && day == d.day() as u64 { "FREQ=YEARLY".to_string() } else { format!("FREQ=YEARLY{iv};BYMONTH={m};BYMONTHDAY={day}") }
        }
        "relativeYearly" => format!("FREQ=YEARLY{iv};BYMONTH={};BYDAY={}{}", p["month"].as_u64().filter(|n| (1..=12).contains(n)).ok_or(Unsupported)?, ord(p)?, one_day(p)?),
        _ => return Err(Unsupported),
    };
    match r["type"].as_str().unwrap_or("noEnd") {
        "numbered" => rule.push_str(&format!(";COUNT={}", r["numberOfOccurrences"].as_u64().filter(|n| *n >= 1).ok_or(Unsupported)?)),
        "endDate" => {
            let end = r["endDate"].as_str().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()).ok_or(Unsupported)?;
            if all_day {
                rule.push_str(&format!(";UNTIL={}", end.format("%Y%m%d")));
            } else {
                // the end of that day in the zone of the series
                let tz = tzid.and_then(ical::iana_for);
                let at = ical::instant_of(tz, end.and_hms_opt(23, 59, 59).ok_or(Unsupported)?);
                rule.push_str(&format!(";UNTIL={}", DateTime::from_timestamp(at, 0).ok_or(Unsupported)?.format("%Y%m%dT%H%M%SZ")));
            }
        }
        _ => {}
    }
    Ok(rule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use chrono_tz::Tz;

    fn berlin(y: i32, m: u32, d: u32, h: u32) -> i64 {
        let tz: Tz = "Europe/Berlin".parse().unwrap();
        tz.from_local_datetime(&NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, 0, 0).unwrap()).earliest().unwrap().timestamp()
    }

    /// The rule goes to Graph and comes back as the same text.
    fn round(rule: &str, start: i64, all_day: bool) -> String {
        let tz = if all_day { None } else { Some("Europe/Berlin") };
        let g = to_graph(rule, start, all_day, tz).unwrap_or_else(|| panic!("{rule} did not map"));
        from_graph(&g, start, all_day, tz).unwrap_or_else(|_| panic!("{rule} did not come back: {g}"))
    }

    #[test]
    fn graph_pattern_mapping_both_ways() {
        let tue = berlin(2026, 10, 13, 9);
        // every preset of the form
        for preset in ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "FREQ=WEEKLY;BYDAY=TU", "FREQ=MONTHLY;BYMONTHDAY=13", "FREQ=YEARLY"] {
            assert_eq!(round(preset, tue, false), preset);
        }
        // intervals, ends, ordinals
        for rule in [
            "FREQ=DAILY;INTERVAL=3",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
            "FREQ=WEEKLY;BYDAY=TU;COUNT=8",
            "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=13;COUNT=5",
            "FREQ=MONTHLY;BYDAY=2TU",
            "FREQ=MONTHLY;BYDAY=-1FR;COUNT=12",
            "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=5",
            "FREQ=YEARLY;INTERVAL=2;BYMONTH=11;BYDAY=4TH",
        ] {
            assert_eq!(round(rule, tue, false), rule);
        }
        // UNTIL becomes an end date in the zone of the series and comes back as the end of that day
        let g = to_graph("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261103T080000Z", tue, false, Some("Europe/Berlin")).unwrap();
        assert_eq!(g["range"]["type"], "endDate");
        assert_eq!(g["range"]["endDate"], "2026-11-03");
        assert_eq!(g["range"]["recurrenceTimeZone"], "Europe/Berlin");
        assert_eq!(g["range"]["startDate"], "2026-10-13");
        assert_eq!(from_graph(&g, tue, false, Some("Europe/Berlin")).unwrap(), "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261103T225959Z", "23:59:59 Berlin is 22:59:59Z in November");
        // all day: dates
        let mon = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
        let g = to_graph("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101", mon, true, None).unwrap();
        assert_eq!(g["range"]["endDate"], "2026-11-01");
        assert_eq!(from_graph(&g, mon, true, None).unwrap(), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261101");
        // the pattern of the preset names its parts
        let weekly = to_graph("FREQ=WEEKLY;BYDAY=TU", tue, false, Some("Europe/Berlin")).unwrap();
        assert_eq!(weekly["pattern"], json!({ "type": "weekly", "interval": 1, "daysOfWeek": ["tuesday"], "firstDayOfWeek": "monday" }));
        assert_eq!(weekly["range"]["type"], "noEnd");
        // an implied weekday / day of month / date is taken from the start
        assert_eq!(to_graph("FREQ=WEEKLY", tue, false, Some("Europe/Berlin")).unwrap()["pattern"]["daysOfWeek"], json!(["tuesday"]));
        assert_eq!(to_graph("FREQ=MONTHLY", tue, false, Some("Europe/Berlin")).unwrap()["pattern"]["dayOfMonth"], 13);
        assert_eq!(to_graph("FREQ=YEARLY", tue, false, Some("Europe/Berlin")).unwrap()["pattern"], json!({ "type": "absoluteYearly", "interval": 1, "dayOfMonth": 13, "month": 10 }));
    }

    #[test]
    fn rules_outside_the_set_do_not_map() {
        let tue = berlin(2026, 10, 13, 9);
        for rule in [
            "FREQ=HOURLY",
            "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO,TU",
            "FREQ=MONTHLY;BYMONTHDAY=1,15",
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            "FREQ=WEEKLY;BYDAY=2TU",
            "FREQ=DAILY;BYDAY=MO",
            "FREQ=YEARLY;BYMONTH=1,2",
            "FREQ=WEEKLY;INTERVAL=0",
            "FREQ=DAILY;BYHOUR=9",
            "garbage",
        ] {
            assert!(to_graph(rule, tue, false, Some("Europe/Berlin")).is_none(), "{rule}");
        }
        // Graph patterns the app does not map: a relative pattern with two days, a pattern without a type
        let two = json!({ "pattern": { "type": "relativeMonthly", "interval": 1, "daysOfWeek": ["monday", "tuesday"], "index": "first" }, "range": { "type": "noEnd" } });
        assert_eq!(from_graph(&two, tue, false, Some("Europe/Berlin")), Err(Unsupported));
        assert_eq!(from_graph(&json!({}), tue, false, None), Err(Unsupported));
        let odd = json!({ "pattern": { "type": "weekly", "interval": 1, "daysOfWeek": [] }, "range": { "type": "noEnd" } });
        assert_eq!(from_graph(&odd, tue, false, None), Err(Unsupported));
    }

    #[test]
    fn the_end_of_a_series_follows_the_split() {
        // a series cut before 10 Nov: the old part's UNTIL is one second before the slot
        let start = berlin(2026, 10, 13, 9);
        let slot = berlin(2026, 11, 10, 9);
        let sp = crate::recur::split("FREQ=WEEKLY;BYDAY=TU", start, false, Some("Europe/Berlin"), slot).unwrap();
        let g = to_graph(&sp.old, start, false, Some("Europe/Berlin")).unwrap();
        assert_eq!(g["range"]["endDate"], "2026-11-09", "UNTIL is 07:59:59Z on the 10th = 08:59:59 Berlin: the 10th's 09:00 occurrence is after it, so the last day is the 9th (the 3rd is the last Tuesday)");
        // ... and a series that ends the day before at 23:59 keeps that day
        let g = to_graph("FREQ=DAILY;UNTIL=20261110T225959Z", start, false, Some("Europe/Berlin")).unwrap();
        assert_eq!(g["range"]["endDate"], "2026-11-10", "09:00 Berlin on the 10th is 08:00Z, before the end");
    }
}

