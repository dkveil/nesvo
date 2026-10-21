use crate::{launch::Program, model::App};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub const MIN_WIDTH: u16 = 100;
pub const SESSION_COLUMN_WIDTH: u16 = 120;
pub const POLL: Duration = Duration::from_secs(60);
pub const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct UsagePanel {
    pub width: u16,
    toggled: Option<bool>,
    in_flight: Option<(String, Instant)>,
    requested_at: Option<Instant>,
    detail: Option<Detail>,
    refusal: Option<String>,
    clock: Option<(Instant, u64)>,
    drawn: Vec<String>,
}

struct Detail {
    views: Vec<View>,
    received: Instant,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Window {
    used_percent: u8,
    duration_mins: u32,
    #[serde(default)]
    resets_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct View {
    program: Program,
    #[serde(default)]
    source: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    freshness: String,
    #[serde(default)]
    age_ms: Option<u64>,
    #[serde(default)]
    windows: Vec<Window>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Warning,
    Danger,
    Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowCell {
    pub text: String,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderLine {
    pub program: Program,
    pub windows: Vec<WindowCell>,
    pub detail: String,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub providers: Vec<ProviderLine>,
    pub wake: Option<String>,
    pub notice: Option<String>,
}

impl UsagePanel {
    pub fn shown(&self) -> bool {
        self.toggled.unwrap_or(self.width >= MIN_WIDTH)
    }

    pub fn toggle(&mut self) {
        self.toggled = Some(!self.shown());
    }

    pub fn observe_clock(&mut self, now: Instant, now_ms: u64) {
        self.clock = Some((now, now_ms));
    }
}

pub fn visible(app: &App) -> bool {
    app.overview.open && app.overview.usage.shown()
}

pub fn session_column(app: &App) -> bool {
    visible(app) && app.overview.usage.width >= SESSION_COLUMN_WIDTH
}

fn detail_supported(app: &App) -> bool {
    app.host_features["providerQuotaObservations"] == true
}

pub fn tick(app: &mut App) -> Option<Value> {
    tick_at(app, Instant::now())
}

pub fn tick_at(app: &mut App, now: Instant) -> Option<Value> {
    let visible = visible(app);
    let ready = app.connected && detail_supported(app);
    let panel = &mut app.overview.usage;
    if panel
        .in_flight
        .as_ref()
        .is_some_and(|(_, sent)| now.saturating_duration_since(*sent) > TIMEOUT)
    {
        panel.in_flight = None;
        panel.refusal = Some("The host did not answer the quota read.".into());
    }
    if !visible {
        panel.requested_at = None;
        return None;
    }
    if !ready || panel.in_flight.is_some() {
        return None;
    }
    if panel
        .requested_at
        .is_some_and(|at| now.saturating_duration_since(at) < POLL)
    {
        return None;
    }
    let command = app.request(json!({"type":"getProviderQuota"}));
    let id = command["requestId"].as_str().unwrap_or_default().to_owned();
    let panel = &mut app.overview.usage;
    panel.in_flight = Some((id, now));
    panel.requested_at = Some(now);
    Some(command)
}

pub fn host_event(app: &mut App, event: &Value) -> bool {
    host_event_at(app, event, Instant::now())
}

pub fn host_event_at(app: &mut App, event: &Value, now: Instant) -> bool {
    let panel = &mut app.overview.usage;
    let matches = panel
        .in_flight
        .as_ref()
        .is_some_and(|(id, _)| event["requestId"].as_str() == Some(id.as_str()));
    if !matches {
        return false;
    }
    panel.in_flight = None;
    match event["type"].as_str() {
        Some("providerQuota") => {
            let views = event["providers"]
                .as_array()
                .map(|providers| {
                    providers
                        .iter()
                        .filter_map(|view| serde_json::from_value(view.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            panel.detail = Some(Detail {
                views,
                received: now,
            });
            panel.refusal = None;
        }
        _ => {
            if event["code"] == "forbidden" {
                panel.detail = None;
            }
            panel.refusal = Some(refusal(event));
        }
    }
    true
}

fn refusal(event: &Value) -> String {
    match event["code"].as_str() {
        Some("forbidden") => "Quota detail is owner-only; this connection may not read it.".into(),
        Some("busy") => "The host quota reader is busy; retrying in 60 s.".into(),
        _ => format!(
            "Quota detail refused: {}",
            event["message"].as_str().unwrap_or("unknown reason")
        ),
    }
}

pub fn redraw_needed(app: &mut App) -> bool {
    if !visible(app) {
        app.overview.usage.drawn.clear();
        return false;
    }
    let summary = summary(app);
    let mut drawn: Vec<String> = summary
        .providers
        .iter()
        .map(|line| {
            let windows: Vec<&str> = line.windows.iter().map(|cell| cell.text.as_str()).collect();
            format!("{} {}", windows.join(" "), line.detail)
        })
        .collect();
    drawn.extend(summary.wake);
    drawn.extend(summary.notice);
    let changed = drawn != app.overview.usage.drawn;
    app.overview.usage.drawn = drawn;
    changed
}

fn window_name(minutes: u32) -> String {
    if minutes.is_multiple_of(1440) {
        format!("{}d", minutes / 1440)
    } else if minutes.is_multiple_of(60) {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

fn age_label(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        crate::session_row::duration_label(seconds)
    }
}

fn percent_tone(percent: u8) -> Tone {
    match percent {
        90.. => Tone::Danger,
        75.. => Tone::Warning,
        _ => Tone::Normal,
    }
}

fn reset_label(resets_at: Option<i64>, now_ms: Option<u64>) -> String {
    let (Some(resets_at), Some(now_ms)) = (resets_at, now_ms) else {
        return String::new();
    };
    let reset_ms = u64::try_from(resets_at).unwrap_or(0).saturating_mul(1000);
    if reset_ms <= now_ms {
        " reset due".into()
    } else {
        format!(" resets in {}", age_label(reset_ms - now_ms))
    }
}

fn window_cells(windows: &[Window], now_ms: Option<u64>) -> Vec<WindowCell> {
    let mut windows = windows.to_vec();
    windows.sort_by_key(|window| window.duration_mins);
    windows
        .iter()
        .map(|window| WindowCell {
            text: format!(
                "{} {}%{}",
                window_name(window.duration_mins),
                window.used_percent,
                reset_label(window.resets_at, now_ms)
            ),
            tone: percent_tone(window.used_percent),
        })
        .collect()
}

fn source_label(source: &str, program: Program) -> &'static str {
    match (source, program) {
        ("codexAppServer", _) | ("", Program::Codex) => "Codex app-server",
        ("claudeStatusCache", _) | ("", Program::Claude) => "Claude statusline cache",
        _ => "no source",
    }
}

fn readable(reason: &str) -> String {
    reason.replace('_', " ")
}

fn unsupported(program: Program, view: Option<&View>) -> bool {
    program == Program::Gemini
        || view.is_some_and(|view| view.source == "unsupported" || view.reason == "unsupported")
}

fn provider_line(
    app: &App,
    program: Program,
    status: &str,
    windows: &[Window],
    now_ms: Option<u64>,
) -> ProviderLine {
    let panel = &app.overview.usage;
    let view = panel
        .detail
        .as_ref()
        .and_then(|detail| detail.views.iter().find(|view| view.program == program));
    let elapsed = panel
        .detail
        .as_ref()
        .zip(panel.clock)
        .map_or(0, |(detail, (now, _))| {
            u64::try_from(now.saturating_duration_since(detail.received).as_millis())
                .unwrap_or(u64::MAX)
        });
    let line = |windows: Vec<WindowCell>, detail: String, tone: Tone| ProviderLine {
        program,
        windows,
        detail,
        tone,
    };
    if unsupported(program, view) {
        return line(
            Vec::new(),
            "unsupported · no structured quota source on the host".into(),
            Tone::Muted,
        );
    }
    if let Some(view) = view {
        let source = source_label(&view.source, program);
        if view.freshness == "fresh" {
            let age = view
                .age_ms
                .map(|age| age.saturating_add(elapsed))
                .map_or_else(
                    || "age unknown".into(),
                    |age| format!("{} old", age_label(age)),
                );
            let mut detail = format!("{source} · {age}");
            if view.windows.is_empty() {
                detail = format!("no advertised windows · {detail}");
            }
            return line(window_cells(&view.windows, now_ms), detail, Tone::Muted);
        }
        let label = if view.status.is_empty() {
            view.freshness.clone()
        } else {
            view.status.clone()
        };
        let tone = if view.status == "checking" {
            Tone::Muted
        } else {
            Tone::Warning
        };
        return line(
            Vec::new(),
            format!("{label} · {} · {source}", readable(&view.reason)),
            tone,
        );
    }
    let source = source_label("", program);
    match status {
        "ready" => {
            let freshness = if detail_supported(app) {
                "age pending"
            } else {
                "age not reported by this host"
            };
            line(
                window_cells(windows, now_ms),
                format!("{source} · {freshness}"),
                Tone::Muted,
            )
        }
        "checking" => line(
            Vec::new(),
            format!("checking · awaiting first read · {source}"),
            Tone::Muted,
        ),
        other => line(Vec::new(), format!("{other} · {source}"), Tone::Warning),
    }
}

fn wake_line(app: &App, now_ms: Option<u64>) -> Option<String> {
    if !crate::overview::wake_supported(app) {
        return None;
    }
    let armed: Vec<String> = app
        .sessions
        .iter()
        .filter_map(|session| {
            session
                .wake_at
                .map(|at| format!("{}{}", session.name, reset_label(Some(at), now_ms)))
        })
        .collect();
    let offered: Vec<&str> = app
        .sessions
        .iter()
        .filter(|session| session.wake_at.is_none() && app.wake_offered(session))
        .map(|session| session.name.as_str())
        .collect();
    let mut parts = Vec::new();
    if !armed.is_empty() {
        parts.push(format!("armed: {}", armed.join(", ")));
    }
    if !offered.is_empty() {
        parts.push(format!("offered: {}", offered.join(", ")));
    }
    if parts.is_empty() {
        parts.push("none armed".into());
    }
    Some(parts.join(" · "))
}

pub fn summary(app: &App) -> Summary {
    let now_ms = app.overview.usage.clock.map(|(_, now_ms)| now_ms);
    let providers = app
        .capabilities
        .as_ref()
        .map(|caps| {
            caps.provider_limits
                .iter()
                .map(|limit| {
                    let windows: Vec<Window> = limit
                        .windows
                        .iter()
                        .map(|window| Window {
                            used_percent: window.used_percent,
                            duration_mins: window.duration_mins,
                            resets_at: window.resets_at,
                        })
                        .collect();
                    provider_line(app, limit.id, &limit.status, &windows, now_ms)
                })
                .collect()
        })
        .unwrap_or_default();
    Summary {
        providers,
        wake: wake_line(app, now_ms),
        notice: app.overview.usage.refusal.clone(),
    }
}

pub fn session_usage(program: Program, codex: &str) -> String {
    if program == Program::Codex {
        codex.to_owned()
    } else {
        "—".into()
    }
}

pub fn codex_usage(app: &App) -> String {
    summary(app)
        .providers
        .into_iter()
        .find(|line| line.program == Program::Codex)
        .and_then(|line| line.windows.into_iter().next())
        .and_then(|cell| {
            let mut parts = cell.text.split(' ');
            Some(format!("{} {}", parts.next()?, parts.next()?))
        })
        .unwrap_or_else(|| "—".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::overview::tests::{NOW_MS, app};

    pub fn quota_reply(request_id: &str) -> Value {
        json!({"type":"providerQuota","requestId":request_id,"refresh":null,"providers":[
            {"program":"claude","source":"claudeStatusCache","status":"ready","reason":"ready","freshness":"fresh","ageMs":95_000,
                "windows":[{"usedPercent":41,"durationMins":10080,"resetsAt":1_800_090_000},{"usedPercent":78,"durationMins":300,"resetsAt":1_800_003_600}]},
            {"program":"gemini","source":"unsupported","status":"unavailable","reason":"unsupported","freshness":"unavailable","windows":[]},
            {"program":"codex","source":"codexAppServer","status":"ready","reason":"ready","freshness":"fresh","ageMs":12_000,
                "windows":[{"usedPercent":96,"durationMins":300,"resetsAt":1_800_000_600}]}
        ]})
    }

    pub fn usage_app() -> App {
        let mut app = app();
        app.event(json!({
            "type":"capabilities", "workspace":"C:/Projects", "quotaWake":true, "providerQuotaObservations":true, "durableQuotaWake":true,
            "programs":[{"id":"claude","available":true},{"id":"codex","available":true},{"id":"gemini","available":true}],
            "providerLimits":[
                {"id":"claude","status":"ready","windows":[{"durationMins":300,"usedPercent":78,"resetsAt":1_800_003_600},{"durationMins":10080,"usedPercent":41,"resetsAt":1_800_090_000}]},
                {"id":"gemini","status":"unavailable","windows":[]},
                {"id":"codex","status":"ready","windows":[{"durationMins":10080,"usedPercent":35,"resetsAt":1_800_090_000}]}
            ]
        }))
        .unwrap();
        app.overview.open = true;
        app.overview.usage.width = 150;
        app.overview.usage.observe_clock(Instant::now(), NOW_MS);
        app
    }

    pub fn answer(app: &mut App) -> Value {
        let command = tick_at(app, Instant::now()).unwrap();
        let reply = quota_reply(command["requestId"].as_str().unwrap());
        app.event(reply).unwrap();
        command
    }

    #[test]
    fn overview_usage_rows_follow_provider_limits_before_detail_arrives() {
        let app = usage_app();
        let summary = summary(&app);
        let programs: Vec<Program> = summary.providers.iter().map(|line| line.program).collect();
        assert_eq!(programs, [Program::Claude, Program::Gemini, Program::Codex]);
        let claude = &summary.providers[0];
        assert_eq!(claude.windows[0].text, "5h 78% resets in 1h00m");
        assert_eq!(claude.windows[0].tone, Tone::Warning);
        assert_eq!(claude.windows[1].text, "7d 41% resets in 1d1h");
        assert_eq!(claude.detail, "Claude statusline cache · age pending");
        assert!(summary.providers[1].detail.starts_with("unsupported · "));
        assert!(summary.providers[1].windows.is_empty());
        let codex = &summary.providers[2];
        assert_eq!(codex.windows.len(), 1, "weekly-only stays weekly-only");
        assert_eq!(codex.windows[0].text, "7d 35% resets in 1d1h");
        assert_eq!(
            summary.wake.as_deref(),
            Some("armed: Quota parked resets in 10m")
        );
        assert_eq!(summary.notice, None);
    }

    #[test]
    fn overview_usage_detail_adds_freshness_and_replaces_windows() {
        let mut app = usage_app();
        answer(&mut app);
        let summary = summary(&app);
        let codex = &summary.providers[2];
        assert_eq!(codex.windows[0].text, "5h 96% resets in 10m");
        assert_eq!(codex.windows[0].tone, Tone::Danger);
        assert_eq!(codex.detail, "Codex app-server · 12s old");
        assert_eq!(
            summary.providers[0].detail,
            "Claude statusline cache · 1m old"
        );
        assert_eq!(codex_usage(&app), "5h 96%");
        assert_eq!(session_usage(Program::Codex, &codex_usage(&app)), "5h 96%");
        assert_eq!(session_usage(Program::Claude, "5h 96%"), "—");
        let started = app.overview.usage.clock.unwrap().0;
        app.overview
            .usage
            .observe_clock(started + Duration::from_secs(50), NOW_MS + 50_000);
        assert_eq!(
            super::summary(&app).providers[2].detail,
            "Codex app-server · 1m old"
        );
    }

    #[test]
    fn overview_usage_stale_detail_clears_numbers_and_names_the_reason() {
        let mut app = usage_app();
        let command = tick_at(&mut app, Instant::now()).unwrap();
        app.event(json!({"type":"providerQuota","requestId":command["requestId"],"providers":[
            {"program":"codex","source":"codexAppServer","status":"stale","reason":"read_expired","freshness":"stale","windows":[{"usedPercent":96,"durationMins":300,"resetsAt":1_800_000_600}]}
        ]}))
        .unwrap();
        let codex = summary(&app).providers.pop().unwrap();
        assert!(codex.windows.is_empty());
        assert_eq!(codex.detail, "stale · read expired · Codex app-server");
        assert_eq!(codex.tone, Tone::Warning);
    }

    #[test]
    fn overview_usage_requests_quota_once_on_open_then_every_minute() {
        let mut app = usage_app();
        let start = Instant::now();
        let first = tick_at(&mut app, start).unwrap();
        assert_eq!(first["type"], "getProviderQuota");
        assert!(first.get("refresh").is_none() && first.get("program").is_none());
        assert!(tick_at(&mut app, start).is_none(), "one read in flight");
        assert!(host_event_at(
            &mut app,
            &quota_reply(first["requestId"].as_str().unwrap()),
            start
        ));
        assert!(tick_at(&mut app, start + Duration::from_secs(30)).is_none());
        let second = tick_at(&mut app, start + Duration::from_secs(61)).unwrap();
        assert_ne!(second["requestId"], first["requestId"]);
        assert!(!host_event_at(&mut app, &quota_reply("other"), start));
        app.overview.usage.toggle();
        assert!(!visible(&app));
        assert!(tick_at(&mut app, start + Duration::from_secs(62)).is_none());
        assert!(host_event_at(
            &mut app,
            &quota_reply(second["requestId"].as_str().unwrap()),
            start
        ));
        assert!(tick_at(&mut app, start + Duration::from_secs(63)).is_none());
        app.overview.usage.toggle();
        assert!(tick_at(&mut app, start + Duration::from_secs(64)).is_some());
    }

    #[test]
    fn overview_usage_skips_requests_when_unsupported_closed_or_disconnected() {
        let mut app = usage_app();
        app.host_features["providerQuotaObservations"] = false.into();
        assert!(tick_at(&mut app, Instant::now()).is_none());
        assert_eq!(
            summary(&app).providers[0].detail,
            "Claude statusline cache · age not reported by this host"
        );
        app.host_features["providerQuotaObservations"] = true.into();
        app.connected = false;
        assert!(tick_at(&mut app, Instant::now()).is_none());
        app.connected = true;
        app.overview.open = false;
        assert!(tick_at(&mut app, Instant::now()).is_none());
        app.overview.open = true;
        app.overview.usage.width = 80;
        assert!(tick_at(&mut app, Instant::now()).is_none());
    }

    #[test]
    fn overview_usage_refusals_and_timeouts_show_a_reason() {
        let mut app = usage_app();
        answer(&mut app);
        let start = Instant::now();
        let busy = tick_at(&mut app, start + POLL).unwrap();
        app.event(json!({"type":"error","code":"busy","message":"Quota reader is unavailable","requestId":busy["requestId"]}))
            .unwrap();
        let summary = super::summary(&app);
        assert_eq!(
            summary.notice.as_deref(),
            Some("The host quota reader is busy; retrying in 60 s.")
        );
        assert_eq!(summary.providers[2].windows[0].text, "5h 96% resets in 10m");
        assert!(app.notice.is_empty(), "the refusal stays inside the panel");
        let forbidden = tick_at(&mut app, start + POLL * 2).unwrap();
        app.event(json!({"type":"error","code":"forbidden","message":"Owner only","requestId":forbidden["requestId"]}))
            .unwrap();
        let summary = super::summary(&app);
        assert_eq!(
            summary.notice.as_deref(),
            Some("Quota detail is owner-only; this connection may not read it.")
        );
        assert_eq!(
            summary.providers[2].windows[0].text,
            "7d 35% resets in 1d1h"
        );
        let lost = tick_at(&mut app, start + POLL * 3).unwrap();
        assert!(lost["requestId"].is_string());
        assert!(
            tick_at(
                &mut app,
                start + POLL * 3 + TIMEOUT + Duration::from_secs(1)
            )
            .is_none()
        );
        assert_eq!(
            super::summary(&app).notice.as_deref(),
            Some("The host did not answer the quota read.")
        );
    }

    #[test]
    fn overview_usage_toggle_overrides_the_width_default() {
        let mut app = usage_app();
        app.overview.usage.width = 80;
        assert!(!visible(&app));
        app.overview.usage.toggle();
        assert!(visible(&app));
        app.overview.usage.width = 150;
        app.overview.usage.toggle();
        assert!(!visible(&app));
        app.overview.usage.toggle();
        assert!(visible(&app) && session_column(&app));
        assert!(redraw_needed(&mut app));
        assert!(!redraw_needed(&mut app));
        let (now, now_ms) = app.overview.usage.clock.unwrap();
        app.overview
            .usage
            .observe_clock(now + Duration::from_secs(61), now_ms + 61_000);
        assert!(redraw_needed(&mut app));
    }
}
