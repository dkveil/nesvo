use super::*;
use crate::worktrees::ProjectWorktree;

fn store() -> Store {
    Store::with(crate::migrations::migrated_database()).unwrap()
}

fn root(name: &str) -> String {
    display_path(&std::env::temp_dir().join("nesvo-projects").join(name))
}

fn seen(name: &str, at: u64) -> Observation {
    Observation {
        root: root(name),
        name: name.into(),
        branch: None,
        folder: None,
        session_id: None,
        at,
    }
}

fn launched(name: &str, folder: &str, session: &str, at: u64) -> Observation {
    Observation {
        folder: Some(folder.into()),
        session_id: Some(session.into()),
        ..seen(name, at)
    }
}

fn live(id: &str, directory: &str, root: Option<String>) -> LiveSession {
    LiveSession {
        id: id.into(),
        directory: directory.into(),
        root,
        running: true,
    }
}

#[test]
fn projects_registry_derives_from_sessions_and_worktrees_and_sorts_pinned_then_activity() {
    let mut store = store();
    let sessions = [
        live("a", &root("alpha"), Some(root("alpha"))),
        live(
            "b",
            &format!("{}{}src", root("beta"), std::path::MAIN_SEPARATOR),
            None,
        ),
        live("c", &root("elsewhere"), None),
        live("w", &root("alpha-worktree"), None),
        LiveSession {
            running: false,
            ..live("closed", &root("alpha"), Some(root("alpha")))
        },
    ];
    let worktrees = [
        ProjectWorktree {
            repository: root("beta"),
            session_id: "w".into(),
            created_at: 40,
            open: true,
        },
        ProjectWorktree {
            repository: root("gamma"),
            session_id: "archived".into(),
            created_at: 10,
            open: false,
        },
    ];
    let observations = derive(&sessions, &worktrees, 500);
    assert!(
        observations
            .iter()
            .all(|observation| observation.root != root("elsewhere"))
    );
    store.record_all(&observations).unwrap();
    store.set_pinned(&root("gamma"), true).unwrap();
    let projects = project_view(store.rows().unwrap(), &sessions, &worktrees);
    let order: Vec<&str> = projects
        .iter()
        .map(|project| project.name.as_str())
        .collect();
    assert_eq!(order, ["gamma", "alpha", "beta"]);
    assert!(projects[0].pinned);
    assert_eq!(projects[1].sessions, ["a"]);
    assert_eq!(projects[1].open_sessions, 1);
    assert_eq!(projects[1].last_activity_at, 500);
    assert_eq!(projects[2].sessions, ["b", "w"]);
    assert_eq!(projects[2].last_activity_at, 40);
    assert_eq!(projects[0].open_sessions, 0);
}

