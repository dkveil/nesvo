use super::*;
use crate::event_log;

mod process_fixture {
    include!("../../../crates/nesvo-process-fixture/src/locate.rs");
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(name: &str) -> Scratch {
    let path = std::env::temp_dir().join(format!(
        "nesvo-mcp-servers-{name}-{}",
        hex::encode(crate::wire::random::<8>())
    ));
    std::fs::create_dir_all(&path).unwrap();
    Scratch(path)
}

fn git(directory: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .current_dir(directory)
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.hooksPath=",
        ])
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn commit(directory: &Path, text: &str) {
    std::fs::write(directory.join(CONFIG_FILE), text).unwrap();
    git(directory, &["add", "--", CONFIG_FILE]);
    git(directory, &["commit", "--quiet", "-m", "declare servers"]);
}

fn repository(text: &str) -> Scratch {
    let directory = scratch("repo");
    git(&directory.0, &["init", "--quiet"]);
    std::fs::create_dir_all(directory.0.join("tools/docs")).unwrap();
    commit(&directory.0, text);
    directory
}

fn store(approvals: &[(&str, &str)]) -> (Scratch, Store) {
    let directory = scratch("store");
    let approvals: Vec<Value> = approvals
        .iter()
        .map(|(repository, digest)| json!({"repository":repository,"digest":digest,"approvedAt":1}))
        .collect();
    std::fs::write(
        directory.0.join("worktrees.json"),
        serde_json::to_vec(&json!({"version":1,"approvals":approvals,"worktrees":[]})).unwrap(),
    )
    .unwrap();
    let store = Store::open(&directory.0).unwrap();
    (directory, store)
}

fn fixture_server(name: &str, cwd: &str) -> String {
    format!(
        "[[mcp.server]]\nname = \"{name}\"\ncommand = '{}'\nargs = [\"lines\", \"3e20\"]\nenv = [\"PATH\", \"MCP_FIXTURE_ABSENT_VARIABLE\"]\ncwd = \"{cwd}\"\n",
        display_path(process_fixture::executable())
    )
}

async fn journal() -> (Scratch, event_log::Service) {
    let directory = scratch("journal");
    let log = event_log::Service::open(directory.0.join("events.sqlite3"))
        .await
        .unwrap();
    (directory, log)
}

fn pool(log: &event_log::Service, processes: usize) -> Arc<Pool> {
    let pool = Pool::new(mcp_pool::Bounds {
        processes,
        ..mcp_pool::BOUNDS
    });
    pool.configure(log.clone());
    pool
}

#[test]
fn declarations_parse_with_defaults_and_enter_the_setup_digest_only_when_present() {
    let config = worktrees::parse(
        "[worktree]\nsetup = [\"npm ci\"]\n\n[[mcp.server]] # docs\nname = \"docs\"\ncommand = \"npx\"\nargs = [\n  \"-y\",\n  '@some/mcp-server',\n]\nenv = [\"HOME\", \"PATH\"]\ncwd = \"tools/docs\"\n\n[[mcp.server]]\nname = \"search_2\"\ncommand = \"node\"\n",
    )
    .unwrap();
    assert_eq!(
        config.mcp_servers,
        vec![
            Declaration {
                name: "docs".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "@some/mcp-server".into()],
                env: vec!["HOME".into(), "PATH".into()],
                cwd: "tools/docs".into(),
            },
            Declaration {
                name: "search_2".into(),
                command: "node".into(),
                args: Vec::new(),
                env: Vec::new(),
                cwd: ".".into(),
            },
        ]
    );
    let without = worktrees::Config {
        mcp_servers: Vec::new(),
        ..config.clone()
    };
    assert_eq!(
        without.digest(),
        worktrees::canonical_digest(
            &json!({"version":1,"policy":"platform-shell-v1","setup":["npm ci"],"run":[],"envFiles":[],"timeoutS":600})
        )
    );
    assert_ne!(config.digest(), without.digest());
    let spaced = worktrees::parse(
        "[[mcp.server]]\nname='docs'\ncommand='npx'\nargs=['-y','@some/mcp-server']\nenv=['HOME','PATH']\ncwd='tools/docs'\n[[mcp.server]]\nname='search_2'\ncommand='node'\ncwd='.'\n[worktree]\nsetup=['npm ci']\n",
    )
    .unwrap();
    assert_eq!(spaced.digest(), config.digest());
    let mut changed = config.clone();
    changed.mcp_servers[0].env.pop();
    assert_ne!(changed.digest(), config.digest());
    assert!(
        worktrees::parse("[[mcp.server]]\nname = \"docs\"\ncommand = \"node\"\n")
            .unwrap()
            .mcp_servers
            .len()
            == 1
    );
}

