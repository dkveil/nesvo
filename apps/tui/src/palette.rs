//! Search targets have stable identities independent of display order.
use crate::model::App;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Session(String),
    Group(String),
    Command(char),
}
impl Target {
    pub fn session_id(&self) -> Option<&str> {
        if let Self::Session(id) = self {
            Some(id)
        } else {
            None
        }
    }
}
pub struct ResultRow {
    pub target: Target,
    pub title: String,
    pub context: String,
}
pub const CATEGORIES: [&str; 4] = ["All", "Sessions", "Groups", "Commands"];
pub const COMMANDS: [(char, &str); 11] = [
    ('n', "New session"),
    ('N', "New session kind"),
    ('g', "New group"),
    ('D', "Review Git changes"),
    ('f', "Filter session statuses"),
    ('S', "Scheduled sessions"),
    ('J', "Jobs"),
    ('H', "Getting started"),
    ('p', "Pair phone"),
    ('z', "Toggle focus mode"),
    ('M', "Menu and settings"),
];

fn category(app: &App) -> usize {
    if app.palette_expanded {
        app.palette_category
    } else {
        0
    }
}

fn words(query: &str) -> Vec<String> {
    query.split_whitespace().map(str::to_lowercase).collect()
}

fn text_matches(words: &[String], text: &str) -> bool {
    if words.is_empty() {
        return true;
    }
    let text = text.to_lowercase();
    words.iter().all(|word| {
        let mut chars = text.chars();
        word.chars().all(|c| chars.any(|candidate| candidate == c))
    })
}

/// Checks only the saved identity; never builds or sorts the other results.
pub fn eligible(app: &App, query: &str, target: &Target) -> bool {
    let category = category(app);
    match target {
        Target::Session(id) => category <= 1 && app.session_search_matches(id, query),
        Target::Group(id) => {
            (category == 0 || category == 2)
                && app
                    .group_search_path(id)
                    .is_some_and(|path| text_matches(&words(query), &path))
        }
        Target::Command(key) => {
            app.palette_expanded
                && (category == 0 || category == 3)
                && COMMANDS
                    .iter()
                    .find(|(candidate, _)| candidate == key)
                    .is_some_and(|(_, title)| text_matches(&words(query), title))
        }
    }
}

