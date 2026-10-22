use nesvo_wire::views::{
    self,
    projects::{Defaults, ListProjects, ProjectDefaults, ProjectList, ProjectPin, ProjectPinned},
};
use serde_json::{Value, json};

fn reply(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

const LIST: &str = r#"{"type":"projects","requestId":"tui-2-1","limit":256,"projects":[
  {"root":"C:/dev/nesvo","name":"nesvo","defaultBranch":"main","lastActivityAt":9,"pinned":true,
   "openSessions":2,"sessions":["s1","s2"]},
  {"root":"C:/dev/beta","name":"beta","defaultBranch":null,"lastActivityAt":3,"pinned":false,
   "openSessions":0,"sessions":[]}]}"#;

const DEFAULTS: &str = r#"{"type":"projectDefaults","requestId":"tui-2-2","root":"C:/dev/nesvo","name":"nesvo",
  "defaultLayout":"Quad","launchFolder":"C:/dev/nesvo/apps/tui",
  "folders":[{"folder":"C:/dev/nesvo/apps/tui","launches":3,"lastLaunchAt":9}],
  "worktreeSetup":{"available":true,"configured":true,"digest":"abab","approved":false,"openWorktrees":2}}"#;

#[test]
fn project_list_reads_projects_and_skips_a_malformed_one() {
    let list = views::decode::<ProjectList>(&reply(LIST)).unwrap();
    let projects: Vec<_> = list.projects.into_iter().filter_map(|p| p.0).collect();
    assert_eq!(projects[0].default_branch.as_deref(), Some("main"));
    assert_eq!(projects[0].sessions, ["s1", "s2"]);
    assert!(projects[1].default_branch.is_none());

    let mut broken = reply(LIST);
    broken["projects"][0]["root"] = json!(1);
    let list = views::decode::<ProjectList>(&broken).unwrap();
    assert!(list.projects[0].0.is_none());
    assert_eq!(list.projects[1].0.as_ref().unwrap().name, "beta");
    assert!(views::decode::<ProjectList>(&json!({"projects":"broken"})).is_none());
}

#[test]
fn project_defaults_read_the_three_worktree_setup_shapes() {
    let mut event = reply(DEFAULTS);
    let defaults = views::decode::<Defaults>(&event).unwrap();
    assert_eq!(defaults.default_layout.as_deref(), Some("Quad"));
    assert_eq!(defaults.folders[0].launches, 3);
    let setup = &defaults.worktree_setup;
    assert!(setup.available);
    assert_eq!(
        (setup.configured, setup.approved),
        (Some(true), Some(false))
    );
    assert_eq!(setup.digest.as_deref(), Some("abab"));
    assert_eq!(setup.open_worktrees, 2);
    assert!(setup.error.is_none());

    event["worktreeSetup"] = json!({"available":false});
    let setup = views::decode::<Defaults>(&event).unwrap().worktree_setup;
    assert!(!setup.available && setup.configured.is_none());

    event["worktreeSetup"] = json!({"available":true,"configured":false,"openWorktrees":1,
        "error":{"code":"config_invalid","message":"bad toml"}});
    let setup = views::decode::<Defaults>(&event).unwrap().worktree_setup;
    let error = setup.error.unwrap().0.unwrap();
    assert_eq!(error.code, "config_invalid");
    assert!(setup.digest.is_none() && setup.approved.is_none());

    event["worktreeSetup"] = json!("unreadable");
    assert!(
        !views::decode::<Defaults>(&event)
            .unwrap()
            .worktree_setup
            .available
    );
    assert!(views::decode::<Defaults>(&json!({"root":1})).is_none());
}

#[test]
fn project_requests_and_pin_replies_keep_their_wire_shape() {
    assert_eq!(
        views::encode(&ListProjects {}),
        json!({"type":"listProjects"})
    );
    assert_eq!(
        views::encode(&ProjectDefaults { root: "C:/dev" }),
        json!({"type":"projectDefaults","root":"C:/dev"})
    );
    assert_eq!(
        views::encode(&ProjectPin::PinProject { root: "C:/dev" }),
        json!({"type":"pinProject","root":"C:/dev"})
    );
    assert_eq!(
        views::encode(&ProjectPin::UnpinProject { root: "C:/dev" }),
        json!({"type":"unpinProject","root":"C:/dev"})
    );
    let pinned = views::decode::<ProjectPinned>(
        &json!({"type":"projectPinned","root":"C:/dev","pinned":true}),
    )
    .unwrap();
    assert!(pinned.pinned);
}