#[test]
fn invalid_declarations_are_refused_with_the_offending_rule() {
    let base =
        |extra: &str| format!("[[mcp.server]]\nname = \"docs\"\ncommand = \"node\"\n{extra}");
    let many: String = (0..=SERVER_LIMIT)
        .map(|index| format!("[[mcp.server]]\nname = \"s{index}\"\ncommand = \"node\"\n"))
        .collect();
    for (text, reason) in [
        (
            "[[mcp.server]]\ncommand = \"node\"\n".to_owned(),
            "needs a name",
        ),
        (
            "[[mcp.server]]\nname = \"Docs\"\ncommand = \"node\"\n".to_owned(),
            "lowercase",
        ),
        (
            "[[mcp.server]]\nname = \"nesvo\"\ncommand = \"node\"\n".to_owned(),
            "lowercase",
        ),
        (
            "[[mcp.server]]\nname = \"-docs\"\ncommand = \"node\"\n".to_owned(),
            "lowercase",
        ),
        (
            format!(
                "[[mcp.server]]\nname = \"{}\"\ncommand = \"node\"\n",
                "a".repeat(65)
            ),
            "lowercase",
        ),
        (
            "[[mcp.server]]\nname = \"docs\"\n".to_owned(),
            "needs a command",
        ),
        (
            "[[mcp.server]]\nname = \"docs\"\ncommand = \"./server\"\n".to_owned(),
            "absolute path",
        ),
        (
            "[[mcp.server]]\nname = \"docs\"\ncommand = \"tools/server\"\n".to_owned(),
            "absolute path",
        ),
        (
            "[[mcp.server]]\nname = \"docs\"\ncommand = \" node\"\n".to_owned(),
            "absolute path",
        ),
        (
            "[[mcp.server]]\nname = \"docs\"\ncommand = \"\"\n".to_owned(),
            "absolute path",
        ),
        (base("env = [\"NESVO_AGENT_CONTEXT\"]\n"), "NESVO_"),
        (base("env = [\"pocket_key\"]\n"), "NESVO_"),
        (base("env = [\"PATH\", \"path\"]\n"), "unique"),
        (base("env = [\"1PATH\"]\n"), "unique"),
        (base("env = [\"A-B\"]\n"), "unique"),
        (base("cwd = \"../outside\"\n"), "inside the repository"),
        (base("cwd = \"tools/../..\"\n"), "inside the repository"),
        (base("cwd = \"/absolute\"\n"), "inside the repository"),
        (base("cwd = \"C:/absolute\"\n"), "inside the repository"),
        (base("cwd = \"tools\\\\docs\"\n"), "inside the repository"),
        (base("cwd = \".git/hooks\"\n"), "inside the repository"),
        (base("cwd = \".nesvo\"\n"), "inside the repository"),
        (base("cwd = \"\"\n"), "inside the repository"),
        (base("args = [\"a\\nb\"]\n"), "single-line"),
        (
            base(&format!("args = [{}]\n", vec!["\"a\""; 65].join(","))),
            "single-line",
        ),
        (base("timeout_s = 5\n"), "unsupported key timeout_s"),
        (base("args = \"-y\"\n"), "wrong value type"),
        (base("name = \"again\"\n"), "duplicate key name"),
        (format!("{}{}", base(""), base("")), "declared twice"),
        (many, "at most 8"),
    ] {
        let error = worktrees::parse(&text).unwrap_err().to_string();
        assert!(error.contains(reason), "{text:?} -> {error}");
        assert!(error.contains(CONFIG_FILE), "{error}");
    }
}

