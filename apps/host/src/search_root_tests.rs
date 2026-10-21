use super::*;
use crate::agent_context::WorkingDirectory;
use crate::git_repository::Outcome;
use serde_json::json;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "nesvo-search-root-{}",
            hex::encode(crate::wire::random::<16>())
        ));
        for directory in ["repo/.git", "repo/nested", "repo/worktree", "plain/child"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::write(root.join("repo/worktree/.git"), "gitdir: elsewhere").unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
    fn shown(&self, relative: &str) -> String {
        crate::process::display_path(&self.path(relative))
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn observed(path: &Path, sequence: u64) -> Option<WorkingDirectory> {
    Some(WorkingDirectory {
        path: path.canonicalize().unwrap(),
        sequence,
        observed_at: 1_000 + sequence,
        provider_session: "conversation".into(),
    })
}

fn launched(registry: &mut Registry, directory: PathBuf) -> Binding {
    let binding = Binding {
        id: "a".into(),
        incarnation: [1; 16],
        directory,
    };
    registry.register(binding.clone());
    binding
}

fn root(registry: &Registry, binding: &Binding) -> SearchRoot {
    registry
        .search_root(&binding.id, &binding.incarnation)
        .unwrap()
}

fn inspected(registry: &Registry, binding: &Binding) -> PathBuf {
    registry.subscriptions[&binding.id].directory.clone()
}

#[test]
fn search_root_follows_current_cwd_only_inside_the_launch_repository_toplevel() {
    let workspace = Workspace::new();
    let mut registry = Registry::default();
    let binding = launched(&mut registry, workspace.path("repo/nested"));
    assert_eq!(
        root(&registry, &binding),
        SearchRoot {
            source: RootSource::LaunchDirectory,
            reason: RootReason::NoCurrentCwd,
            path: None,
            observed_at: None,
        }
    );
    assert!(registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("repo/worktree"), 2)
    ));
    assert_eq!(
        root(&registry, &binding),
        SearchRoot {
            source: RootSource::CurrentCwd,
            reason: RootReason::InsideRoot,
            path: Some(workspace.shown("repo/worktree")),
            observed_at: Some(1_002),
        }
    );
    assert_eq!(inspected(&registry, &binding), binding.directory);
    assert!(!registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("repo/worktree"), 3)
    ));
    assert_eq!(root(&registry, &binding).observed_at, Some(1_002));
    assert!(registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("repo"), 4)
    ));
    assert_eq!(root(&registry, &binding).source, RootSource::CurrentCwd);
    assert!(registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("plain/child"), 5)
    ));
    assert_eq!(
        root(&registry, &binding),
        SearchRoot {
            source: RootSource::LaunchDirectory,
            reason: RootReason::OutsideRoot,
            path: None,
            observed_at: Some(1_005),
        }
    );
    assert_eq!(inspected(&registry, &binding), binding.directory);
    assert!(!registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("repo/worktree"), 1)
    ));
    assert_eq!(root(&registry, &binding).reason, RootReason::OutsideRoot);
    assert!(!registry.observe_cwd(
        &binding.id,
        &[9; 16],
        observed(&workspace.path("repo/worktree"), 6)
    ));
    assert!(registry.observe_cwd(&binding.id, &binding.incarnation, None));
    assert_eq!(root(&registry, &binding).reason, RootReason::NoCurrentCwd);
    assert_eq!(inspected(&registry, &binding), binding.directory);
    registry.remove(&binding.id);
    assert!(registry.locations.is_empty() && registry.entries.is_empty());
}

#[test]
fn search_root_outside_a_repository_is_confined_to_the_launch_directory_itself() {
    let workspace = Workspace::new();
    let mut registry = Registry::default();
    let binding = launched(&mut registry, workspace.path("plain"));
    assert!(registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("plain/child"), 1)
    ));
    assert_eq!(root(&registry, &binding).source, RootSource::CurrentCwd);
    for (outside, sequence) in [("repo/nested", 2), ("", 3)] {
        registry.observe_cwd(
            &binding.id,
            &binding.incarnation,
            observed(&workspace.path(outside), sequence),
        );
        assert_eq!(root(&registry, &binding).reason, RootReason::OutsideRoot);
        assert_eq!(inspected(&registry, &binding), binding.directory);
    }
    registry.seal();
    assert!(!registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("plain/child"), 4)
    ));
}

#[test]
fn search_root_follows_another_repository_while_repository_context_and_project_stay_on_launch() {
    let workspace = Workspace::new();
    let mut registry = Registry::default();
    let binding = launched(&mut registry, workspace.path("repo/nested"));
    let incarnations = HashMap::from([(binding.id.clone(), binding.incarnation)]);
    let project = |registry: &Registry| {
        let mut snapshot = json!({"sessions":[{"id":"a"}]});
        registry.enrich(&mut snapshot, &incarnations, 10);
        snapshot["sessions"][0].clone()
    };
    let launch = project(&registry);
    assert_eq!(
        launch["searchRoot"],
        json!({"source":"launchDirectory","reason":"noCurrentCwd","path":null,"observedAt":null})
    );
    assert!(launch.get("repositoryContext").is_none());

    registry.demand(1, std::slice::from_ref(&binding.id), 0);
    let work = registry.claim().unwrap();
    assert_eq!(work.directory, binding.directory);
    assert!(registry.finish(
        &work,
        Outcome::Ready {
            name: "repo".into(),
            branch: "main".into(),
            root: workspace.shown("repo"),
        },
        5,
        5,
    ));
    let derived = |registry: &Registry| {
        crate::projects::derive(
            &[crate::projects::LiveSession {
                id: binding.id.clone(),
                directory: workspace.shown("repo/nested"),
                root: registry.root(&binding.id),
                running: true,
            }],
            &[],
            10,
        )
        .into_iter()
        .map(|observation| observation.root)
        .collect::<Vec<_>>()
    };
    let launch = project(&registry);
    let launch_project = derived(&registry);
    assert_eq!(launch_project, vec![workspace.shown("repo")]);

    assert!(registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("repo/worktree"), 7),
    ));
    let current = project(&registry);
    assert_eq!(
        current["searchRoot"],
        json!({"source":"currentCwd","reason":"insideRoot","path":workspace.shown("repo/worktree"),"observedAt":1_007})
    );
    assert_eq!(current["repositoryContext"], launch["repositoryContext"]);
    assert_eq!(
        current["repositoryContext"]["root"],
        workspace.shown("repo")
    );
    assert_eq!(registry.root(&binding.id), Some(workspace.shown("repo")));
    assert_eq!(derived(&registry), launch_project);
    registry.demand(1, std::slice::from_ref(&binding.id), 40_000);
    let refresh = registry.claim().unwrap();
    assert_eq!(refresh.directory, binding.directory);
    assert!(registry.finish(
        &refresh,
        Outcome::Ready {
            name: "repo".into(),
            branch: "main".into(),
            root: workspace.shown("repo"),
        },
        40_000,
        40_000,
    ));

    registry.observe_cwd(
        &binding.id,
        &binding.incarnation,
        observed(&workspace.path("plain"), 8),
    );
    assert_eq!(
        project(&registry)["searchRoot"],
        json!({"source":"launchDirectory","reason":"outsideRoot","path":null,"observedAt":1_008})
    );
    assert_eq!(derived(&registry), launch_project);
}
