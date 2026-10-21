const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAY_MS: i64 = 86_400_000;

struct WallClock {
    year: i64,
    month: u32,
    day: u32,
    hour: i64,
    minute: i64,
}

fn civil_date(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}

fn wall_clock(epoch_ms: i64, offset_minutes: i32) -> WallClock {
    let local = epoch_ms + i64::from(offset_minutes) * 60_000;
    let (year, month, day) = civil_date(local.div_euclid(DAY_MS));
    let minutes = local.rem_euclid(DAY_MS) / 60_000;
    WallClock {
        year,
        month,
        day,
        hour: minutes / 60,
        minute: minutes % 60,
    }
}

fn local_day(epoch_ms: i64, offset_minutes: i32) -> i64 {
    (epoch_ms + i64::from(offset_minutes) * 60_000).div_euclid(DAY_MS)
}

fn month_name(month: u32) -> &'static str {
    MONTHS[(month.clamp(1, 12) - 1) as usize]
}

pub fn offset_label(offset_minutes: i32) -> String {
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let magnitude = offset_minutes.unsigned_abs();
    format!("UTC{sign}{:02}:{:02}", magnitude / 60, magnitude % 60)
}

pub fn moment(epoch_ms: i64, now_ms: i64, offset_minutes: Option<i32>) -> String {
    let offset = offset_minutes.unwrap_or(0);
    let clock = wall_clock(epoch_ms, offset);
    let time = format!("{:02}:{:02}", clock.hour, clock.minute);
    let label = match local_day(epoch_ms, offset) - local_day(now_ms, offset) {
        0 => format!("Today {time}"),
        1 => format!("Tomorrow {time}"),
        -1 => format!("Yesterday {time}"),
        _ if clock.year == wall_clock(now_ms, offset).year => {
            format!("{} {} {time}", clock.day, month_name(clock.month))
        }
        _ => format!(
            "{} {} {} {time}",
            clock.day,
            month_name(clock.month),
            clock.year
        ),
    };
    if offset_minutes.is_some() {
        label
    } else {
        format!("{label} UTC")
    }
}

struct Instant<'a> {
    date: &'a str,
    time: &'a str,
    offset_minutes: i32,
    offset: String,
}

fn instant(text: &str) -> Option<Instant<'_>> {
    let text = text.trim();
    let date = text.get(..10)?;
    let separator = text.get(10..11)?;
    let time = text.get(11..16)?;
    if !matches!(separator, "T" | "t" | " ") || !valid_date(date) || !valid_time(time) {
        return None;
    }
    let rest = text.get(16..)?.trim_start();
    let zone_start = rest.find(['Z', 'z', '+', '-'])?;
    if !rest[..zone_start]
        .trim_end()
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, ':' | '.'))
    {
        return None;
    }
    let zone = &rest[zone_start..];
    let offset_minutes = zone_offset(zone)?;
    let offset = if matches!(zone, "Z" | "z") {
        "+00:00".to_owned()
    } else {
        zone.to_owned()
    };
    Some(Instant {
        date,
        time,
        offset_minutes,
        offset,
    })
}

fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && date
            .chars()
            .enumerate()
            .all(|(index, c)| matches!(index, 4 | 7) || c.is_ascii_digit())
        && (1..=12).contains(&date[5..7].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&date[8..10].parse::<u32>().unwrap_or(0))
}

fn valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && time[..2].parse::<u32>().is_ok_and(|hour| hour < 24)
        && time[3..].parse::<u32>().is_ok_and(|minute| minute < 60)
}

fn zone_offset(zone: &str) -> Option<i32> {
    if matches!(zone, "Z" | "z") {
        return Some(0);
    }
    let sign = match zone.get(..1)? {
        "+" => 1,
        "-" => -1,
        _ => return None,
    };
    let digits = zone.get(1..)?;
    if digits.len() != 5 || digits.as_bytes()[2] != b':' {
        return None;
    }
    let hours = digits[..2]
        .parse::<i32>()
        .ok()
        .filter(|hours| *hours < 24)?;
    let minutes = digits[3..]
        .parse::<i32>()
        .ok()
        .filter(|minutes| *minutes < 60)?;
    Some(sign * (hours * 60 + minutes))
}