#[test]
fn workflow_templates_skip_declared_servers() {
    let templates = crate::workflow_templates::parse(
        "[[mcp.server]]\nname = \"docs\"\ncommand = \"node\"\n\n[[workflow]]\nname = \"review\"\ngoal = \"Review\"\n\n[[workflow.task]]\nkey = \"review\"\ninstruction = \"Review\"\nprogram = \"claude\"\nworkspace = \"shared\"\n",
    )
    .unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(
        worktrees::parse(
            "[[workflow]]\nname = \"review\"\n[[mcp.server]]\nname = \"docs\"\ncommand = \"node\"\n"
        )
        .unwrap()
        .mcp_servers
        .len(),
        1
    );
}

#[test]
fn a_server_folder_must_resolve_inside_the_checkout() {
    let checkout = scratch("checkout");
    let outside = scratch("outside");
    std::fs::create_dir_all(checkout.0.join("tools/docs")).unwrap();
    let root = server_root(&checkout.0, "tools/docs").unwrap();
    assert_eq!(root, checkout.0.join("tools/docs").canonicalize().unwrap());
    assert_eq!(
        server_root(&checkout.0, ".").unwrap(),
        checkout.0.canonicalize().unwrap()
    );
    assert_eq!(server_root(&checkout.0, "missing"), Err("cwdUnavailable"));
    std::fs::write(checkout.0.join("file"), "x").unwrap();
    assert_eq!(server_root(&checkout.0, "file"), Err("cwdUnavailable"));
    if crate::registry_files::link_directory(&outside.0, &checkout.0.join("escape")) {
        assert_eq!(
            server_root(&checkout.0, "escape"),
            Err("cwdOutsideRepository")
        );
    }
}

#[test]
fn commands_resolve_on_the_host_path_or_as_absolute_files() {
    let fixture = process_fixture::executable();
    assert_eq!(
        locate(&display_path(fixture)).as_deref(),
        Some(PathBuf::from(display_path(fixture)).as_path())
    );
    assert_eq!(locate("nesvo-d5-missing-program"), None);
    assert_eq!(locate("tools/server"), None);
    let git = locate("git").expect("git on the host PATH");
    assert!(git.is_absolute());
    assert!(executable(&git));
}

#[test]
fn the_environment_holds_only_allowlisted_host_variables() {
    let checkout = scratch("env");
    let source = Source {
        repository: "C:/work/repo".into(),
        root: checkout.0.clone(),
        digest: "d".repeat(64),
        approved: true,
        declarations: Vec::new(),
        head: None,
    };
    let declaration = Declaration {
        name: "docs".into(),
        command: display_path(process_fixture::executable()),
        args: vec!["lines".into(), "3e20".into()],
        env: vec!["PATH".into(), "MCP_FIXTURE_ABSENT_VARIABLE".into()],
        cwd: ".".into(),
    };
    let spec = spec(Program::Claude, &source, &declaration).unwrap();
    assert_eq!(spec.env.keys().collect::<Vec<_>>(), ["PATH"]);
    assert_eq!(spec.env["PATH"], std::env::var("PATH").unwrap());
    assert_eq!(spec.root, checkout.0.canonicalize().unwrap());
    assert_eq!(
        spec.origin,
        Some(Origin {
            repository: "C:/work/repo".into(),
            digest: "d".repeat(64),
        })
    );
    let missing = Declaration {
        command: "nesvo-d5-missing-program".into(),
        ..declaration
    };
    assert_eq!(spec_error(&source, &missing), Some("commandUnavailable"));
}

