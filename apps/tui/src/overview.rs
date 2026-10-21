use crate::{
    controller::Outcome,
    launch::Program,
    layouts::Role,
    model::{App, Dialog, Mode, Session},
    session_row::{StatusLabel, status_label, status_source},
    status::State,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind};
use ratatui::layout::Rect;
use serde_json::json;
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    time::Instant,
};

pub const QUIET_SECONDS: u64 = 2 * 60 * 60;

#[derive(Default)]
pub struct Overview {
    pub open: bool,
    pub focused: bool,
    pub query: String,
    pub editing: bool,
    selected: Option<String>,
    output_at: HashMap<String, Instant>,
    quiet: HashMap<String, u64>,
    pub usage: crate::usage_panel::UsagePanel,
}

impl Overview {
    pub fn observe_output(&mut self, id: &str, now: Instant) {
        self.output_at.insert(id.to_owned(), now);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flag {
    Clear,
    Unread,
    Attention(u8),
}

impl Flag {
    fn rank(self) -> u8 {
        match self {
            Self::Clear => 0,
            Self::Unread => 1,
            Self::Attention(priority) => priority.saturating_add(1),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wake {
    Unsupported,
    Idle,
    Limited,
    Offered,
    Armed,
}

impl Wake {
    pub fn label(self) -> &'static str {
        match self {
            Self::Unsupported | Self::Idle => "—",
            Self::Limited => "limit",
            Self::Offered => "offer",
            Self::Armed => "armed",
        }
    }
}

pub struct Row<'a> {
    pub session: &'a Session,
    pub program: Program,
    pub group: String,
    pub status: StatusLabel,
    pub source: &'static str,
    pub flag: Flag,
    pub quiet: Option<u64>,
    pub repository: String,
    pub wake: Wake,
}

impl Row<'_> {
    pub fn quiet_label(&self) -> String {
        match self.quiet {
            None => "—".into(),
            Some(0) => "now".into(),
            Some(seconds) => crate::session_row::duration_label(seconds),
        }
    }

    pub fn faded(&self) -> bool {
        !self.session.running
            || (self.flag == Flag::Clear && self.quiet.is_some_and(|q| q >= QUIET_SECONDS))
    }
}

pub fn leaf_visible(app: &App) -> bool {
    !crate::ui::immersive(app) && app.pane_tree().position(Role::Overview).is_some()
}

pub fn engaged(app: &App) -> bool {
    app.mode == Mode::Navigate && (app.overview.open || (app.overview.focused && leaf_visible(app)))
}

pub fn wake_supported(app: &App) -> bool {
    app.capabilities
        .as_ref()
        .is_some_and(|caps| caps.quota_wake)
}

fn flag(session: &Session) -> Flag {
    match session.attention_priority() {
        0 if session.unread_completion() && !session.muted => Flag::Unread,
        0 => Flag::Clear,
        priority => Flag::Attention(priority),
    }
}

fn wake(app: &App, session: &Session) -> Wake {
    if !wake_supported(app) {
        Wake::Unsupported
    } else if session.wake_at.is_some() {
        Wake::Armed
    } else if app.wake_offered(session) {
        Wake::Offered
    } else if session.rate_limited {
        Wake::Limited
    } else {
        Wake::Idle
    }
}

fn repository(session: &Session) -> String {
    let Some(context) = session.repository_context.as_ref() else {
        return "—".into();
    };
    match (context.repository_name(), context.branch_name()) {
        (Some(name), Some(branch)) => format!("{name} ({branch})"),
        (Some(name), None) => format!("{name} (detached)"),
        _ => "—".into(),
    }
}

pub fn rows(app: &App) -> Vec<Row<'_>> {
    let mut rows: Vec<Row<'_>> = app
        .sessions
        .iter()
        .filter(|session| app.session_search_matches(&session.id, &app.overview.query))
        .map(|session| {
            let program = app.effective_program(session);
            Row {
                session,
                program,
                group: session
                    .group_id
                    .as_deref()
                    .and_then(|id| app.group_search_path(id))
                    .unwrap_or_else(|| "—".into()),
                status: status_label(session, program),
                source: status_source(session),
                flag: flag(session),
                quiet: app.overview.quiet.get(&session.id).copied(),
                repository: repository(session),
                wake: wake(app, session),
            }
        })
        .collect();
    rows.sort_by_cached_key(|row| {
        (
            Reverse(row.flag.rank()),
            row.quiet.unwrap_or(u64::MAX),
            row.session.name.to_lowercase(),
            row.session.id.clone(),
        )
    });
    rows
}

pub fn selected_index(app: &App, rows: &[Row<'_>]) -> usize {
    app.overview
        .selected
        .as_deref()
        .and_then(|id| rows.iter().position(|row| row.session.id == id))
        .unwrap_or(0)
}

fn quiet_seconds(
    session: &Session,
    output_at: Option<&Instant>,
    now: Instant,
    now_ms: u64,
) -> Option<u64> {
    let active_turn = session
        .lifecycle
        .as_ref()
        .and_then(|lifecycle| lifecycle.turn.as_ref())
        .is_some_and(|turn| turn.phase.active());
    let working = session
        .status
        .as_ref()
        .is_some_and(|status| status.state == State::Working);
    if session.running && (working || active_turn) {
        return Some(0);
    }
    let output = output_at.map(|at| now.saturating_duration_since(*at).as_secs());
    let transition = session
        .status
        .as_ref()
        .map(|status| status._updated_at)
        .filter(|at| *at > 0)
        .map(|at| now_ms.saturating_sub(at) / 1000);
    match (output, transition) {
        (Some(output), Some(transition)) => Some(output.min(transition)),
        (output, transition) => output.or(transition),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

pub fn tick(app: &mut App, now: Instant) -> bool {
    refresh(app, now, now_ms())
}

pub fn refresh(app: &mut App, now: Instant, now_ms: u64) -> bool {
    let present: HashSet<&str> = app.sessions.iter().map(|s| s.id.as_str()).collect();
    app.overview
        .output_at
        .retain(|id, _| present.contains(id.as_str()));
    let quiet: HashMap<String, u64> = app
        .sessions
        .iter()
        .filter_map(|session| {
            quiet_seconds(
                session,
                app.overview.output_at.get(&session.id),
                now,
                now_ms,
            )
            .map(|seconds| (session.id.clone(), seconds))
        })
        .collect();
    let bucket = |map: &HashMap<String, u64>| -> HashMap<String, u64> {
        map.iter()
            .map(|(id, seconds)| (id.clone(), seconds.div_ceil(60)))
            .collect()
    };
    let changed = bucket(&quiet) != bucket(&app.overview.quiet);
    app.overview.quiet = quiet;
    app.overview.usage.observe_clock(now, now_ms);
    let usage = crate::usage_panel::redraw_needed(app);
    (changed && (app.overview.open || leaf_visible(app))) || usage
}

pub fn open(app: &mut App, width: u16) {
    app.overview.editing = false;
    app.overview.usage.width = width;
    if leaf_visible(app) {
        app.overview.focused = true;
        app.overview.open = false;
    } else {
        app.overview.open = true;
    }
    app.notice.clear();
}

pub fn close(app: &mut App) {
    app.overview.open = false;
    app.overview.focused = false;
    app.overview.editing = false;
}

pub fn wake_confirm(session: &Session) -> Dialog {
    let enabled = session.wake_at.is_none();
    Dialog::Confirm {
        title: if enabled {
            "Wake after quota reset?"
        } else {
            "Disable automatic wake?"
        }
        .into(),
        detail: "Send one Continue prompt only after a verified quota reset while this Codex session still shows a usage-limit message. Any manual input cancels the plan.".into(),
        command: json!({"type":"setWake", "sessionId":session.id, "enabled":enabled}),
    }
}

pub fn event(app: &mut App, event: Event, area: Rect) -> Outcome {
    let mut outcome = Outcome::default();
    app.overview.usage.width = area.width;
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => key_event(app, key, &mut outcome),
        Event::Paste(text) if app.overview.editing => {
            app.overview
                .query
                .push_str(&text.replace(['\r', '\n'], " "));
        }
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::ScrollUp => step(app, -1),
        Event::Mouse(mouse) if mouse.kind == MouseEventKind::ScrollDown => step(app, 1),
        Event::Resize(width, _) => app.overview.usage.width = width,
        _ => outcome.redraw = false,
    }
    outcome
}

fn key_event(app: &mut App, key: KeyEvent, outcome: &mut Outcome) {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        outcome.quit = true;
        return;
    }
    if app.overview.editing {
        return edit_key(app, key);
    }
    match key.code {
        KeyCode::Esc | KeyCode::Char('O') => close(app),
        KeyCode::Up | KeyCode::Char('k') => step(app, -1),
        KeyCode::Down | KeyCode::Char('j') => step(app, 1),
        KeyCode::PageUp => step(app, -10),
        KeyCode::PageDown => step(app, 10),
        KeyCode::Home => step(app, isize::MIN),
        KeyCode::End => step(app, isize::MAX),
        KeyCode::Enter => jump(app, outcome),
        KeyCode::Char('w') => offer_wake(app),
        KeyCode::Char('f') => app.overlay = Some(crate::toolbox::Overlay::Filters(0)),
        KeyCode::Char('/') => app.overview.editing = true,
        KeyCode::Char('u') if app.overview.open => app.overview.usage.toggle(),
        _ => outcome.redraw = false,
    }
}

fn edit_key(app: &mut App, key: KeyEvent) {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Esc => {
            app.overview.editing = false;
            app.overview.query.clear();
        }
        KeyCode::Enter => app.overview.editing = false,
        KeyCode::Backspace => {
            app.overview.query.pop();
        }
        KeyCode::Char('u') if control => app.overview.query.clear(),
        KeyCode::Char(character) if !control => app.overview.query.push(character),
        _ => {}
    }
}

fn step(app: &mut App, delta: isize) {
    let rows = rows(app);
    if rows.is_empty() {
        return;
    }
    let index = selected_index(app, &rows)
        .saturating_add_signed(delta)
        .min(rows.len() - 1);
    let id = rows[index].session.id.clone();
    app.overview.selected = Some(id);
}

fn selected_session(app: &App) -> Option<String> {
    let rows = rows(app);
    rows.get(selected_index(app, &rows))
        .map(|row| row.session.id.clone())
}

fn jump(app: &mut App, outcome: &mut Outcome) {
    let Some(id) = selected_session(app) else {
        return;
    };
    close(app);
    app.overview.selected = Some(id.clone());
    outcome.commands.extend(app.show_session(&id));
}

fn offer_wake(app: &mut App) {
    let Some(session) = selected_session(app).and_then(|id| app.session(&id)) else {
        return;
    };
    if session.wake_at.is_some() || app.wake_offered(session) {
        app.dialog = Some(wake_confirm(session));
    } else {
        app.notice = "Quota wake is not offered for this session.".into();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crossterm::event::KeyEvent;

    pub const NOW_MS: u64 = 1_800_000_000_000;

    pub fn app() -> App {
        let mut app = App::new(7);
        app.event(json!({
            "type":"capabilities", "workspace":"C:/Projects", "quotaWake":true,
            "programs":[{"id":"claude","available":true},{"id":"codex","available":true}],
            "providerLimits":[{"id":"codex","status":"ready","windows":[{"durationMins":300,"usedPercent":96,"resetsAt":1800000600}]}]
        }))
        .unwrap();
        app.event(json!({"type":"sessions", "revision":1, "groups":[
            {"id":"g","name":"nesvo","parentId":null,"order":0},
            {"id":"h","name":"radar","parentId":"g","order":0}
        ], "sessions":[
            {"id":"idle","name":"Idle helper","cwd":"C:/Projects/nesvo","program":"claude","cols":100,"rows":40,"running":true,"groupId":"g","controllerId":null,"uptimeSeconds":3600,
                "status":{"state":"idle","source":"screen","evidence":"hook","updatedAt":NOW_MS - 600_000},
                "repositoryContext":{"source":"launchDirectory","state":"ready","name":"nesvo","branch":"main","observedAt":1,"revision":1}},
            {"id":"ask","name":"Needs answer","cwd":"C:/Projects/nesvo","program":"claude","cols":100,"rows":40,"running":true,"groupId":"h","controllerId":null,"uptimeSeconds":7200,
                "status":{"state":"question","source":"screen","confirmedSource":"osc7501","updatedAt":NOW_MS - 3_600_000},
                "currentAttention":{"priority":3,"reason":"question","status":{"state":"question","source":"screen","confirmedSource":"osc7501","updatedAt":NOW_MS - 3_600_000}}},
            {"id":"busy","name":"Busy builder","cwd":"C:/Projects/other","program":"codex","cols":100,"rows":40,"running":true,"groupId":null,"controllerId":null,"uptimeSeconds":120,
                "status":{"state":"working","source":"screen","updatedAt":NOW_MS - 900_000},
                "repositoryContext":{"source":"launchDirectory","state":"detached","name":"other","branch":null,"observedAt":1,"revision":1}},
            {"id":"old","name":"Old shell","cwd":"C:/Projects","program":"shell","cols":100,"rows":40,"running":true,"groupId":null,"controllerId":null,"uptimeSeconds":90000,
                "status":{"state":"unknown","source":"activity","updatedAt":NOW_MS - 10_800_000}},
            {"id":"wake","name":"Quota parked","cwd":"C:/Projects","program":"codex","cols":100,"rows":40,"running":true,"groupId":null,"controllerId":null,"uptimeSeconds":600,"rateLimited":true,"wakeAt":1800000600,
                "status":{"state":"idle","source":"screen","updatedAt":NOW_MS - 1_200_000}}
        ]}))
        .unwrap();
        app.dialog = None;
        app.overlay = None;
        app.onboarded = true;
        app.notice.clear();
        refresh(&mut app, Instant::now(), NOW_MS);
        app
    }

    fn ids(app: &App) -> Vec<String> {
        rows(app).iter().map(|row| row.session.id.clone()).collect()
    }

    fn press(app: &mut App, code: KeyCode) -> Outcome {
        crate::controller::event(
            app,
            Event::Key(KeyEvent::new(code, KeyModifiers::NONE)),
            Rect::new(0, 0, 120, 40),
        )
    }

    #[test]
    fn overview_rows_sort_attention_first_then_last_activity() {
        let app = app();
        assert_eq!(ids(&app), ["ask", "busy", "idle", "wake", "old"]);
        let rows = rows(&app);
        let ask = &rows[0];
        assert_eq!(ask.flag, Flag::Attention(3));
        assert_eq!(ask.source, "program");
        assert_eq!(ask.status.text, "needs you");
        assert_eq!(ask.group, "nesvo / radar");
        assert_eq!(ask.quiet_label(), "1h00m");
        assert_eq!(rows[1].quiet_label(), "now");
        assert_eq!(rows[1].repository, "other (detached)");
        assert_eq!(rows[1].wake, Wake::Offered);
        assert_eq!(rows[2].source, "hook");
        assert_eq!(rows[2].repository, "nesvo (main)");
        assert_eq!(rows[3].wake, Wake::Armed);
        assert_eq!(rows[4].source, "unknown");
        assert!(rows[4].faded());
    }

    #[test]
    fn overview_observed_output_counts_as_activity_and_tick_reports_visible_changes() {
        let mut app = app();
        let now = Instant::now();
        app.overview.observe_output("old", now);
        assert!(
            !refresh(&mut app, now, NOW_MS),
            "closed overview stays quiet"
        );
        assert_eq!(ids(&app), ["ask", "busy", "old", "idle", "wake"]);
        app.overview.open = true;
        assert!(!refresh(&mut app, now, NOW_MS));
        assert!(refresh(&mut app, now, NOW_MS + 120_000));
    }

    #[test]
    fn overview_reuses_status_filters_and_text_query() {
        let mut app = app();
        app.status_filters.insert(1);
        assert_eq!(ids(&app), ["idle", "wake"]);
        app.status_filters.clear();
        app.overview.query = "radar".into();
        assert_eq!(ids(&app), ["ask"]);
        app.overview.query = "@".into();
        assert_eq!(ids(&app), ["ask", "busy", "idle", "wake"]);
    }

    #[test]
    fn overview_keys_open_filter_search_and_close() {
        let mut app = app();
        press(&mut app, KeyCode::Char('O'));
        assert!(app.overview.open && engaged(&app));
        press(&mut app, KeyCode::Char('f'));
        assert!(matches!(
            app.overlay,
            Some(crate::toolbox::Overlay::Filters(0))
        ));
        press(&mut app, KeyCode::Enter);
        assert!(app.overlay.is_none() && app.overview.open);
        press(&mut app, KeyCode::Char('/'));
        for character in "shell".chars() {
            press(&mut app, KeyCode::Char(character));
        }
        assert_eq!(app.overview.query, "shell");
        assert_eq!(ids(&app), ["old"]);
        press(&mut app, KeyCode::Enter);
        assert!(!app.overview.editing && app.overview.open);
        press(&mut app, KeyCode::Esc);
        assert!(!app.overview.open && !engaged(&app));
    }

    #[test]
    fn overview_u_toggles_the_usage_panel_without_stealing_search_input() {
        let mut app = app();
        press(&mut app, KeyCode::Char('O'));
        assert!(crate::usage_panel::visible(&app));
        let outcome = press(&mut app, KeyCode::Char('u'));
        assert!(outcome.redraw && !crate::usage_panel::visible(&app));
        press(&mut app, KeyCode::Char('/'));
        press(&mut app, KeyCode::Char('u'));
        assert_eq!(app.overview.query, "u");
        assert!(!crate::usage_panel::visible(&app));
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char('u'));
        assert!(crate::usage_panel::visible(&app));
        crate::controller::event(&mut app, Event::Resize(80, 24), Rect::new(0, 0, 120, 40));
        assert_eq!(app.overview.usage.width, 80);
        assert!(
            crate::usage_panel::visible(&app),
            "an explicit toggle survives a resize"
        );
    }

    #[test]
    fn overview_palette_command_opens_the_view() {
        let mut app = app();
        app.palette_expanded = true;
        app.begin_palette("overview".into());
        let index = app
            .palette_results("overview")
            .iter()
            .position(|row| row.target == crate::palette::Target::Command('O'))
            .unwrap();
        app.select_palette(index);
        press(&mut app, KeyCode::Enter);
        assert!(app.dialog.is_none() && app.overview.open);
    }

    #[test]
    fn overview_enter_jumps_without_acquiring_control() {
        let mut app = app();
        press(&mut app, KeyCode::Char('O'));
        press(&mut app, KeyCode::Down);
        let outcome = press(&mut app, KeyCode::Enter);
        assert!(!app.overview.open);
        assert_eq!(app.active_id(), Some("busy"));
        assert!(app.mode == Mode::Navigate);
        assert!(app.pending_input.is_none());
        assert!(
            outcome
                .commands
                .iter()
                .any(|c| c["type"] == "subscribe" && c["sessionId"] == "busy")
        );
        assert!(
            !outcome
                .commands
                .iter()
                .any(|c| c["type"] == "acquireControl")
        );
        assert_eq!(
            app.recent_sessions.first().map(String::as_str),
            Some("busy")
        );
    }

    #[test]
    fn overview_wake_confirms_only_when_offered_or_armed() {
        let mut app = app();
        press(&mut app, KeyCode::Char('O'));
        press(&mut app, KeyCode::Char('w'));
        assert!(app.dialog.is_none());
        assert_eq!(app.notice, "Quota wake is not offered for this session.");
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Char('w'));
        assert!(matches!(
            &app.dialog,
            Some(Dialog::Confirm { command, .. }) if command["sessionId"] == "busy" && command["enabled"] == true
        ));
        app.dialog = None;
        press(&mut app, KeyCode::End);
        press(&mut app, KeyCode::Up);
        press(&mut app, KeyCode::Char('w'));
        assert!(matches!(
            &app.dialog,
            Some(Dialog::Confirm { command, .. }) if command["sessionId"] == "wake" && command["enabled"] == false
        ));
    }

    #[test]
    fn overview_key_focuses_a_layout_leaf_instead_of_the_full_view() {
        let mut app = app();
        app.set_pane_layout(crate::layouts::PaneTree::split(
            crate::layouts::Direction::Horizontal,
            crate::layouts::PaneTree::leaf(Role::Agent),
            crate::layouts::PaneTree::leaf(Role::Overview),
        ));
        press(&mut app, KeyCode::Char('O'));
        assert!(app.overview.focused && !app.overview.open && engaged(&app));
        press(&mut app, KeyCode::Down);
        press(&mut app, KeyCode::Enter);
        assert!(!engaged(&app));
        assert_eq!(app.panes[0].as_deref(), Some("busy"));
    }
}