pub fn results(app: &App, query: &str) -> Vec<ResultRow> {
    let category = category(app);
    let mut results = Vec::new();
    if category <= 1 {
        results.extend(
            app.quick_switch_results(query)
                .into_iter()
                .map(|s| ResultRow {
                    target: Target::Session(s.id.clone()),
                    title: s.name.clone(),
                    context: format!(
                        "{} · {} · process {}{} · {}",
                        app.effective_program(s).label(),
                        crate::session_row::status_label(s, app.effective_program(s)).text,
                        s.runtime_label,
                        if s.turn_runtime_label.is_empty() {
                            String::new()
                        } else {
                            format!(" · {}", s.turn_runtime_label)
                        },
                        s.cwd
                    ),
                }),
        );
    }
    let words = words(query);
    if category == 0 || category == 2 {
        for (id, path) in app.group_choices(None) {
            if let Some(id) = id
                && text_matches(&words, &path)
            {
                results.push(ResultRow {
                    target: Target::Group(id),
                    title: path,
                    context: "Group · reveal in sidebar".into(),
                });
            }
        }
    }
    if app.palette_expanded && (category == 0 || category == 3) {
        for (key, title) in COMMANDS {
            if text_matches(&words, title) {
                results.push(ResultRow {
                    target: Target::Command(key),
                    title: title.into(),
                    context: format!(
                        "Command · {}",
                        if key == 'D' {
                            format!("F{}", app.shortcuts.keys[0])
                        } else {
                            key.to_string()
                        }
                    ),
                });
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_target_eligibility_matches_search_scopes_categories_and_unicode() {
        let mut app = App::new(1);
        app.event(json!({"type":"sessions","revision":1,"groups":[
            {"id":"parent","name":"Workspace","parentId":null,"order":0},
            {"id":"same","name":"工程","parentId":"parent","order":0},
            {"id":"cycle-a","name":"Cycle A","parentId":"cycle-b","order":0},
            {"id":"cycle-b","name":"Cycle B","parentId":"cycle-a","order":0}
        ],"sessions":[
            {"id":"same","name":"工程 review","cwd":"/work/auth","program":"claude","cols":80,"rows":24,"running":true,"groupId":"same","controllerId":null,"status":{"state":"question","source":"hook","updatedAt":1}},
            {"id":"shell","name":"Docs","cwd":"/work/docs","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null},
            {"id":"hint","name":"Hint","cwd":"/work","program":"shell","cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null}
        ]})).unwrap();
        app.event(json!({"type":"subscribed","sessionId":"hint","cols":80,"rows":24}))
            .unwrap();
        app.event(json!({"type":"output","sessionId":"hint","data":"Claude Code v2.1.305\r\n"}))
            .unwrap();
        let targets: Vec<_> = ["same", "shell", "hint", "missing"]
            .into_iter()
            .map(|id| Target::Session(id.into()))
            .chain(
                ["parent", "same", "cycle-a", "cycle-b", "missing"]
                    .into_iter()
                    .map(|id| Target::Group(id.into())),
            )
            .chain(COMMANDS.iter().map(|(key, _)| Target::Command(*key)))
            .chain([Target::Command('?')])
            .collect();
        for filters in [
            vec![],
            vec![crate::toolbox::status_index(&app.sessions[0])],
            vec![usize::MAX],
        ] {
            app.status_filters = filters.into_iter().collect();
            for expanded in [false, true] {
                app.palette_expanded = expanded;
                for category in 0..4 {
                    app.palette_category = category;
                    for query in [
                        "", "工程", "wrkspace", "claude", "@", "@ claude", "$", "$ docs", "!",
                        "! 工程", "new", "missing",
                    ] {
                        let results = results(&app, query);
                        for target in &targets {
                            assert_eq!(
                                eligible(&app, query, target),
                                results.iter().any(|row| &row.target == target),
                                "expanded={expanded}, category={category}, query={query}, target={target:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod ranking_tests {
    use super::*;
    use crate::model::Dialog;
    use serde_json::{Value, json};

    fn session(id: &str, name: &str, state: &str) -> Value {
        json!({
            "id":id,"name":name,"cwd":"/work","program":"claude",
            "cols":80,"rows":24,"running":true,"groupId":null,"controllerId":null,
            "status":{"state":state,"source":"hook","updatedAt":1},
            "currentAttention":{"priority":0,"reason":null,"status":null}
        })
    }

    fn needs_you(mut session: Value, priority: u8) -> Value {
        let (state, reason) = match priority {
            3 => ("question", "question"),
            2 => ("blocked", "child"),
            _ => ("failed", "failure"),
        };
        if priority == 3 {
            session["status"] = json!({"state":state,"source":"hook","updatedAt":1});
        }
        session["currentAttention"] = json!({"priority":priority,"reason":reason,
            "status":{"state":state,"source":"program","updatedAt":1}});
        session
    }

    fn completion(mut session: Value, response: bool) -> Value {
        session["attention"] = json!({"sequence":1,"kind":"done","at":1,"unread":true,
            "source":if response {"hook"} else {"program"},
            "subject":if response {Some("response")} else {None}});
        session
    }

    fn snapshot(sessions: Vec<Value>) -> Value {
        json!({"type":"sessions","revision":1,"groups":[],"sessions":sessions})
    }

    fn app(snapshot: Value) -> App {
        let mut app = App::new(1);
        app.event(snapshot).unwrap();
        // Test rank independently of the optional active-session tie breaker.
        app.panes = [None, None];
        app
    }

    fn ranks(app: &mut App, query: &str) -> Vec<String> {
        let quick: Vec<_> = app
            .quick_switch_results(query)
            .into_iter()
            .map(|session| session.id.clone())
            .collect();
        for expanded in [false, true] {
            app.palette_expanded = expanded;
            app.palette_category = 0;
            let palette: Vec<_> = results(app, query)
                .into_iter()
                .filter_map(|row| row.target.session_id().map(str::to_owned))
                .collect();
            assert_eq!(palette, quick, "expanded={expanded}, query={query}");
        }
        quick
    }

    #[test]
    fn empty_query_ranks_current_needs_you_then_unread_completion_then_mru() {
        let mut app = app(snapshot(vec![
            session("recent", "Needle recent", "idle"),
            session("idle", "Needle idle", "idle"),
            completion(session("response", "Needle response", "idle"), true),
            completion(session("provider", "Needle provider", "done"), false),
            needs_you(session("failed", "Needle failed", "failed"), 1),
            needs_you(session("blocked", "Needle blocked", "working"), 2),
            needs_you(session("question", "Needle question", "working"), 3),
        ]));
        app.recent_sessions = vec!["recent".into(), "response".into(), "idle".into()];
        app.panes[0] = Some("question".into());
        assert_eq!(
            ranks(&mut app, ""),
            [
                "question", "blocked", "failed", "response", "provider", "recent", "idle"
            ]
        );
        assert_eq!(
            app.session("blocked")
                .unwrap()
                .status
                .as_ref()
                .unwrap()
                .state,
            crate::status::State::Working,
            "Aggregate attention must not replace the running agent's state"
        );
    }

    #[test]
    fn nonempty_query_preserves_text_relevance_before_urgency_and_mru_ties() {
        let mut context = needs_you(session("context", "Other", "working"), 3);
        context["cwd"] = json!("/work/needle");
        let mut app = app(snapshot(vec![
            context,
            session("exact", "Needle exact", "idle"),
            session("idle", "Needle idle", "idle"),
            session("recent", "Needle recent", "idle"),
            completion(session("complete", "Needle complete", "idle"), true),
            needs_you(session("needs", "Needle needs", "working"), 2),
        ]));
        app.recent_sessions = vec!["recent".into(), "context".into()];
        assert_eq!(
            ranks(&mut app, "needle"),
            ["needs", "complete", "recent", "exact", "idle", "context"]
        );
    }

    #[test]
    fn historical_unread_completion_does_not_boost_working_or_active_turns() {
        let mut sessions = vec![
            session("idle", "Zulu idle", "idle"),
            completion(session("working", "Alpha working", "working"), true),
        ];
        for phase in ["accepted", "started", "waiting"] {
            let mut row = completion(session(phase, phase, "idle"), true);
            row["lifecycle"] = json!({"turn":{"phase":phase,"elapsedSeconds":1}});
            sessions.push(row);
        }
        let mut app = app(snapshot(sessions));
        app.recent_sessions = ["idle", "working", "accepted", "started", "waiting"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            ranks(&mut app, ""),
            ["idle", "working", "accepted", "started", "waiting"]
        );
        assert!(
            app.session("working")
                .unwrap()
                .attention
                .as_ref()
                .unwrap()
                .unread
        );
    }

    #[test]
    fn completion_rank_requires_an_unread_host_done_event() {
        let mut acknowledged = completion(session("read", "Needle read", "idle"), true);
        acknowledged["attention"]["unread"] = json!(false);
        let mut historical = completion(session("history", "Needle history", "idle"), false);
        historical["attention"]["kind"] = json!("question");
        let mut app = app(snapshot(vec![
            session("status", "Needle status", "done"),
            acknowledged,
            historical,
            session("idle", "Needle idle", "idle"),
            completion(session("complete", "Needle complete", "idle"), true),
        ]));
        app.recent_sessions = ["status", "read", "history", "idle"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        for query in ["", "needle"] {
            assert_eq!(
                ranks(&mut app, query),
                ["complete", "status", "read", "history", "idle"]
            );
        }
    }

    #[test]
    fn acknowledgment_removes_completion_boost_but_preview_does_not() {
        let mut value = snapshot(vec![
            session("idle", "Needle idle", "idle"),
            completion(session("complete", "Needle complete", "idle"), true),
        ]);
        let mut app = app(value.clone());
        app.recent_sessions = vec!["idle".into()];
        assert_eq!(ranks(&mut app, ""), ["complete", "idle"]);
        let commands = app.preview_session("complete");
        assert!(
            commands
                .iter()
                .all(|command| command["type"] != "acknowledgeAttention")
        );
        assert_eq!(app.recent_sessions, ["idle"]);
        assert!(
            app.session("complete")
                .unwrap()
                .attention
                .as_ref()
                .unwrap()
                .unread
        );
        assert_eq!(ranks(&mut app, "needle"), ["complete", "idle"]);

        value["revision"] = json!(2);
        value["sessions"][1]["attention"]["unread"] = json!(false);
        app.event(value).unwrap();
        app.panes = [None, None];
        assert_eq!(ranks(&mut app, ""), ["idle", "complete"]);
        assert_eq!(ranks(&mut app, "needle"), ["idle", "complete"]);
        assert_eq!(
            app.session("complete")
                .unwrap()
                .status
                .as_ref()
                .unwrap()
                .state,
            crate::status::State::Idle
        );
    }

    #[test]
    fn ranking_changes_preserve_the_exact_selected_target() {
        for query in ["", "needle"] {
            let mut value = snapshot(vec![
                session("idle", "Needle idle", "idle"),
                completion(session("complete", "Needle complete", "idle"), true),
                session("needs", "Needle needs", "idle"),
            ]);
            let mut app = app(value.clone());
            app.palette_expanded = true;
            let target = Target::Session("complete".into());
            app.dialog = Some(Dialog::QuickSwitch {
                query: query.into(),
                selected: Some(target.clone()),
            });
            assert_eq!(app.palette_index(), Some(0));
            value["revision"] = json!(2);
            value["sessions"][2] = needs_you(value["sessions"][2].clone(), 3);
            app.event(value).unwrap();
            assert_eq!(app.palette_index(), Some(1));
            assert!(matches!(&app.dialog,
                Some(Dialog::QuickSwitch { selected: Some(selected), .. }) if selected == &target));
            assert_eq!(app.active_id(), Some("idle"));
            assert!(app.recent_sessions.is_empty());
        }
    }

    #[test]
    fn duplicate_unicode_names_use_exact_id_as_deterministic_rank_tie() {
        let mut app = app(snapshot(vec![
            session("b", "工程 ÅPI", "idle"),
            session("a", "工程 åpi", "idle"),
        ]));
        for query in ["", "工程", "åpi"] {
            assert_eq!(ranks(&mut app, query), ["a", "b"]);
            app.sessions.reverse();
            assert_eq!(ranks(&mut app, query), ["a", "b"]);
        }
    }
}
