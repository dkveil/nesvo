use super::*;
use serde_json::json;

const WALK: Search = Search {
    walk: 5_000_000,
    period: RRULE_PERIOD,
    wanted: 1,
    seek: false,
};

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
    let barren = query(
        json!({"kind":"rrule","rule":"FREQ=MINUTELY;BYSECOND=0;BYSETPOS=2","start":"2026-01-01T00:00:00","timeZone":"UTC"}),
        "2026-10-20T00:00:00Z",
    )
    .unwrap_err();
    assert_eq!(barren.code, "calendar_limit");
}

fn zoned(text: &str, start: &str, zone: &str) -> serde_json::Value {
    json!({"kind":"rrule","rule":text,"start":start,"timeZone":zone})
}
fn search(text: &str, start: &str, zone: &str, after: u64, search: Search) -> Found {
    rrule(text, start, zone, after, search).unwrap()
}
fn window(text: &str, start: &str, zone: &str, after: &str) -> (Option<u64>, Option<u64>) {
    let window = query(zoned(text, start, zone), after).unwrap();
    (window.previous, window.next)
}
fn oracle(text: &str, start: &str, zone: &str, after: &str) -> (Option<u64>, Option<u64>) {
    let found = search(text, start, zone, ms(after), WALK);
    (found.previous, found.upcoming.first().copied())
}
fn upcoming(text: &str, start: &str, zone: &str, after: &str, wanted: usize) -> Vec<u64> {
    search(text, start, zone, ms(after), Search { wanted, ..NEXT }).upcoming
}
fn instants(values: &[&str]) -> Vec<u64> {
    values.iter().map(|value| ms(value)).collect()
}
fn query_at(schedule: serde_json::Value, after: u64) -> Window {
    evaluate(Query {
        schedule: serde_json::from_value(schedule).unwrap(),
        after,
    })
    .unwrap()
}

struct Case<'a> {
    rule: &'a str,
    old: &'a str,
    recent: &'a str,
    zone: &'a str,
    after: &'a str,
    previous: &'a str,
    next: &'a str,
}
fn check(case: Case) {
    let expected = (Some(ms(case.previous)), Some(ms(case.next)));
    assert_eq!(
        window(case.rule, case.old, case.zone, case.after),
        expected,
        "{} {}",
        case.rule,
        case.after
    );
    assert_eq!(
        oracle(case.rule, case.recent, case.zone, case.after),
        expected,
        "walk {} {}",
        case.rule,
        case.after
    );
}

#[test]
fn interval_seek_preserves_the_full_window_across_both_dst_transitions() {
    for frequency in ["MINUTELY", "HOURLY", "DAILY", "WEEKLY"] {
        for (start, after) in [
            ("2027-03-01T02:30:00", "2027-03-28T03:15:00+02:00"),
            ("2026-10-01T02:30:00", "2026-10-25T02:15:00+01:00"),
            ("2026-10-01T02:30:00", "2026-10-25T02:15:00+02:00"),
        ] {
            for interval in [1, 3, 7] {
                for text in [
                    format!("FREQ={frequency};INTERVAL={interval}"),
                    format!("FREQ={frequency};INTERVAL={interval};BYSECOND=0"),
                ] {
                    assert_eq!(
                        window(&text, start, "Europe/Warsaw", after),
                        oracle(&text, start, "Europe/Warsaw", after),
                        "{text} {start} {after}"
                    );
                }
            }
        }
    }
    for frequency in ["MINUTELY", "HOURLY", "DAILY", "WEEKLY"] {
        let text = format!("FREQ={frequency};INTERVAL=3;UNTIL=20261025T003000Z");
        let after = "2026-11-10T00:00:00Z";
        assert_eq!(
            window(&text, "2026-10-01T02:30:00", "Europe/Warsaw", after),
            oracle(&text, "2026-10-01T02:30:00", "Europe/Warsaw", after),
            "Expired {text}"
        );
    }
}

