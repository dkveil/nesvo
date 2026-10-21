use crate::{launchers::Version, status::StatusState};
use anyhow::{Result, ensure};
use portable_pty::CommandBuilder;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const VERIFIED_VERSION: &str = "0.65.0";
pub const EXTENSION_NAME: &str = "nesvo-lifecycle";
pub const HOOK_FLAG: &str = "--gemini-context-hook";
pub const HELPER_ENV: &str = "NESVO_GEMINI_HOOK";
const REPORT_ENV: &str = "NESVO_LIFECYCLE_REPORT";
const SOURCE_DIRECTORY: &str = "gemini-extension";
const INSTALL_METADATA: &str = ".gemini-extension-install.json";
const METADATA_LIMIT: u64 = 4096;
const EVENTS: [&str; 6] = [
    "SessionStart",
    "BeforeAgent",
    "AfterAgent",
    "BeforeTool",
    "AfterTool",
    "Notification",
];
const SESSION_SELECTION_FLAGS: [&str; 4] = ["--session-id", "--resume", "-r", "--session-file"];

static SOURCE: OnceLock<PathBuf> = OnceLock::new();

pub fn supported(version: &str) -> bool {
    version == VERIFIED_VERSION
}

pub fn prepare(directory: &Path) -> Result<PathBuf> {
    let root = directory.join(SOURCE_DIRECTORY);
    write_source(&root)?;
    let _ = SOURCE.set(root.clone());
    Ok(root)
}

fn write_source(root: &Path) -> Result<bool> {
    let mut written = false;
    for (path, bytes) in source_files(root)? {
        if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::private_write(&path, &bytes)?;
        written = true;
    }
    Ok(written)
}

fn source_files(root: &Path) -> Result<[(PathBuf, Vec<u8>); 2]> {
    Ok([
        (
            root.join("gemini-extension.json"),
            serde_json::to_vec_pretty(&manifest())?,
        ),
        (
            root.join("hooks").join("hooks.json"),
            serde_json::to_vec_pretty(&hooks())?,
        ),
    ])
}

fn manifest() -> Value {
    json!({
        "name": EXTENSION_NAME,
        "version": "1.0.0",
        "description": "Reports lifecycle metadata to the nesvo host that launched this session. Inert in every other session."
    })
}

fn hook_command() -> String {
    if cfg!(windows) {
        format!("if ($env:{HELPER_ENV}) {{ & $env:{HELPER_ENV} {HOOK_FLAG} }}")
    } else {
        format!("if [ -n \"${HELPER_ENV}\" ]; then exec \"${HELPER_ENV}\" {HOOK_FLAG}; fi")
    }
}

fn hooks() -> Value {
    let handler = json!({
        "type": "command",
        "name": EXTENSION_NAME,
        "command": hook_command(),
        "timeout": 5000
    });
    let events = EVENTS
        .iter()
        .map(|event| ((*event).to_owned(), json!([{ "hooks": [handler.clone()] }])))
        .collect::<serde_json::Map<_, _>>();
    json!({ "hooks": events })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub ready: bool,
    pub verified_version: &'static str,
    pub version: Option<String>,
    pub extension: &'static str,
    pub extension_source: Option<String>,
    pub turn_identity: &'static str,
    pub reason: String,
}

pub fn gate(version: Option<&Version>) -> Gate {
    evaluate(
        version,
        SOURCE.get().map(PathBuf::as_path),
        gemini_home().as_deref(),
    )
}

fn gemini_home() -> Option<PathBuf> {
    let home = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    home("GEMINI_CLI_HOME")
        .or_else(|| home(if cfg!(windows) { "USERPROFILE" } else { "HOME" }))
        .map(PathBuf::from)
}