#[test]
fn projects_registry_evicts_beyond_its_bound_by_last_activity_and_keeps_pins() {
    let mut store = store();
    store.record_all(&[seen("pinned", 1)]).unwrap();
    store.set_pinned(&root("pinned"), true).unwrap();
    let observations: Vec<Observation> = (0..PROJECT_LIMIT as u64 + 3)
        .map(|index| seen(&format!("project-{index:03}"), 100 + index))
        .collect();
    store.record_all(&observations).unwrap();
    let rows = store.rows().unwrap();
    assert_eq!(rows.len(), PROJECT_LIMIT);
    assert_eq!(rows[0].root, root("pinned"));
    assert!(rows.iter().all(|row| row.root != root("project-000")));
    assert!(rows.iter().all(|row| row.root != root("project-003")));
    assert!(rows.iter().any(|row| row.root == root("project-004")));
    let folders: i64 = store
        .connection
        .query_row(
            "SELECT count(*) FROM project_folders WHERE root NOT IN (SELECT root FROM projects)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(folders, 0);
    for index in 0..PIN_LIMIT - 1 {
        store
            .set_pinned(&root(&format!("project-{:03}", index + 10)), true)
            .unwrap();
    }
    let refused = store.set_pinned(&root("project-200"), true).unwrap_err();
    assert_eq!(
        refused.downcast_ref::<Failure>().unwrap().code,
        "project_limit"
    );
}

#[test]
fn projects_registry_persists_pins_layouts_and_folders_across_reopen() {
    let directory = std::env::temp_dir().join(format!(
        "nesvo-projects-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("metadata.sqlite3");
    drop(crate::migrations::migrated_database_at(&path));
    {
        let mut store = Store::open(&path).unwrap();
        store
            .record_all(&[launched("nesvo", &root("nesvo"), "s1", 7)])
            .unwrap();
        store.set_pinned(&root("nesvo"), true).unwrap();
        store.set_layout(&root("nesvo"), Some("Quad")).unwrap();
    }
    let reopened = Store::open(&path).unwrap();
    let rows = reopened.rows().unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].pinned);
    assert_eq!(rows[0].last_activity, 7);
    let defaults = reopened.defaults(&root("nesvo")).unwrap();
    assert_eq!(defaults.default_layout.as_deref(), Some("Quad"));
    assert_eq!(defaults.launch_folder(), root("nesvo"));
    drop(reopened);
    let _ = std::fs::remove_dir_all(&directory);
    assert!(Store::with(Connection::open_in_memory().unwrap()).is_err());
}

#[test]
fn projects_usual_folder_counts_distinct_launches_and_main_checkout_sets_the_branch() {
    let mut store = store();
    let api = format!("{}{}api", root("nesvo"), std::path::MAIN_SEPARATOR);
    store
        .record_all(&[
            launched("nesvo", &root("nesvo"), "s1", 1),
            launched("nesvo", &api, "s2", 2),
            launched("nesvo", &api, "s2", 3),
            launched("nesvo", &api, "s3", 4),
        ])
        .unwrap();
    let defaults = store.defaults(&root("nesvo")).unwrap();
    assert_eq!(defaults.launch_folder(), api);
    assert_eq!(defaults.folders[0].launches, 2);
    assert_eq!(defaults.folders[1].launches, 1);
    let mut branch = seen("nesvo", 5);
    branch.branch = Some("main".into());
    store.record_all(&[branch, seen("nesvo", 6)]).unwrap();
    assert_eq!(
        store.rows().unwrap()[0].default_branch.as_deref(),
        Some("main")
    );
    let spaced = format!("{}{}", root("nesvo"), std::path::MAIN_SEPARATOR);
    assert_eq!(store.resolve(&spaced).unwrap(), Some(root("nesvo")));
    assert!(store.defaults(&root("unknown")).is_err());
}

#[test]
fn projects_launch_dedupe_evicts_the_least_recent_entry_instead_of_clearing() {
    let mut recent = Recent::default();
    let key = |index: usize| (format!("s{index}"), "folder".to_owned());
    for index in 0..SEEN_LIMIT {
        assert!(recent.insert(key(index)));
    }
    assert!(!recent.insert(key(0)));
    assert!(recent.insert(key(SEEN_LIMIT)));
    assert_eq!(recent.ticks.len(), SEEN_LIMIT);
    assert!(!recent.insert(key(0)));
    assert!(!recent.insert(key(2)));
    assert!(recent.insert(key(1)));
}

#[test]
fn projects_writes_take_the_write_lock_up_front_and_never_starve_the_journal() {
    let directory = std::env::temp_dir().join(format!(
        "nesvo-projects-contention-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("metadata.sqlite3");
    drop(crate::migrations::migrated_database_at(&path));
    let journal = Connection::open(&path).unwrap();
    journal
        .busy_timeout(std::time::Duration::from_millis(50))
        .unwrap();
    journal
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE contention(id INTEGER PRIMARY KEY, at INTEGER NOT NULL);")
        .unwrap();
    let mut store = Store::open(&path).unwrap();
    let blocker = Connection::open(&path).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = std::time::Instant::now();
    let refused = store.record_all(&[seen("blocked", 1)]).unwrap_err();
    assert!(busy(&refused));
    assert!(started.elapsed() < std::time::Duration::from_millis(1500));
    blocker.execute_batch("ROLLBACK").unwrap();
    let writer = std::thread::spawn(move || {
        for index in 0..200u64 {
            store
                .record_all(&[launched("busy", &root("busy"), &format!("s{index}"), index)])
                .unwrap();
        }
        store
    });
    for index in 0..200i64 {
        journal
            .execute("INSERT INTO contention(at) VALUES(?1)", [index])
            .unwrap();
    }
    let store = writer.join().unwrap();
    assert_eq!(store.rows().unwrap().len(), 1);
    drop((store, journal, blocker));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn projects_commands_parse_are_owner_only_and_validate_arguments() {
    let pinned: Command =
        serde_json::from_value(json!({"type":"pinProject","root":root("nesvo")})).unwrap();
    assert!(handles(&pinned));
    for command in [
        json!({"type":"listProjects"}),
        json!({"type":"unpinProject","root":"/x"}),
        json!({"type":"projectDefaults","root":"/x"}),
        json!({"type":"setProjectLayout","root":"/x","layout":null}),
    ] {
        assert!(handles(&serde_json::from_value(command).unwrap()));
    }
    assert!(!handles(&Command::ListWorktrees));
    assert!(admit(&Authority::Owner).is_ok());
    let scoped = Authority::Session {
        id: "s".into(),
        scope_id: "scope".into(),
    };
    let refused = admit(&scoped).unwrap_err();
    assert_eq!(refused.downcast_ref::<Failure>().unwrap().code, "forbidden");
    assert!(valid_root(&root("nesvo")).is_ok());
    for invalid in ["", "relative/path", "bad\u{7}"] {
        assert!(valid_root(invalid).is_err(), "{invalid:?}");
    }
    assert!(valid_root(&format!("{}{}", root("x"), "a".repeat(4096))).is_err());
    assert!(valid_layout(Some("Quad")).is_ok());
    assert!(valid_layout(None).is_ok());
    for invalid in ["", " Quad", &"x".repeat(41)] {
        assert!(valid_layout(Some(invalid)).is_err(), "{invalid:?}");
    }
    assert!(same_path(
        &root("nesvo"),
        &format!("{}{}", root("nesvo"), std::path::MAIN_SEPARATOR)
    ));
    assert!(!inside(&root("nesvo-other"), &root("nesvo")));
    assert!(inside(&root("nesvo"), &root("nesvo")));
    assert_eq!(base_name(&root(&"ł".repeat(100))).len(), NAME_BYTES);
}
