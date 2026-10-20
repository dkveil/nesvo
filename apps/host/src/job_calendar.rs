//! Pure, bounded civil-calendar evaluation. The adapter runs it outside the host.
use chrono::{DateTime, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use ical::recur::{IcalRecurDateTime, IcalRecurFreq, IcalRecurRule, expand::IcalRecurExpand};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub fn default_zone() -> String {
    "Europe/Warsaw".into()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Schedule {
    Once {
        at: String,
    },
    Cron {
        expression: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
    Rrule {
        rule: String,
        start: String,
        #[serde(default = "default_zone")]
        time_zone: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub schedule: Schedule,
    pub after: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub code: String,
    pub message: String,
}
impl Failure {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Window {
    pub previous: Option<u64>,
    pub next: Option<u64>,
}
pub type Answer = Result<Window, Failure>;
fn invalid(message: &str) -> Failure {
    Failure::new("invalid_calendar", message)
}
fn limit() -> Failure {
    Failure::new(
        "calendar_limit",
        "Calendar search exceeded its bounded work; simplify or re-anchor the rule",
    )
}
fn zone(name: &str) -> Result<Tz, Failure> {
    if name.len() > 64 {
        return Err(invalid("Use an IANA time zone"));
    }
    name.parse().map_err(|_| invalid("Unknown IANA time zone"))
}
fn instant(zone: Tz, local: NaiveDateTime) -> Option<u64> {
    // Generated gaps are absent; a fold denotes only the earlier UTC instant.
    let time = match zone.from_local_datetime(&local) {
        LocalResult::Single(time) => time,
        LocalResult::Ambiguous(a, b) => a.min(b),
        LocalResult::None => return None,
    };
    u64::try_from(time.timestamp_millis()).ok()
}
fn utc(value: u64) -> Result<DateTime<Utc>, Failure> {
    i64::try_from(value)
        .ok()
        .and_then(DateTime::from_timestamp_millis)
        .ok_or_else(|| invalid("Calendar cursor is outside the supported UTC range"))
}
fn civil(value: IcalRecurDateTime) -> Result<NaiveDateTime, Failure> {
    NaiveDate::from_ymd_opt(value.year, value.month.into(), value.day.into())
        .and_then(|d| d.and_hms_opt(value.hour.into(), value.minute.into(), value.second.into()))
        .ok_or_else(|| invalid("Invalid civil calendar date; leap seconds are unsupported"))
}

pub fn evaluate(query: Query) -> Answer {
    match query.schedule {
        Schedule::Once { at } => {
            if at.len() > 64 {
                return Err(invalid("Once time must be RFC3339 with an explicit offset"));
            }
            let at = DateTime::parse_from_rfc3339(&at)
                .ok()
                .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
                .ok_or_else(|| invalid("Once time must be RFC3339 after the Unix epoch"))?;
            Ok(Window {
                previous: (at <= query.after).then_some(at),
                next: (at > query.after).then_some(at),
            })
        }
        Schedule::Cron {
            expression,
            time_zone,
        } => {
            if expression.len() > 256 || expression.split_whitespace().count() != 5 {
                return Err(invalid(
                    "Use five cron fields: minute hour day month weekday",
                ));
            }
            let zone = zone(&time_zone)?;
            let cron: Cron = expression
                .parse()
                .map_err(|_| invalid("Invalid five-field cron expression"))?;
            // Search civil time in a fixed-offset clock: the cron engine must
            // not normalize nonexistent wall times to a nonmatching time.
            let local = utc(query.after)?
                .with_timezone(&zone)
                .naive_local()
                .and_utc();
            let previous_start = match zone.from_local_datetime(&local.naive_utc()) {
                LocalResult::Ambiguous(a, b) => {
                    local + chrono::Duration::seconds((a.timestamp() - b.timestamp()).abs())
                }
                _ => local,
            };
            let mut cursor = previous_start;
            let mut previous = None;
            for index in 0..4096 {
                let before = cron
                    .find_previous_occurrence(&cursor, index == 0)
                    .map_err(|_| {
                        invalid("No previous cron occurrence in the supported date range")
                    })?;
                if let Some(at) = instant(zone, before.naive_utc()).filter(|at| *at <= query.after)
                {
                    previous = Some(at);
                    break;
                }
                cursor = before;
            }
            if previous.is_none() {
                return Err(limit());
            }
            let mut cursor = local;
            for _ in 0..4096 {
                let next = cron.find_next_occurrence(&cursor, false).map_err(|_| {
                    invalid("No cron occurrence in the engine's supported date range")
                })?;
                if let Some(at) = instant(zone, next.naive_utc()).filter(|at| *at > query.after) {
                    return Ok(Window {
                        previous,
                        next: Some(at),
                    });
                }
                cursor = next;
            }
            Err(limit())
        }
        Schedule::Rrule {
            rule,
            start,
            time_zone,
        } => rrule(&rule, &start, &time_zone, query.after),
    }
}

fn rrule(text: &str, start: &str, time_zone: &str, after: u64) -> Answer {
    if text.is_empty() || text.len() > 1024 || !text.is_ascii() || start.len() != 19 {
        return Err(invalid(
            "Use an RRULE within 1024 ASCII bytes and local start YYYY-MM-DDTHH:MM:SS",
        ));
    }
    // The upstream parser intentionally ignores unknown/duplicate parts.
    // Scheduling rejects them rather than accepting a different user intent.
    let mut seen = BTreeSet::new();
    for part in text.split(';') {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| invalid("Invalid RRULE part"))?;
        if !matches!(
            key,
            "FREQ"
                | "UNTIL"
                | "COUNT"
                | "INTERVAL"
                | "BYSECOND"
                | "BYMINUTE"
                | "BYHOUR"
                | "BYDAY"
                | "BYMONTHDAY"
                | "BYYEARDAY"
                | "BYWEEKNO"
                | "BYMONTH"
                | "BYSETPOS"
                | "WKST"
        ) || !seen.insert(key)
        {
            return Err(invalid(
                "Unsupported or duplicate RRULE part; use uppercase RFC5545 parts",
            ));
        }
        if key == "UNTIL" && (value.len() != 16 || !value.ends_with('Z')) {
            return Err(invalid("Zoned RRULE UNTIL must be UTC YYYYMMDDTHHMMSSZ"));
        }
    }
    let mut rule = IcalRecurRule::parse(text).map_err(|_| invalid("Invalid RRULE"))?;
    if !rule.problems().is_empty()
        || rule.freq == IcalRecurFreq::Secondly
        || rule.by_second.contains(&60)
        || rule.count.is_some_and(|n| n > 10_000)
    {
        return Err(invalid(
            "Invalid or unsupported RRULE: minimum frequency is MINUTELY, COUNT at most 10000, no leap seconds",
        ));
    }
    let days = match rule.freq {
        IcalRecurFreq::Yearly => 366,
        IcalRecurFreq::Monthly => 31,
        IcalRecurFreq::Weekly => 7,
        _ => 1,
    };
    let period_candidates = days
        * rule.by_hour.len().max(1)
        * rule.by_minute.len().max(1)
        * rule.by_second.len().max(1);
    if period_candidates > 100_000 {
        return Err(limit());
    }
    let zone = zone(time_zone)?;
    let start = NaiveDateTime::parse_from_str(start, "%Y-%m-%dT%H:%M:%S")
        .map_err(|_| invalid("Invalid RRULE start"))?;
    if instant(zone, start).is_none() {
        return Err(invalid(
            "RRULE start must name an existing time after the Unix epoch",
        ));
    }
    let count = rule.count.take();
    let until = rule
        .until
        .take()
        .map(civil)
        .transpose()?
        .map(|t| t.and_utc().timestamp_millis());
    let mut anchor = IcalRecurDateTime::from_seconds(start.and_utc().timestamp());
    // Exact seek for unbounded rules whose only parts are FREQ/INTERVAL.
    // Other rules keep DTSTART's expansion defaults and fail explicitly if
    // the candidate budget is reached; never report a truncated rule as ended.
    if count.is_none()
        && seen
            .iter()
            .all(|key| matches!(*key, "FREQ" | "INTERVAL" | "UNTIL"))
    {
        let unit = match rule.freq {
            IcalRecurFreq::Minutely => Some(60),
            IcalRecurFreq::Hourly => Some(3600),
            IcalRecurFreq::Daily => Some(86400),
            IcalRecurFreq::Weekly => Some(604800),
            _ => None,
        };
        if let Some(unit) = unit {
            let step = unit * i64::from(rule.interval);
            let seek_after = until
                .and_then(|last| u64::try_from(last).ok())
                .map_or(after, |last| after.min(last));
            let delta = utc(seek_after)?
                .with_timezone(&zone)
                .naive_local()
                .and_utc()
                .timestamp()
                - anchor.seconds();
            let periods = (delta.div_euclid(step) - 2).max(0);
            anchor = IcalRecurDateTime::from_seconds(anchor.seconds() + periods * step);
        }
    }
    let mut emitted = 0;
    let mut previous = None;
    for candidate in IcalRecurExpand::new(rule, anchor).take(200_000) {
        let Some(at) = instant(zone, civil(candidate)?) else {
            continue;
        };
        if until.is_some_and(|last| at as i64 > last) || count.is_some_and(|n| emitted >= n) {
            return Ok(Window {
                previous,
                next: None,
            });
        }
        emitted += 1;
        if at > after {
            return Ok(Window {
                previous,
                next: Some(at),
            });
        }
        previous = Some(at);
        if count.is_some_and(|n| emitted >= n) {
            return Ok(Window {
                previous,
                next: None,
            });
        }
    }
    // The iterator can give up on barren periods as well as reach year 9999.
    // Neither is evidence that the requested finite recurrence was exhausted.
    Err(limit())
}

#[cfg(test)]
#[path = "job_calendar_tests.rs"]
mod tests;
