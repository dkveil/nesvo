use super::*;
use serde_json::json;

fn ms(s: &str) -> u64 {
    DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis() as u64
}
fn query(schedule: serde_json::Value, after: &str) -> Answer {
    evaluate(Query {
        schedule: serde_json::from_value(schedule).unwrap(),
        after: ms(after),
    })
}
fn cron(expression: &str) -> serde_json::Value {
    json!({"kind":"cron","expression":expression})
}
fn rule(rule: &str, start: &str) -> serde_json::Value {
    json!({"kind":"rrule","rule":rule,"start":start})
}
fn next(schedule: serde_json::Value, after: &str, expected: &str) {
    assert_eq!(query(schedule, after).unwrap().next, Some(ms(expected)));
}

#[test]
fn cron_wall_time_skips_gap_and_uses_only_first_fold() {
    next(
        cron("30 2 * * *"),
        "2027-03-28T00:00:00Z",
        "2027-03-29T02:30:00+02:00",
    );
    next(
        cron("30 2 * * *"),
        "2026-10-25T00:00:00Z",
        "2026-10-25T02:30:00+02:00",
    );
    next(
        cron("30 2 * * *"),
        "2026-10-25T02:30:00+02:00",
        "2026-10-26T02:30:00+01:00",
    );
    next(
        cron("30 2 * * *"),
        "2026-10-25T02:15:00+01:00",
        "2026-10-26T02:30:00+01:00",
    );
    let window = query(cron("* * * * *"), "2026-10-25T02:15:00+01:00").unwrap();
    assert_eq!(window.previous, Some(ms("2026-10-25T02:59:00+02:00")));
    assert_eq!(window.next, Some(ms("2026-10-25T03:00:00+01:00")));
}
#[test]
fn count_counts_existing_instants_and_until_is_utc_inclusive() {
    let schedule = rule("FREQ=DAILY;COUNT=5", "2027-03-26T02:30:00");
    next(
        schedule.clone(),
        "2027-03-27T02:30:00+01:00",
        "2027-03-29T02:30:00+02:00",
    );
    next(
        schedule.clone(),
        "2027-03-30T02:30:00+02:00",
        "2027-03-31T02:30:00+02:00",
    );
    let exhausted = query(schedule, "2027-03-31T02:30:00+02:00").unwrap();
    assert!(exhausted.next.is_none());
    assert_eq!(exhausted.previous, Some(ms("2027-03-31T02:30:00+02:00")));
    let schedule = rule("FREQ=DAILY;UNTIL=20270329T003000Z", "2027-03-26T02:30:00");
    next(
        schedule.clone(),
        "2027-03-27T01:30:00Z",
        "2027-03-29T00:30:00Z",
    );
    assert!(
        query(schedule, "2027-03-29T00:30:00Z")
            .unwrap()
            .next
            .is_none()
    );
}
#[test]
fn rrule_fold_has_one_instant_and_invalid_monthdays_are_not_counted() {
    let schedule = rule("FREQ=DAILY;COUNT=3", "2026-10-24T02:30:00");
    next(
        schedule.clone(),
        "2026-10-24T02:30:00+02:00",
        "2026-10-25T02:30:00+02:00",
    );
    next(
        schedule,
        "2026-10-25T02:30:00+02:00",
        "2026-10-26T02:30:00+01:00",
    );
    next(
        rule("FREQ=MONTHLY;COUNT=3", "2027-01-31T09:00:00"),
        "2027-01-31T09:00:00+01:00",
        "2027-03-31T09:00:00+02:00",
    );
}
#[test]
fn ordinal_weekdays_and_expansion_remain_anchored_to_original_start() {
    next(
        rule("FREQ=MONTHLY;BYDAY=-1FR", "2026-01-01T09:15:00"),
        "2026-10-20T00:00:00Z",
        "2026-10-30T09:15:00+01:00",
    );
    next(
        rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-10-05T09:00:00"),
        "2026-10-07T09:00:00+02:00",
        "2026-10-19T09:00:00+02:00",
    );
}
#[test]
fn fast_seek_for_old_dense_rule_and_timezone_are_explicit() {
    next(
        rule("FREQ=MINUTELY;INTERVAL=7", "1970-01-02T00:00:00"),
        "2026-10-20T12:00:00Z",
        "2026-10-20T14:01:00+02:00",
    );
    next(
        json!({"kind":"cron","expression":"0 9 * * *","timeZone":"America/New_York"}),
        "2026-10-20T00:00:00Z",
        "2026-10-20T13:00:00Z",
    );
}
#[test]
fn unsupported_ambiguous_or_large_rules_are_not_silently_rewritten() {
    for schedule in [
        cron("0 0 0 * * *"),
        json!({"kind":"cron","expression":"* * * * *","timeZone":"Mars/Olympus"}),
        rule("FREQ=SECONDLY", "2026-10-20T09:00:00"),
        rule(
            "FREQ=DAILY;COUNT=1;UNTIL=20270101T000000Z",
            "2026-10-20T09:00:00",
        ),
        rule("FREQ=DAILY;UNTIL=20270101T000000", "2026-10-20T09:00:00"),
        rule("FREQ=DAILY;COUNT=10001", "2026-10-20T09:00:00"),
        rule("FREQ=DAILY;FREQ=WEEKLY", "2026-10-20T09:00:00"),
        rule("FREQ=DAILY;RSCALE=HEBREW", "2026-10-20T09:00:00"),
        rule("FREQ=DAILY;BYSECOND=60", "2026-10-20T09:00:00"),
        rule("FREQ=DAILY", "2027-03-28T02:30:00"),
    ] {
        assert!(query(schedule, "2026-10-20T00:00:00Z").is_err());
    }
    let blocked = query(
        rule("FREQ=MINUTELY;BYSECOND=0", "1970-01-02T00:00:00"),
        "2026-10-20T00:00:00Z",
    )
    .unwrap_err();
    assert_eq!(blocked.code, "calendar_limit");
}

#[test]
fn interval_seek_preserves_the_full_window_across_both_dst_transitions() {
    // Redundant BYSECOND=0 keeps the same rule semantics while selecting the
    // full original-anchor walk instead of the optimized simple-rule seek.
    for frequency in ["MINUTELY", "HOURLY", "DAILY", "WEEKLY"] {
        for (start, after) in [
            ("2027-03-01T02:30:00", "2027-03-28T03:15:00+02:00"),
            ("2026-10-01T02:30:00", "2026-10-25T02:15:00+01:00"),
            ("2026-10-01T02:30:00", "2026-10-25T02:15:00+02:00"),
        ] {
            for interval in [1, 3, 7] {
                let text = format!("FREQ={frequency};INTERVAL={interval}");
                let seek = query(rule(&text, start), after).unwrap();
                let walk = query(rule(&format!("{text};BYSECOND=0"), start), after).unwrap();
                assert_eq!(
                    (seek.previous, seek.next),
                    (walk.previous, walk.next),
                    "{text} {start} {after}"
                );
            }
        }
    }
    for frequency in ["MINUTELY", "HOURLY", "DAILY", "WEEKLY"] {
        let text = format!("FREQ={frequency};INTERVAL=3;UNTIL=20261025T003000Z");
        let seek = query(rule(&text, "2026-10-01T02:30:00"), "2026-11-10T00:00:00Z").unwrap();
        let walk = query(
            rule(&format!("{text};BYSECOND=0"), "2026-10-01T02:30:00"),
            "2026-11-10T00:00:00Z",
        )
        .unwrap();
        assert_eq!(
            (seek.previous, seek.next),
            (walk.previous, walk.next),
            "Expired {text}"
        );
    }
}