fn spec_error(source: &Source, declaration: &Declaration) -> Option<&'static str> {
    spec(Program::Claude, source, declaration).err()
}

#[tokio::test]
async fn only_an_approved_head_digest_exposes_servers_through_bridge_leases() {
    let repo = repository(&format!(
        "{}{}",
        fixture_server("docs", "tools/docs"),
        fixture_server("missing", "nowhere")
    ));
    let root = repo.0.canonicalize().unwrap();
    let repository_key = worktrees::repository_key(&root);
    let (unapproved_dir, unapproved) = store(&[]);
    let source = resolve_head(Some(&unapproved), &repo.0, None)
        .await
        .unwrap();
    assert!(!source.approved);
    assert_eq!(source.repository, repository_key);
    let (_journal_dir, log) = journal().await;
    let pool = pool(&log, 4);
    let session = "a".repeat(32);
    let bridge = PathBuf::from("C:/host/nesvo-host.exe");
    assert!(
        expose(
            &pool,
            Program::Claude,
            &session,
            &source,
            &bridge,
            &unapproved_dir.0
        )
        .is_empty()
    );
    assert!(pool.attachments(&repository_key).is_empty());
    let (approved_dir, approved) = store(&[(&repository_key, &source.digest)]);
    let source = resolve_head(Some(&approved), &repo.0, None).await.unwrap();
    assert!(source.approved);
    let servers = expose(
        &pool,
        Program::Claude,
        &session,
        &source,
        &bridge,
        &approved_dir.0,
    );
    assert_eq!(servers.keys().collect::<Vec<_>>(), ["docs"]);
    let entry = &servers["docs"];
    assert_eq!(entry["type"], "stdio");
    assert_eq!(entry["command"], display_path(&bridge));
    assert_eq!(entry["args"][0], mcp_bridge::FLAG);
    let lease = mcp_bridge::read(Path::new(entry["args"][1].as_str().unwrap())).unwrap();
    assert_eq!(lease.server, "docs");
    assert_eq!(lease.lease, None);
    assert_eq!(lease.spawn.args, ["lines", "3e20"]);
    assert_eq!(
        lease.spawn.cwd,
        PathBuf::from(display_path(&root.join("tools").join("docs")))
    );
    assert_eq!(lease.spawn.env.keys().collect::<Vec<_>>(), ["PATH"]);
    let attached = pool.attachments(&repository_key);
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0]["server"], "docs");
    assert_eq!(attached[0]["mode"], "cold");
    assert_eq!(attached[0]["reason"], "notPrepared");
    let events = log.settled(1).await;
    assert_eq!(events[0].kind, "mcp.server_attached");
    assert_eq!(events[0].session_id.as_deref(), Some(session.as_str()));
    assert_eq!(
        events[0].payload,
        json!({"server":"docs","repository":repository_key,"digest":source.digest,"root":display_path(&root.join("tools").join("docs")),"mode":"cold","reason":"notPrepared","entryId":null})
    );
    let mut changes = pool.changes();
    while pool.status()["processes"]["warm"] != 1 {
        changes.changed().await.unwrap();
    }
    let second = "b".repeat(32);
    let pooled = expose(
        &pool,
        Program::Claude,
        &second,
        &source,
        &bridge,
        &approved_dir.0,
    );
    let lease = mcp_bridge::read(Path::new(pooled["docs"]["args"][1].as_str().unwrap())).unwrap();
    let endpoint = lease.lease.clone().expect("a pooled lease");
    assert_eq!(endpoint.token.len(), 64);
    assert!(mcp_bridge::approved(&lease.approval).await);
    let lease_file = PathBuf::from(pooled["docs"]["args"][1].as_str().unwrap());
    release(&second);
    assert!(!lease_file.exists());
    commit(&repo.0, &fixture_server("docs", "."));
    assert!(!mcp_bridge::approved(&lease.approval).await);
    assert_eq!(
        mcp_bridge::bridge(lease).await,
        mcp_bridge::APPROVAL_WITHDRAWN
    );
    let changed = resolve_head(Some(&approved), &repo.0, None).await.unwrap();
    assert!(!changed.approved);
    assert!(
        expose(
            &pool,
            Program::Claude,
            &"c".repeat(32),
            &changed,
            &bridge,
            &approved_dir.0
        )
        .is_empty()
    );
    release(&session);
    pool.shutdown().await;
    log.shutdown().await;
}

