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
    External,
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
fn earliest_instant(zone: Tz, local: NaiveDateTime) -> Option<u64> {
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
        Schedule::External => Ok(Window {
            previous: None,
            next: None,
        }),
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
                if let Some(at) =
                    earliest_instant(zone, before.naive_utc()).filter(|at| *at <= query.after)
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
                if let Some(at) =
                    earliest_instant(zone, next.naive_utc()).filter(|at| *at > query.after)
                {
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
        } => rrule(&rule, &start, &time_zone, query.after, NEXT).map(|found| Window {
            previous: found.previous,
            next: found.upcoming.first().copied(),
        }),
    }
}

const RRULE_WALK: usize = 200_000;
const RRULE_PERIOD: usize = 100_000;
const RRULE_UPCOMING: usize = 64;

#[derive(Clone, Copy)]
struct Search {
    walk: usize,
    period: usize,
    wanted: usize,
    seek: bool,
}
const NEXT: Search = Search {
    walk: RRULE_WALK,
    period: RRULE_PERIOD,
    wanted: 1,
    seek: true,
};

#[derive(Debug, Default)]
struct Found {
    previous: Option<u64>,
    upcoming: Vec<u64>,
}

struct Plan {
    rule: IcalRecurRule,
    start: i64,
    zone: Tz,
    count: Option<u32>,
    until: Option<i64>,
    step: Option<i64>,
}

fn too_dense(search: &Search) -> Failure {
    Failure {
        code: "schedule_too_dense".into(),
        message: format!(
            "RRULE search exceeded its bound of {} candidates or {} candidates per period; re-anchor the start or reduce the rule's density",
            search.walk, search.period
        ),
    }
}

fn local_seconds(zone: Tz, value: u64) -> Result<i64, Failure> {
    Ok(utc(value)?
        .with_timezone(&zone)
        .naive_local()
        .and_utc()
        .timestamp())
}

fn expansion(plan: &Plan, anchor: i64) -> IcalRecurExpand {
    IcalRecurExpand::new(plan.rule.clone(), IcalRecurDateTime::from_seconds(anchor))
}

fn rrule(
    text: &str,
    start: &str,
    time_zone: &str,
    after: u64,
    search: Search,
) -> Result<Found, Failure> {
    let plan = plan(text, start, time_zone, &search)?;
    let wanted = search.wanted.clamp(1, RRULE_UPCOMING);
    let mut budget = search.walk;
    let Some(step) = plan.step else {
        return walk(&plan, plan.start, after, wanted, &mut budget, &search);
    };
    let bound = plan
        .until
        .and_then(|last| u64::try_from(last).ok())
        .map_or(after, |last| after.min(last));
    let lattice = ((local_seconds(plan.zone, bound)? - plan.start).div_euclid(step) - 2).max(0);
    let found = walk(
        &plan,
        plan.start + lattice * step,
        after,
        wanted,
        &mut budget,
        &search,
    )?;
    if found.previous.is_some()
        || lattice == 0
        || !probe(&plan, plan.start, bound, &mut budget, &search)?
    {
        return Ok(found);
    }
    let (mut low, mut high) = (0, lattice);
    for _ in 0..64 {
        if high - low <= 1 {
            break;
        }
        let middle = low + (high - low) / 2;
        if probe(
            &plan,
            plan.start + middle * step,
            bound,
            &mut budget,
            &search,
        )? {
            low = middle;
        } else {
            high = middle;
        }
    }
    let previous = walk(
        &plan,
        plan.start + low * step,
        after,
        1,
        &mut budget,
        &search,
    )?
    .previous;
    Ok(Found { previous, ..found })
}

fn walk(
    plan: &Plan,
    anchor: i64,
    after: u64,
    wanted: usize,
    budget: &mut usize,
    search: &Search,
) -> Result<Found, Failure> {
    let mut found = Found::default();
    let mut emitted = 0;
    let allowed = *budget;
    for candidate in expansion(plan, anchor).take(allowed) {
        *budget -= 1;
        let Some(at) = earliest_instant(plan.zone, civil(candidate)?) else {
            continue;
        };
        if plan.until.is_some_and(|last| at as i64 > last)
            || plan.count.is_some_and(|n| emitted >= n)
        {
            return Ok(found);
        }
        emitted += 1;
        if at > after {
            found.upcoming.push(at);
            if found.upcoming.len() >= wanted {
                return Ok(found);
            }
        } else {
            found.previous = Some(at);
        }
        if plan.count.is_some_and(|n| emitted >= n) {
            return Ok(found);
        }
    }
    Err(if *budget == 0 {
        too_dense(search)
    } else {
        limit()
    })
}

fn probe(
    plan: &Plan,
    anchor: i64,
    bound: u64,
    budget: &mut usize,
    search: &Search,
) -> Result<bool, Failure> {
    let allowed = *budget;
    for candidate in expansion(plan, anchor).take(allowed) {
        *budget -= 1;
        if let Some(at) = earliest_instant(plan.zone, civil(candidate)?) {
            return Ok(at <= bound);
        }
    }
    Err(if *budget == 0 {
        too_dense(search)
    } else {
        limit()
    })
}

fn validate_rrule_parts_strictly(text: &str) -> Result<(), Failure> {
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
    Ok(())
}

fn plan(text: &str, start: &str, time_zone: &str, search: &Search) -> Result<Plan, Failure> {
    if text.is_empty() || text.len() > 1024 || !text.is_ascii() || start.len() != 19 {
        return Err(invalid(
            "Use an RRULE within 1024 ASCII bytes and local start YYYY-MM-DDTHH:MM:SS",
        ));
    }
    validate_rrule_parts_strictly(text)?;
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
    if period_candidates > search.period {
        return Err(too_dense(search));
    }
    let zone = zone(time_zone)?;
    let start = NaiveDateTime::parse_from_str(start, "%Y-%m-%dT%H:%M:%S")
        .map_err(|_| invalid("Invalid RRULE start"))?;
    if earliest_instant(zone, start).is_none() {
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
    let unit = match rule.freq {
        IcalRecurFreq::Minutely => Some(60),
        IcalRecurFreq::Hourly => Some(3600),
        IcalRecurFreq::Daily => Some(86400),
        IcalRecurFreq::Weekly => Some(604800),
        _ => None,
    };
    let step = unit
        .filter(|_| search.seek && count.is_none())
        .map(|unit| unit * i64::from(rule.interval))
        .filter(|step| *step > 0);
    Ok(Plan {
        rule,
        start: start.and_utc().timestamp(),
        zone,
        count,
        until,
        step,
    })
}

#[cfg(test)]
#[path = "job_calendar_tests.rs"]
mod tests;