pub fn offset_of(at: &str) -> Option<i32> {
    instant(at).map(|instant| instant.offset_minutes)
}

pub fn once_label(at: &str) -> Option<String> {
    let instant = instant(at)?;
    let month = instant.date[5..7].parse::<u32>().ok()?;
    let day = instant.date[8..10].parse::<u32>().ok()?;
    Some(format!(
        "{day} {}, {} {}",
        month_name(month),
        instant.time,
        instant.offset
    ))
}

pub fn form_start(at: &str) -> String {
    instant(at).map_or_else(
        || at.to_owned(),
        |instant| format!("{} {} {}", instant.date, instant.time, instant.offset),
    )
}

pub fn rfc3339(input: &str) -> Option<String> {
    let instant = instant(input)?;
    Some(format!(
        "{}T{}:00{}",
        instant.date, instant.time, instant.offset
    ))
}

pub fn duration_label(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    let (value, unit) = if seconds.is_multiple_of(3600) && seconds >= 3600 {
        (seconds / 3600, "hour")
    } else if seconds.is_multiple_of(60) && seconds >= 60 {
        (seconds / 60, "minute")
    } else {
        (seconds, "second")
    };
    format!("{value} {unit}{}", if value == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_792_540_800_000;

    #[test]
    fn civil_dates_match_known_epochs() {
        assert_eq!(civil_date(0), (1970, 1, 1));
        assert_eq!(civil_date(NOW / DAY_MS), (2026, 10, 21));
        assert_eq!(civil_date(-1), (1969, 12, 31));
    }

    #[test]
    fn moments_are_relative_to_the_schedule_offset() {
        let due = NOW + 14 * 3_600_000 + 2 * 60_000;
        assert_eq!(moment(due, NOW, Some(120)), "Today 16:02");
        assert_eq!(moment(due, NOW, None), "Today 14:02 UTC");
        assert_eq!(moment(due + DAY_MS, NOW, Some(120)), "Tomorrow 16:02");
        assert_eq!(moment(due - DAY_MS, NOW, Some(120)), "Yesterday 16:02");
        assert_eq!(moment(due + 3 * DAY_MS, NOW, Some(120)), "24 Oct 16:02");
        assert_eq!(
            moment(due + 400 * DAY_MS, NOW, Some(120)),
            "25 Nov 2027 16:02"
        );
    }

    #[test]
    fn explicit_offsets_round_trip_between_form_and_wire() {
        assert_eq!(
            rfc3339("2026-10-22 16:02 +02:00").as_deref(),
            Some("2026-10-22T16:02:00+02:00")
        );
        assert_eq!(
            rfc3339("2026-10-22T14:02:00.0000000Z").as_deref(),
            Some("2026-10-22T14:02:00+00:00")
        );
        assert_eq!(
            form_start("2026-10-22T16:02:00+02:00"),
            "2026-10-22 16:02 +02:00"
        );
        assert_eq!(
            once_label("2026-10-22T16:02:00+02:00").as_deref(),
            Some("22 Oct, 16:02 +02:00")
        );
        assert_eq!(offset_of("2026-10-22T16:02:00-05:30"), Some(-330));
        for invalid in [
            "2026-10-22 16:02",
            "16:02",
            "2026-13-22 16:02 +02:00",
            "2026-10-22 25:02 +02:00",
            "2026-10-22 16:02 Europe/Warsaw",
        ] {
            assert_eq!(rfc3339(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn durations_use_the_largest_exact_unit() {
        assert_eq!(duration_label(300_000), "5 minutes");
        assert_eq!(duration_label(3_600_000), "1 hour");
        assert_eq!(duration_label(90_000), "90 seconds");
        assert_eq!(offset_label(120), "UTC+02:00");
        assert_eq!(offset_label(-330), "UTC-05:30");
    }
}