#[tokio::test]
async fn sessions_outside_a_repository_or_without_declarations_resolve_nothing() {
    let plain = scratch("plain");
    assert!(lookup(None, &"d".repeat(32), &plain.0).is_none());
    let repo = repository("[worktree]\nsetup = [\"npm ci\"]\n");
    assert!(lookup(None, &"d".repeat(32), &repo.0).is_some());
    assert!(resolve_head(None, &repo.0, None).await.is_none());
    let declared = repository(&fixture_server("docs", "."));
    let source = resolve_head(None, &declared.0.join("tools"), None)
        .await
        .unwrap();
    assert!(!source.approved);
    assert_eq!(source.declarations.len(), 1);
}

#[tokio::test]
async fn a_withdrawn_approval_refuses_the_bridge_and_removes_its_leases() {
    let repo = repository(&fixture_server("docs", "."));
    let repository_key = worktrees::repository_key(&repo.0.canonicalize().unwrap());
    let digest = resolve_head(None, &repo.0, None).await.unwrap().digest;
    let (registry, approved) = store(&[(&repository_key, &digest)]);
    let source = resolve_head(Some(&approved), &repo.0, None).await.unwrap();
    let (_journal_dir, log) = journal().await;
    let pool = pool(&log, 4);
    let session = "e".repeat(32);
    let servers = expose(
        &pool,
        Program::Claude,
        &session,
        &source,
        Path::new("C:/host/nesvo-host.exe"),
        &registry.0,
    );
    let file = PathBuf::from(servers["docs"]["args"][1].as_str().unwrap());
    let stale = mcp_bridge::read(&file).unwrap();
    assert_eq!(stale.approval.registry, registry.0);
    assert_eq!(stale.approval.repository, repository_key);
    assert_eq!(stale.approval.digest, digest);
    assert!(stale.approval.head.is_some());
    assert!(mcp_bridge::approved(&stale.approval).await);
    std::fs::write(
        registry.0.join("worktrees.json"),
        serde_json::to_vec(&json!({"version":1,"approvals":[],"worktrees":[]})).unwrap(),
    )
    .unwrap();
    assert!(!mcp_bridge::approved(&stale.approval).await);
    assert_eq!(
        mcp_bridge::bridge(stale.clone()).await,
        mcp_bridge::APPROVAL_WITHDRAWN
    );
    assert_eq!(invalidate(&repository_key, &"0".repeat(64)), 0);
    assert_eq!(invalidate(&repository_key, &digest), 1);
    assert!(!file.exists());
    assert!(mcp_bridge::read(&file).is_none());
    assert_eq!(invalidate(&repository_key, &digest), 0);
    let mut unknown = stale;
    unknown.approval.registry = scratch("no-registry").0.clone();
    assert!(!mcp_bridge::approved(&unknown.approval).await);
    release(&session);
    pool.shutdown().await;
    log.shutdown().await;
}

fn approval(directory: &Path) -> Approval {
    Approval {
        registry: directory.to_owned(),
        repository: "C:/work/repo".into(),
        digest: "d".repeat(64),
        head: None,
    }
}

