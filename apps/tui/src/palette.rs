//! Search targets have stable identities independent of display order.
use crate::model::App;

#[derive(Clone, PartialEq, Eq)]
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

pub fn results(app: &App, query: &str) -> Vec<ResultRow> {
    let category = if app.palette_expanded {
        app.palette_category
    } else {
        0
    };
    let mut results = Vec::new();
    if category <= 1 {
        results.extend(
            app.quick_switch_results(query)
                .into_iter()
                .map(|s| ResultRow {
                    target: Target::Session(s.id.clone()),
                    title: s.name.clone(),
                    context: format!(
                        "{} · {} · {}",
                        app.effective_program(s).label(),
                        s.status.as_ref().map_or("unknown", |s| s.label()),
                        s.cwd
                    ),
                }),
        );
    }
    let words: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
    let matches = |text: &str| {
        let text = text.to_lowercase();
        words.iter().all(|word| {
            let mut chars = text.chars();
            word.chars().all(|c| chars.any(|candidate| candidate == c))
        })
    };
    if category == 0 || category == 2 {
        for (id, path) in app.group_choices(None) {
            if let Some(id) = id
                && matches(&path)
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
            if matches(title) {
                results.push(ResultRow {
                    target: Target::Command(key),
                    title: title.into(),
                    context: format!(
                        "Command · {}",
                        if key == 'D' {
                            "F4".to_owned()
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