fn evaluate(version: Option<&Version>, source: Option<&Path>, home: Option<&Path>) -> Gate {
    let extension = match (source, home) {
        (None, _) => "sourceUnavailable",
        (Some(_), None) => "homeUnavailable",
        (Some(source), Some(home)) => extension_state(source, home),
    };
    let observed = version.and_then(|v| v.version.clone());
    let reason = match version {
        None => "Gemini CLI is not available on this host".to_owned(),
        Some(v) if v.status == "checking" => "Gemini version probe has not finished".to_owned(),
        Some(v) if v.status != "ready" => "Gemini version could not be read".to_owned(),
        Some(Version {
            version: Some(found),
            ..
        }) if !supported(found) => format!(
            "Gemini CLI {found} is unsupported; lifecycle hooks are verified only for {VERIFIED_VERSION}"
        ),
        Some(Version { version: None, .. }) => "Gemini version could not be read".to_owned(),
        Some(_) => match extension {
            "linked" => "lifecycle hooks configured; delivery is observed separately".to_owned(),
            "notLinked" => "nesvo Gemini extension is not linked; the owner links it once with gemini extensions link".to_owned(),
            "linkedElsewhere" => {
                "an extension with the nesvo name points to a different source".to_owned()
            }
            "sourceChanged" => "nesvo Gemini extension source differs from this host".to_owned(),
            "homeUnavailable" => "Gemini home directory is unknown".to_owned(),
            "sourceUnavailable" => "nesvo Gemini extension source was not prepared".to_owned(),
            _ => "Gemini extension metadata is unreadable".to_owned(),
        },
    };
    let ready = extension == "linked"
        && version
            .is_some_and(|v| v.status == "ready" && v.version.as_deref().is_some_and(supported));
    Gate {
        ready,
        verified_version: VERIFIED_VERSION,
        version: observed,
        extension,
        extension_source: source.map(crate::process::display_path),
        turn_identity: "unsupported",
        reason,
    }
}

fn extension_state(source: &Path, home: &Path) -> &'static str {
    let Ok(files) = source_files(source) else {
        return "sourceUnavailable";
    };
    if files
        .iter()
        .any(|(path, bytes)| std::fs::read(path).ok().as_deref() != Some(bytes.as_slice()))
    {
        return "sourceChanged";
    }
    let metadata = home
        .join(".gemini")
        .join("extensions")
        .join(EXTENSION_NAME)
        .join(INSTALL_METADATA);
    let file = match std::fs::File::open(metadata) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return "notLinked",
        Err(_) => return "unreadable",
    };
    let mut bytes = Vec::new();
    if file
        .take(METADATA_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > METADATA_LIMIT
    {
        return "unreadable";
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return "unreadable";
    };
    let linked = value["type"] == "link"
        && value["source"].as_str().is_some_and(|linked| {
            Path::new(linked)
                .canonicalize()
                .ok()
                .zip(source.canonicalize().ok())
                .is_some_and(|(linked, source)| linked == source)
        });
    if linked { "linked" } else { "linkedElsewhere" }
}

pub fn configure(command: &mut CommandBuilder, report: &Path) -> Result<String> {
    let session = session_id();
    let executable = std::env::current_exe()?;
    let argv = command.get_argv_mut();
    let index = argv
        .iter()
        .position(|arg| arg == "--prompt-interactive")
        .unwrap_or(argv.len());
    ensure!(
        !argv[..index]
            .iter()
            .any(|arg| SESSION_SELECTION_FLAGS.iter().any(|flag| arg == *flag)),
        "Gemini lifecycle hooks require a fresh native session"
    );
    argv.splice(
        index..index,
        ["--session-id".into(), session.clone().into()],
    );
    command.env(REPORT_ENV, report);
    command.env(HELPER_ENV, executable);
    Ok(session)
}