#[test]
fn dense_rules_skip_the_warsaw_spring_gap_at_minute_and_hour_density() {
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=15;BYHOUR=1,2,3",
        old: "2020-01-01T00:00:00",
        recent: "2027-03-20T00:00:00",
        zone: "Europe/Warsaw",
        after: "2027-03-28T01:50:00+01:00",
        previous: "2027-03-28T01:45:00+01:00",
        next: "2027-03-28T03:00:00+02:00",
    });
    assert_eq!(
        upcoming(
            "FREQ=MINUTELY;INTERVAL=15;BYHOUR=1,2,3",
            "2020-01-01T00:00:00",
            "Europe/Warsaw",
            "2027-03-28T01:50:00+01:00",
            5
        ),
        instants(&[
            "2027-03-28T03:00:00+02:00",
            "2027-03-28T03:15:00+02:00",
            "2027-03-28T03:30:00+02:00",
            "2027-03-28T03:45:00+02:00",
            "2027-03-29T01:00:00+02:00",
        ])
    );
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0,30",
        old: "2020-01-01T00:00:00",
        recent: "2027-03-20T00:00:00",
        zone: "Europe/Warsaw",
        after: "2027-03-28T01:45:00+01:00",
        previous: "2027-03-28T01:30:00+01:00",
        next: "2027-03-28T03:00:00+02:00",
    });
    assert_eq!(
        upcoming(
            "FREQ=HOURLY;BYMINUTE=0,30",
            "2020-01-01T00:00:00",
            "Europe/Warsaw",
            "2027-03-28T01:45:00+01:00",
            3
        ),
        instants(&[
            "2027-03-28T03:00:00+02:00",
            "2027-03-28T03:30:00+02:00",
            "2027-03-28T04:00:00+02:00",
        ])
    );
}

#[test]
fn dense_rules_use_only_the_first_warsaw_fall_fold() {
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=20;BYHOUR=2",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-18T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-25T02:30:00+01:00",
        previous: "2026-10-25T02:40:00+02:00",
        next: "2026-10-26T02:00:00+01:00",
    });
    assert_eq!(
        upcoming(
            "FREQ=MINUTELY;INTERVAL=20;BYHOUR=2",
            "2020-01-01T00:00:00",
            "Europe/Warsaw",
            "2026-10-25T02:10:00+02:00",
            3
        ),
        instants(&[
            "2026-10-25T02:20:00+02:00",
            "2026-10-25T02:40:00+02:00",
            "2026-10-26T02:00:00+01:00",
        ])
    );
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0,30",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-18T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-25T02:45:00+02:00",
        previous: "2026-10-25T02:30:00+02:00",
        next: "2026-10-25T03:00:00+01:00",
    });
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0,30",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-18T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-25T02:15:00+01:00",
        previous: "2026-10-25T02:30:00+02:00",
        next: "2026-10-25T03:00:00+01:00",
    });
}

#[test]
fn dense_rules_follow_new_york_gap_and_fold() {
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=15",
        old: "2020-01-01T00:15:00",
        recent: "2027-03-07T00:15:00",
        zone: "America/New_York",
        after: "2027-03-14T01:30:00-05:00",
        previous: "2027-03-14T01:15:00-05:00",
        next: "2027-03-14T03:15:00-04:00",
    });
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=30;BYHOUR=2,3",
        old: "2020-01-01T00:00:00",
        recent: "2027-03-07T00:00:00",
        zone: "America/New_York",
        after: "2027-03-13T12:00:00Z",
        previous: "2027-03-13T03:30:00-05:00",
        next: "2027-03-14T03:00:00-04:00",
    });
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=30;BYHOUR=1",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-25T00:00:00",
        zone: "America/New_York",
        after: "2026-11-01T01:45:00-05:00",
        previous: "2026-11-01T01:30:00-04:00",
        next: "2026-11-02T01:00:00-05:00",
    });
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-25T00:00:00",
        zone: "America/New_York",
        after: "2026-11-01T01:30:00-05:00",
        previous: "2026-11-01T01:00:00-04:00",
        next: "2026-11-01T02:00:00-05:00",
    });
}

#[test]
fn dense_rules_honor_byday_bymonthday_and_far_previous_slots() {
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=30;BYDAY=MO;BYHOUR=9",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-12T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-21T00:00:00Z",
        previous: "2026-10-19T09:30:00+02:00",
        next: "2026-10-26T09:00:00+01:00",
    });
    check(Case {
        rule: "FREQ=HOURLY;INTERVAL=12;BYMONTHDAY=1",
        old: "2020-01-01T00:00:00",
        recent: "2026-09-01T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-21T00:00:00Z",
        previous: "2026-10-01T12:00:00+02:00",
        next: "2026-11-01T00:00:00+01:00",
    });
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=10;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0",
        old: "2020-01-01T00:00:00",
        recent: "2020-01-01T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-06-15T00:00:00Z",
        previous: "2026-01-01T00:50:00+01:00",
        next: "2027-01-01T00:00:00+01:00",
    });
    assert_eq!(
        window(
            "FREQ=MINUTELY;BYSECOND=0",
            "1970-01-02T00:00:00",
            "Europe/Warsaw",
            "2026-10-20T00:00:00Z"
        ),
        (
            Some(ms("2026-10-20T00:00:00Z")),
            Some(ms("2026-10-20T00:01:00Z"))
        )
    );
}