#[test]
fn lease_files_round_trip_and_refuse_foreign_documents() {
    let directory = scratch("lease");
    let spec = Spec {
        program: Program::Claude,
        server: "docs".into(),
        command: PathBuf::from(display_path(process_fixture::executable())),
        args: vec!["lines".into()],
        env: BTreeMap::from([("PATH".to_owned(), "x".to_owned())]),
        root: directory.0.clone(),
        origin: None,
    };
    let pooled = json!({"mode":"pooled","entryId":"e","endpoint":r"\\.\pipe\nesvo-mcp-x","token":"f".repeat(64)});
    let path = directory.0.join("docs.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&lease_document(&spec, &pooled, approval(&directory.0))).unwrap(),
    )
    .unwrap();
    let lease = mcp_bridge::read(&path).unwrap();
    assert_eq!(
        lease.lease,
        Some(Endpoint {
            endpoint: r"\\.\pipe\nesvo-mcp-x".into(),
            token: "f".repeat(64),
        })
    );
    assert_eq!(lease.spawn.command, spec.command);
    assert_eq!(lease.approval, approval(&directory.0));
    let cold = lease_document(
        &spec,
        &json!({"mode":"cold","reason":"notPrepared"}),
        approval(&directory.0),
    );
    assert_eq!(cold.lease, None);
    let granted = serde_json::to_value(approval(&directory.0)).unwrap();
    for foreign in [
        json!({"version":2,"server":"docs","approval":granted,"lease":null,"spawn":{"command":display_path(&spec.command),"args":[],"cwd":display_path(&directory.0),"env":{}}}),
        json!({"version":1,"server":"docs","approval":granted,"lease":null,"spawn":{"command":"relative","args":[],"cwd":display_path(&directory.0),"env":{}}}),
        json!({"version":1,"server":"docs","approval":granted,"lease":null,"extra":1,"spawn":{"command":display_path(&spec.command),"args":[],"cwd":display_path(&directory.0),"env":{}}}),
        json!({"version":1,"server":"docs","lease":null,"spawn":{"command":display_path(&spec.command),"args":[],"cwd":display_path(&directory.0),"env":{}}}),
    ] {
        std::fs::write(&path, serde_json::to_vec(&foreign).unwrap()).unwrap();
        assert!(mcp_bridge::read(&path).is_none(), "{foreign}");
    }
    std::fs::write(&path, vec![b' '; 64 * 1024 + 1]).unwrap();
    assert!(mcp_bridge::read(&path).is_none());
}

#[tokio::test]
async fn the_listing_reports_declared_approval_and_attachment_state() {
    let repo = repository(&fixture_server("docs", "tools/docs"));
    let root = repo.0.canonicalize().unwrap();
    let repository_key = worktrees::repository_key(&root);
    let (_unapproved_dir, unapproved) = store(&[]);
    let listed = list(&unapproved, &display_path(&repo.0)).await.unwrap();
    assert_eq!(listed["type"], "mcpServers");
    assert_eq!(listed["repository"], repository_key);
    assert_eq!(listed["configured"], true);
    assert_eq!(listed["approved"], false);
    assert_eq!(listed["servers"][0]["name"], "docs");
    assert_eq!(listed["servers"][0]["state"], "unapproved");
    assert_eq!(listed["servers"][0]["problem"], Value::Null);
    assert_eq!(listed["bounds"]["serversPerRepository"], SERVER_LIMIT);
    let digest = listed["digest"].as_str().unwrap().to_owned();
    let (_approved_dir, approved) = store(&[(&repository_key, &digest)]);
    let listed = list(&approved, &display_path(&repo.0)).await.unwrap();
    assert_eq!(listed["approved"], true);
    assert_eq!(listed["servers"][0]["state"], "approved");
    let empty = repository("[worktree]\nrun = [\"npm run dev\"]\n");
    let listed = list(&approved, &display_path(&empty.0)).await.unwrap();
    assert_eq!(listed["configured"], false);
    assert_eq!(listed["servers"], json!([]));
    let invalid = repository("[[mcp.server]]\nname = \"Docs\"\ncommand = \"node\"\n");
    let error = list(&approved, &display_path(&invalid.0))
        .await
        .unwrap_err();
    assert_eq!(
        worktrees::error_code(&error),
        Some("worktree_config_invalid")
    );
}
