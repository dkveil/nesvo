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
pub const COMMANDS: [(char, &str); 9] = [
    ('n', "New session"),
    ('g', "New group"),
    ('D', "Review Git changes"),
    ('f', "Filter session statuses"),
    ('S', "Scheduled sessions"),
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
    if query.trim().is_empty() {
        results.sort_by_key(|row| match row.target.session_id() {
            Some(id) if Some(id) == app.active_id() => usize::MAX,
            Some(id) => app
                .recent_sessions
                .iter()
                .position(|recent| recent == id)
                .unwrap_or(32),
            None => 33,
        });
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