#[test]
fn negative_bysetpos_selects_from_the_end_of_each_period() {
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0,20,40;BYSETPOS=-1",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-19T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-20T12:50:00+02:00",
        previous: "2026-10-20T12:40:00+02:00",
        next: "2026-10-20T13:40:00+02:00",
    });
    assert_eq!(
        upcoming(
            "FREQ=HOURLY;BYMINUTE=0,20,40;BYSETPOS=1,-2",
            "2020-01-01T00:00:00",
            "Europe/Warsaw",
            "2026-10-20T12:50:00+02:00",
            3
        ),
        instants(&[
            "2026-10-20T13:00:00+02:00",
            "2026-10-20T13:20:00+02:00",
            "2026-10-20T14:00:00+02:00",
        ])
    );
    check(Case {
        rule: "FREQ=MINUTELY;INTERVAL=5;BYSECOND=0,30;BYSETPOS=-1",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-20T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-20T12:00:00+02:00",
        previous: "2026-10-20T11:55:30+02:00",
        next: "2026-10-20T12:00:30+02:00",
    });
    check(Case {
        rule: "FREQ=HOURLY;BYMINUTE=0,30;BYSETPOS=-1",
        old: "2020-01-01T00:00:00",
        recent: "2026-10-18T00:00:00",
        zone: "Europe/Warsaw",
        after: "2026-10-25T02:15:00+01:00",
        previous: "2026-10-25T02:30:00+02:00",
        next: "2026-10-25T03:30:00+01:00",
    });
}

#[test]
fn count_and_until_terminate_dense_rules_after_dst_resolution() {
    let text = "FREQ=MINUTELY;INTERVAL=15;BYHOUR=2;COUNT=6";
    let start = "2027-03-27T00:00:00";
    assert_eq!(
        upcoming(text, start, "Europe/Warsaw", "2027-03-26T00:00:00Z", 64),
        instants(&[
            "2027-03-27T02:00:00+01:00",
            "2027-03-27T02:15:00+01:00",
            "2027-03-27T02:30:00+01:00",
            "2027-03-27T02:45:00+01:00",
            "2027-03-29T02:00:00+02:00",
            "2027-03-29T02:15:00+02:00",
        ])
    );
    assert_eq!(
        window(text, start, "Europe/Warsaw", "2027-03-29T02:15:00+02:00"),
        (Some(ms("2027-03-29T02:15:00+02:00")), None)
    );
    let text = "FREQ=HOURLY;BYMINUTE=0,30;UNTIL=20261025T003000Z";
    for start in ["2020-01-01T00:00:00", "2026-10-24T22:00:00"] {
        assert_eq!(
            window(text, start, "Europe/Warsaw", "2026-10-25T00:15:00Z"),
            (
                Some(ms("2026-10-25T00:00:00Z")),
                Some(ms("2026-10-25T00:30:00Z"))
            )
        );
        for after in ["2026-10-25T00:30:00Z", "2026-11-10T00:00:00Z"] {
            assert_eq!(
                window(text, start, "Europe/Warsaw", after),
                (Some(ms("2026-10-25T00:30:00Z")), None),
                "{start} {after}"
            );
        }
    }
    assert_eq!(
        upcoming(
            text,
            "2020-01-01T00:00:00",
            "Europe/Warsaw",
            "2026-10-24T23:15:00Z",
            64
        ),
        instants(&[
            "2026-10-24T23:30:00Z",
            "2026-10-25T00:00:00Z",
            "2026-10-25T00:30:00Z",
        ])
    );
}