fn session_id() -> String {
    let mut bytes = crate::wire::random::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub fn allow_rebind(value: &Value) -> bool {
    value["hook_event_name"] == "SessionStart" && value["source"] == "clear"
}

pub fn state(value: &Value) -> Result<Option<StatusState>> {
    use StatusState::*;
    let Some(event) = value["hook_event_name"].as_str() else {
        return Ok(None);
    };
    let state = match event {
        "SessionStart" if value["source"] == "clear" => Idle,
        "SessionStart" => Unknown,
        "BeforeAgent" | "BeforeTool" | "AfterTool" => Working,
        "AfterAgent" => Idle,
        "Notification" if value["notification_type"] == "ToolPermission" => Blocked,
        _ => return Ok(None),
    };
    ensure!(
        value["session_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "Missing native Gemini session identity"
    );
    Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(status: &'static str, version: Option<&str>) -> Version {
        Version {
            program: crate::launchers::Program::Gemini,
            status,
            version: version.map(str::to_owned),
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-gemini-{label}-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn link(home: &Path, source: &Path, kind: &str) {
        let directory = home.join(".gemini").join("extensions").join(EXTENSION_NAME);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(INSTALL_METADATA),
            serde_json::to_vec(
                &json!({"source": crate::process::display_path(source), "type": kind}),
            )
            .unwrap(),
        )
        .unwrap();
    }

    fn synthesized_from_hook_reference(event: &str, session: &str, extra: Value) -> Value {
        let mut value = json!({
            "session_id": session,
            "transcript_path": "C:/fixture/never-read/session.jsonl",
            "cwd": "C:/fixture/workspace",
            "hook_event_name": event,
            "timestamp": "2026-10-21T21:30:00.000Z"
        });
        if let (Some(target), Value::Object(fields)) = (value.as_object_mut(), extra) {
            target.extend(fields);
        }
        value
    }

    #[test]
    fn gemini_version_gate_accepts_only_the_verified_release_with_explicit_reasons() {
        assert!(supported("0.65.0"));
        for other in [
            "0.64.0",
            "0.65.1",
            "0.66.0",
            "0.65.0-preview.1",
            "0.65.0-nightly",
            "",
        ] {
            assert!(!supported(other), "{other}");
        }
        let unsupported = evaluate(Some(&version("ready", Some("0.64.0"))), None, None);
        assert!(!unsupported.ready);
        assert_eq!(unsupported.turn_identity, "unsupported");
        assert!(unsupported.reason.contains("0.64.0"));
        assert!(unsupported.reason.contains(VERIFIED_VERSION));
        assert!(
            evaluate(Some(&version("checking", None)), None, None)
                .reason
                .contains("not finished")
        );
        assert!(
            evaluate(Some(&version("unavailable", None)), None, None)
                .reason
                .contains("could not be read")
        );
        assert!(evaluate(None, None, None).reason.contains("not available"));
    }

    #[test]
    fn gemini_launch_arguments_add_a_fresh_session_id_before_the_literal_prompt() {
        let report = Path::new("C:/private/nesvo-context-fixture/context.json");
        let mut first = CommandBuilder::new("gemini");
        first.args(["--prompt-interactive", "--session-id literal ; $x"]);
        let id = configure(&mut first, report).unwrap();
        let argv: Vec<_> = first
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            [
                "gemini",
                "--session-id",
                id.as_str(),
                "--prompt-interactive",
                "--session-id literal ; $x"
            ]
        );
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
        assert!(!argv.iter().any(|arg| arg.contains("nesvo-context-fixture")));
        assert_eq!(first.get_env(REPORT_ENV).unwrap(), report.as_os_str());
        assert!(first.get_env(HELPER_ENV).is_some());
        let mut second = CommandBuilder::new("gemini");
        assert_ne!(configure(&mut second, report).unwrap(), id);
        assert_eq!(second.get_argv().len(), 3);
        let mut resumed = CommandBuilder::new("gemini");
        resumed.args(["--resume", "latest"]);
        assert!(configure(&mut resumed, report).is_err());
    }

    #[test]
    fn gemini_extension_source_is_constant_inert_and_lists_only_lifecycle_events() {
        let hooks = hooks();
        let events: Vec<_> = hooks["hooks"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let mut expected: Vec<_> = EVENTS.iter().map(|e| (*e).to_owned()).collect();
        expected.sort();
        assert_eq!(events, expected);
        for event in EVENTS {
            let handler = &hooks["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["type"], "command");
            assert_eq!(handler["timeout"], 5000);
            assert!(hooks["hooks"][event][0].get("matcher").is_none());
            let command = handler["command"].as_str().unwrap();
            assert!(command.contains(HELPER_ENV));
            assert!(command.contains(HOOK_FLAG));
            assert!(!command.contains("${"));
            assert!(!command.contains("$GEMINI_"));
            assert!(!command.contains("nesvo-context-"));
            assert!(!command.contains("--yolo") && !command.contains("--consent"));
        }
        for absent in ["StopFailure", "Interrupt", "AfterModel", "BeforeModel"] {
            assert!(hooks["hooks"].get(absent).is_none());
        }
        assert_eq!(manifest()["name"], EXTENSION_NAME);
        use clap::Parser;
        assert!(
            crate::Args::try_parse_from(["nesvo-host", HOOK_FLAG])
                .unwrap()
                .gemini_context_hook
        );
        let root = scratch("source").join(SOURCE_DIRECTORY);
        assert!(write_source(&root).unwrap());
        assert!(!write_source(&root).unwrap());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn gemini_gate_requires_the_owner_link_to_the_current_source_and_version() {
        let base = scratch("gate");
        let source = base.join(SOURCE_DIRECTORY);
        let home = base.join("home");
        write_source(&source).unwrap();
        let verified = version("ready", Some(VERIFIED_VERSION));
        let missing = evaluate(Some(&verified), Some(&source), Some(&home));
        assert_eq!((missing.ready, missing.extension), (false, "notLinked"));
        assert!(missing.reason.contains("gemini extensions link"));
        assert!(
            !home.join(".gemini").exists(),
            "the gate never writes Gemini configuration"
        );
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        link(&home, &other, "link");
        assert_eq!(
            evaluate(Some(&verified), Some(&source), Some(&home)).extension,
            "linkedElsewhere"
        );
        link(&home, &source, "local");
        assert_eq!(
            evaluate(Some(&verified), Some(&source), Some(&home)).extension,
            "linkedElsewhere"
        );
        link(&home, &source, "link");
        let ready = evaluate(Some(&verified), Some(&source), Some(&home));
        assert!(ready.ready, "{}", ready.reason);
        assert!(
            !evaluate(
                Some(&version("ready", Some("0.64.0"))),
                Some(&source),
                Some(&home)
            )
            .ready
        );
        std::fs::write(source.join("hooks").join("hooks.json"), b"{\"hooks\":{}}").unwrap();
        let changed = evaluate(Some(&verified), Some(&source), Some(&home));
        assert_eq!((changed.ready, changed.extension), (false, "sourceChanged"));
        write_source(&source).unwrap();
        std::fs::write(
            home.join(".gemini")
                .join("extensions")
                .join(EXTENSION_NAME)
                .join(INSTALL_METADATA),
            vec![b' '; METADATA_LIMIT as usize + 1],
        )
        .unwrap();
        assert_eq!(
            evaluate(Some(&verified), Some(&source), Some(&home)).extension,
            "unreadable"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_synthesized_hook_payloads_map_to_conservative_states() {
        use StatusState::*;
        let root = "6f1c2a4e-8d3b-4c7a-9e21-0b5d7f3a9c12";
        for (event, extra, expected) in [
            ("SessionStart", json!({"source": "startup"}), Some(Unknown)),
            ("SessionStart", json!({"source": "resume"}), Some(Unknown)),
            ("SessionStart", json!({"source": "clear"}), Some(Idle)),
            ("BeforeAgent", json!({"prompt": "PRIVATE"}), Some(Working)),
            (
                "BeforeTool",
                json!({"tool_name": "run_shell_command"}),
                Some(Working),
            ),
            (
                "AfterTool",
                json!({"tool_name": "read_file"}),
                Some(Working),
            ),
            (
                "AfterAgent",
                json!({"prompt": "PRIVATE", "prompt_response": "PRIVATE", "stop_hook_active": false}),
                Some(Idle),
            ),
            (
                "Notification",
                json!({"notification_type": "ToolPermission", "message": "PRIVATE", "details": {}}),
                Some(Blocked),
            ),
            ("Notification", json!({"notification_type": "Other"}), None),
            ("SessionEnd", json!({"reason": "exit"}), None),
            ("PreCompress", json!({"trigger": "auto"}), None),
            ("AfterModel", json!({}), None),
            ("Stop", json!({}), None),
            ("StopFailure", json!({}), None),
            ("Interrupt", json!({}), None),
        ] {
            assert_eq!(
                state(&synthesized_from_hook_reference(event, root, extra)).unwrap(),
                expected,
                "{event}"
            );
        }
        assert!(state(&json!({"hook_event_name": "BeforeAgent"})).is_err());
        assert!(state(&json!({"hook_event_name": "AfterAgent", "session_id": ""})).is_err());
        assert!(allow_rebind(
            &json!({"hook_event_name": "SessionStart", "source": "clear"})
        ));
        for source in ["startup", "resume", "compact"] {
            assert!(!allow_rebind(
                &json!({"hook_event_name": "SessionStart", "source": source})
            ));
        }
    }

    #[test]
    fn gemini_journal_binds_the_expected_root_and_fences_foreign_and_cleared_sessions() {
        let mut command = CommandBuilder::new("gemini");
        let tracker =
            crate::agent_context::Tracker::install_gemini(&mut command, "host-session").unwrap();
        assert_eq!(tracker.adapter(), "gemini-hooks-v1");
        let root = command.get_argv()[2].to_string_lossy().into_owned();
        let report = tracker.report();
        let deliver = |value: Value| {
            crate::agent_context::receive_gemini_from(&report, value.to_string().as_bytes())
        };
        let foreign = "11111111-2222-4333-8444-555555555555";
        deliver(synthesized_from_hook_reference(
            "SessionStart",
            foreign,
            json!({"source": "startup"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "BeforeAgent",
            foreign,
            json!({"prompt": "PRIVATE_PROMPT_SENTINEL"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "SessionStart",
            foreign,
            json!({"source": "resume"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "SessionStart",
            &root,
            json!({"source": "startup"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "BeforeAgent",
            &root,
            json!({"prompt": "PRIVATE_PROMPT_SENTINEL"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference("BeforeTool", &root, json!({"tool_name": "run_shell_command", "tool_input": {"command": "PRIVATE_TOOL_SENTINEL"}}))).unwrap();
        deliver(synthesized_from_hook_reference("Notification", &root, json!({"notification_type": "ToolPermission", "message": "PRIVATE_TOOL_SENTINEL", "details": {}}))).unwrap();
        deliver(synthesized_from_hook_reference(
            "AfterTool",
            &root,
            json!({"tool_name": "run_shell_command"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference("AfterAgent", &root, json!({"prompt": "PRIVATE_PROMPT_SENTINEL", "prompt_response": "PRIVATE_RESPONSE_SENTINEL", "stop_hook_active": false}))).unwrap();
        let batch = crate::agent_events::read(&report, "host-session", 0).unwrap();
        assert_eq!(
            batch.identity.provider_session_id.as_deref(),
            Some(root.as_str())
        );
        assert_eq!(batch.identity.generation, 1);
        assert_eq!(batch.identity.rejected, 3);
        let observed: Vec<_> = batch
            .events
            .iter()
            .map(|event| (event.name.as_str(), event.state))
            .collect();
        assert_eq!(
            observed,
            [
                ("SessionStart", StatusState::Unknown),
                ("BeforeAgent", StatusState::Working),
                ("BeforeTool", StatusState::Working),
                ("Notification", StatusState::Blocked),
                ("AfterTool", StatusState::Working),
                ("AfterAgent", StatusState::Idle),
            ]
        );
        assert!(
            batch
                .events
                .iter()
                .all(|event| event.prompt_digest.is_none() && event.paste_digest.is_none())
        );
        let cleared = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        deliver(synthesized_from_hook_reference(
            "SessionStart",
            cleared,
            json!({"source": "clear"}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "AfterAgent",
            &root,
            json!({"stop_hook_active": false}),
        ))
        .unwrap();
        deliver(synthesized_from_hook_reference(
            "BeforeAgent",
            cleared,
            json!({"prompt": "x"}),
        ))
        .unwrap();
        let batch = crate::agent_events::read(&report, "host-session", 6).unwrap();
        assert_eq!(batch.identity.provider_session_id.as_deref(), Some(cleared));
        assert_eq!(batch.identity.generation, 2);
        assert_eq!(batch.identity.rejected, 4);
        let observed: Vec<_> = batch
            .events
            .iter()
            .map(|event| (event.name.as_str(), event.state, event.generation))
            .collect();
        assert_eq!(
            observed,
            [
                ("SessionStart", StatusState::Idle, 2),
                ("BeforeAgent", StatusState::Working, 2),
            ]
        );
        for entry in std::fs::read_dir(report.parent().unwrap()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes);
            assert!(
                !text.contains("PRIVATE_"),
                "lifecycle storage must not keep payload text"
            );
        }
    }

    fn run_like_provider_shell(env: &[(&str, &std::ffi::OsStr)], input: &[u8]) -> (i32, String) {
        use std::io::Write;
        let mut shell = if cfg!(windows) {
            let mut shell = std::process::Command::new("powershell.exe");
            shell.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "{}; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}",
                    hook_command()
                ),
            ]);
            shell
        } else {
            let mut shell = std::process::Command::new("bash");
            shell.args(["-c", &hook_command()]);
            shell
        };
        shell
            .env_remove(HELPER_ENV)
            .env_remove(REPORT_ENV)
            .envs(env.iter().copied())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = shell.spawn().unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.stderr.is_empty(), "the helper must not write stderr");
        (
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        )
    }

    #[test]
    #[ignore = "requires a built nesvo-host binary; runs the provider's documented hook shell without Gemini"]
    fn gemini_hook_command_delivers_raw_stdin_through_the_provider_shell_and_stays_inert_elsewhere()
    {
        let helper = std::env::var_os("NESVO_HOST_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_exe()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join(format!("nesvo-host{}", std::env::consts::EXE_SUFFIX))
            });
        assert!(
            helper.is_file(),
            "build nesvo-host first: {}",
            helper.display()
        );
        assert_eq!(run_like_provider_shell(&[], b"{}"), (0, String::new()));
        let mut command = CommandBuilder::new("gemini");
        let tracker =
            crate::agent_context::Tracker::install_gemini(&mut command, "host-session").unwrap();
        let root = command.get_argv()[2].to_string_lossy().into_owned();
        let report = tracker.report();
        let payload = synthesized_from_hook_reference(
            "BeforeAgent",
            &root,
            json!({"prompt": "zażółć 'quoted' $x ; & spaces"}),
        );
        let env = [
            (HELPER_ENV, helper.as_os_str()),
            (REPORT_ENV, report.as_os_str()),
        ];
        assert_eq!(
            run_like_provider_shell(&env, payload.to_string().as_bytes()),
            (0, "{}".to_owned())
        );
        assert_eq!(
            run_like_provider_shell(&env, b"not json"),
            (0, "{}".to_owned())
        );
        let batch = crate::agent_events::read(&report, "host-session", 0).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].name, "BeforeAgent");
        assert_eq!(batch.events[0].state, StatusState::Working);
        assert!(report.with_file_name("diagnostic.json").exists());
    }

    #[test]
    fn gemini_helper_input_failures_are_bounded_and_record_only_a_constant_marker() {
        let mut command = CommandBuilder::new("gemini");
        let tracker =
            crate::agent_context::Tracker::install_gemini(&mut command, "host-session").unwrap();
        let report = tracker.report();
        let diagnostic = report.with_file_name("diagnostic.json");
        assert!(
            crate::agent_context::receive_gemini_from(
                &report,
                &b"{\"hook_event_name\":PRIVATE"[..]
            )
            .is_err()
        );
        let marker = std::fs::read_to_string(&diagnostic).unwrap();
        assert!(!marker.contains("PRIVATE"));
        let oversized = vec![b' '; 2 * 1024 * 1024 + 1];
        crate::agent_context::receive_gemini_from(&report, oversized.as_slice()).unwrap();
        assert!(!diagnostic.exists());
        assert!(
            crate::agent_events::read(&report, "host-session", 0)
                .unwrap()
                .events
                .is_empty()
        );
    }
}