#[test]
fn dense_search_refuses_with_its_bound_instead_of_looping() {
    let list = |count: u8| {
        (0..count)
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    let wide = format!(
        "FREQ=WEEKLY;BYHOUR={};BYMINUTE={};BYSECOND={}",
        list(24),
        list(60),
        list(60)
    );
    let refused = query(
        zoned(&wide, "2026-10-19T00:00:00", "Europe/Warsaw"),
        "2026-10-20T00:00:00Z",
    )
    .unwrap_err();
    assert_eq!(refused.code, "schedule_too_dense");
    assert!(refused.message.contains("100000 candidates per period"));
    let monthly = format!(
        "FREQ=MONTHLY;BYMONTHDAY=1,2,3;BYHOUR={};BYMINUTE={}",
        list(24),
        list(60)
    );
    let refused = query(
        zoned(&monthly, "2020-01-01T00:00:00", "Europe/Warsaw"),
        "2026-10-20T00:00:00Z",
    )
    .unwrap_err();
    assert_eq!(refused.code, "schedule_too_dense");
    assert!(refused.message.contains("200000 candidates"));
    let refused = rrule(
        "FREQ=MINUTELY;COUNT=100",
        "2026-10-20T00:00:00",
        "Europe/Warsaw",
        ms("2026-10-21T00:00:00Z"),
        Search { walk: 10, ..NEXT },
    )
    .unwrap_err();
    assert_eq!(refused.code, "schedule_too_dense");
    assert!(refused.message.contains("bound of 10 candidates"));
    let capped = search(
        "FREQ=MINUTELY",
        "2026-10-20T00:00:00",
        "UTC",
        ms("2026-10-20T00:00:00Z"),
        Search {
            wanted: 1000,
            ..NEXT
        },
    );
    assert_eq!(capped.upcoming.len(), RRULE_UPCOMING);
}

#[test]
fn successive_seeks_strictly_increase_and_match_the_full_walk() {
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut draw = |bound: u64| {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % bound
    };
    let transitions = [
        ("Europe/Warsaw", "2027-03-28", "2027-03-25", "2025-04-24"),
        ("Europe/Warsaw", "2026-10-25", "2026-10-22", "2024-11-21"),
        ("America/New_York", "2027-03-14", "2027-03-11", "2025-04-10"),
        ("America/New_York", "2026-11-01", "2026-10-29", "2024-11-28"),
    ];
    for case in 0..48 {
        let (zone, day, recent, old) = transitions[case % transitions.len()];
        let hourly = draw(2) == 0;
        let interval = draw(4) + 1;
        let mut parts = vec![format!(
            "FREQ={};INTERVAL={interval}",
            if hourly { "HOURLY" } else { "MINUTELY" }
        )];
        if draw(2) == 0 {
            let stride = if hourly { interval } else { 1 };
            parts.push(format!(
                "BYHOUR={},{}",
                stride * draw(4 / stride + 1),
                stride * draw(24 / stride)
            ));
        }
        let minutes = draw(3) as usize;
        if hourly && minutes > 0 {
            let picked: Vec<_> = [0u8, 15, 30, 45, 59]
                .iter()
                .take(minutes + 1)
                .map(u8::to_string)
                .collect();
            parts.push(format!("BYMINUTE={}", picked.join(",")));
            if draw(2) == 0 {
                parts.push(format!(
                    "BYSETPOS={}",
                    if draw(2) == 0 { "-1" } else { "1,-2" }
                ));
            }
        }
        if draw(3) == 0 {
            parts.push("BYDAY=SU,MO".into());
        }
        let text = parts.join(";");
        let first = format!("{day}T00:00:00Z");
        let recent = format!("{recent}T00:00:00");
        let old = format!("{old}T00:00:00");
        let walked = search(
            &text,
            &recent,
            zone,
            ms(&first),
            Search { wanted: 40, ..WALK },
        );
        assert_eq!(walked.upcoming.len(), 40, "{text} {zone}");
        assert_eq!(
            upcoming(&text, &old, zone, &first, 40),
            walked.upcoming,
            "{text} {zone}"
        );
        let mut after = ms(&first);
        for (index, expected) in walked.upcoming.iter().enumerate() {
            let window = query_at(zoned(&text, &old, zone), after);
            let next = window.next.unwrap();
            assert!(next > after, "{text} {zone}");
            assert_eq!(next, *expected, "{text} {zone}");
            if index > 0 {
                assert_eq!(window.previous, Some(after), "{text} {zone}");
            }
            after = next;
        }
    }
}
