use crate::{
    launchers::Version,
    refreshing_cache::{RefreshingCache, observe_into, refresh_in_background},
    status::StatusState,
};
use anyhow::{Result, ensure};
use portable_pty::CommandBuilder;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

pub const VERIFIED_VERSION: &str = "0.65.0";
pub const EXTENSION_NAME: &str = "nesvo-lifecycle";
pub const HOOK_FLAG: &str = "--gemini-context-hook";
const PAIRING_FLAG: &str = "--pairing-dir";
const LEGACY_HELPER_ENV: &str = "NESVO_GEMINI_HOOK";
const REPORT_ENV: &str = "NESVO_LIFECYCLE_REPORT";
const REPORT_FILE: &str = "context.json";
const SOURCE_DIRECTORY: &str = "gemini-extension";
const LAUNCH_DIRECTORY: &str = "gemini-launches";
const HOST_RECORD: &str = "gemini-host.json";
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

fn selects_session(arg: &OsStr) -> bool {
    let arg = arg.to_string_lossy();
    SESSION_SELECTION_FLAGS.iter().any(|flag| {
        arg.strip_prefix(flag)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
    })
}

const EXTENSION_REFRESH: Duration = Duration::from_secs(2);

static PREPARED: OnceLock<Prepared> = OnceLock::new();
static EXTENSION: Mutex<RefreshingCache<(PathBuf, &'static str)>> =
    Mutex::new(RefreshingCache::new(EXTENSION_REFRESH));

fn claim_extension(home: &Path) -> (Option<&'static str>, bool) {
    let (observed, refresh) = EXTENSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim(Instant::now(), |(cached, _)| cached == home);
    (observed.map(|(_, state)| state), refresh)
}

fn observe_extension(prepared: &Prepared, home: PathBuf) -> (PathBuf, &'static str) {
    let state = extension_state(prepared, &home);
    (home, state)
}

fn cached_extension(prepared: &'static Prepared, home: PathBuf) -> &'static str {
    let (state, refresh) = claim_extension(&home);
    if refresh {
        refresh_in_background(&EXTENSION, "gemini-extension", move || {
            observe_extension(prepared, home)
        });
    }
    state.unwrap_or("checking")
}

#[derive(Clone, Debug)]
pub struct Prepared {
    root: PathBuf,
    launches: PathBuf,
    pairing: PathBuf,
    executable: PathBuf,
}

impl Prepared {
    pub fn launches(&self) -> &Path {
        &self.launches
    }
}

pub fn supported(version: &str) -> bool {
    version == VERIFIED_VERSION
}

pub fn prepare(directory: &Path) -> Result<PathBuf> {
    let prepared = prepare_for(directory, &std::env::current_exe()?)?;
    let root = prepared.root.clone();
    let _ = PREPARED.set(prepared);
    if let (Some(prepared), Some(home)) = (PREPARED.get(), gemini_home()) {
        claim_extension(&home);
        observe_into(&EXTENSION, || observe_extension(prepared, home));
    }
    Ok(root)
}

pub fn prepared() -> Result<&'static Prepared> {
    PREPARED
        .get()
        .ok_or_else(|| anyhow::anyhow!("nesvo Gemini extension source was not prepared"))
}

fn prepare_for(directory: &Path, executable: &Path) -> Result<Prepared> {
    let pairing = directory.canonicalize()?;
    let executable = executable.canonicalize()?;
    ensure!(
        [&pairing, &executable]
            .iter()
            .all(|path| literal(&crate::process::display_path(path))),
        "Gemini hook paths must not contain quotes, dollar signs, backticks or control characters"
    );
    let prepared = Prepared {
        root: pairing.join(SOURCE_DIRECTORY),
        launches: pairing.join(LAUNCH_DIRECTORY),
        pairing,
        executable,
    };
    reset_launches(&prepared.launches)?;
    crate::private_write(
        &prepared.pairing.join(HOST_RECORD),
        &serde_json::to_vec(
            &json!({ "executable": crate::process::display_path(&prepared.executable) }),
        )?,
    )?;
    write_source(&prepared)?;
    Ok(prepared)
}

fn literal(path: &str) -> bool {
    !path
        .chars()
        .any(|c| c.is_control() || matches!(c, '\'' | '"' | '`' | '$' | '\u{2018}'..='\u{201F}'))
}

fn reset_launches(launches: &Path) -> Result<()> {
    std::fs::create_dir_all(launches)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(launches, std::fs::Permissions::from_mode(0o700))?;
    }
    for entry in std::fs::read_dir(launches)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && crate::agent_context::launch_directory_name(&entry.file_name())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn write_source(prepared: &Prepared) -> Result<bool> {
    let mut written = false;
    for (path, bytes) in source_files(prepared)? {
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

fn source_files(prepared: &Prepared) -> Result<[(PathBuf, Vec<u8>); 2]> {
    Ok([
        (
            prepared.root.join("gemini-extension.json"),
            serde_json::to_vec_pretty(&manifest())?,
        ),
        (
            prepared.root.join("hooks").join("hooks.json"),
            serde_json::to_vec_pretty(&hooks(prepared))?,
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

fn hook_command(prepared: &Prepared) -> String {
    let executable = crate::process::display_path(&prepared.executable);
    let pairing = crate::process::display_path(&prepared.pairing);
    let invoke = if cfg!(windows) { "&" } else { "exec" };
    format!("{invoke} '{executable}' {HOOK_FLAG} {PAIRING_FLAG} '{pairing}'")
}

fn hooks(prepared: &Prepared) -> Value {
    let handler = json!({
        "type": "command",
        "name": EXTENSION_NAME,
        "command": hook_command(prepared),
        "timeout": 5000
    });
    let events = EVENTS
        .iter()
        .map(|event| ((*event).to_owned(), json!([{ "hooks": [handler.clone()] }])))
        .collect::<serde_json::Map<_, _>>();
    json!({ "hooks": events })
}

pub fn receive_hook(pairing: Option<&Path>) {
    let report = std::env::var_os(REPORT_ENV);
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    if let Some(report) = accepted_report(pairing, &executable, report.as_deref()) {
        let _ = crate::agent_context::receive_gemini(&report);
    }
}

fn accepted_report(
    pairing: Option<&Path>,
    executable: &Path,
    report: Option<&OsStr>,
) -> Option<PathBuf> {
    let pairing = pairing?.canonicalize().ok()?;
    if executable.canonicalize().ok()? != recorded_executable(&pairing)?.canonicalize().ok()? {
        return None;
    }
    let report = Path::new(report?);
    if !report.is_absolute() || report.file_name()? != REPORT_FILE {
        return None;
    }
    let scope = report.parent()?.canonicalize().ok()?;
    let launches = pairing.join(LAUNCH_DIRECTORY).canonicalize().ok()?;
    if scope.parent()? != launches
        || !crate::agent_context::launch_directory_name(scope.file_name()?)
    {
        return None;
    }
    let report = scope.join(REPORT_FILE);
    crate::scoped_context::load(&report)
        .ok()?
        .journal_backed()
        .then_some(report)
}

fn recorded_executable(pairing: &Path) -> Option<PathBuf> {
    let mut bytes = Vec::new();
    std::fs::File::open(pairing.join(HOST_RECORD))
        .ok()?
        .take(METADATA_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > METADATA_LIMIT {
        return None;
    }
    serde_json::from_slice::<Value>(&bytes).ok()?["executable"]
        .as_str()
        .map(PathBuf::from)
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
    let prepared = PREPARED.get();
    let extension = match (prepared, gemini_home()) {
        (None, _) => "sourceUnavailable",
        (Some(_), None) => "homeUnavailable",
        (Some(prepared), Some(home)) => cached_extension(prepared, home),
    };
    assemble(version, prepared, extension)
}

fn gemini_home() -> Option<PathBuf> {
    let home = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    home("GEMINI_CLI_HOME")
        .or_else(|| home(if cfg!(windows) { "USERPROFILE" } else { "HOME" }))
        .map(PathBuf::from)
}

#[cfg(test)]
fn evaluate(version: Option<&Version>, prepared: Option<&Prepared>, home: Option<&Path>) -> Gate {
    let extension = match (prepared, home) {
        (None, _) => "sourceUnavailable",
        (Some(_), None) => "homeUnavailable",
        (Some(prepared), Some(home)) => extension_state(prepared, home),
    };
    assemble(version, prepared, extension)
}

fn assemble(
    version: Option<&Version>,
    prepared: Option<&Prepared>,
    extension: &'static str,
) -> Gate {
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
            "stale" => format!(
                "nesvo Gemini hook command changed after the extension was linked because the host executable moved; the owner relinks once with gemini extensions uninstall {EXTENSION_NAME} and gemini extensions link"
            ),
            "sourceChanged" => "nesvo Gemini extension source differs from this host".to_owned(),
            "homeUnavailable" => "Gemini home directory is unknown".to_owned(),
            "checking" => "nesvo Gemini extension link is being checked".to_owned(),
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
        extension_source: prepared.map(|prepared| crate::process::display_path(&prepared.root)),
        turn_identity: "unsupported",
        reason,
    }
}

fn extension_state(prepared: &Prepared, home: &Path) -> &'static str {
    let Ok(files) = source_files(prepared) else {
        return "sourceUnavailable";
    };
    let mut written = SystemTime::UNIX_EPOCH;
    for (path, bytes) in &files {
        if std::fs::read(path).ok().as_ref() != Some(bytes) {
            return "sourceChanged";
        }
        if let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) {
            written = written.max(modified);
        }
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
    let linked_at = file.metadata().and_then(|m| m.modified()).ok();
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
                .zip(prepared.root.canonicalize().ok())
                .is_some_and(|(linked, source)| linked == source)
        });
    if !linked {
        "linkedElsewhere"
    } else if linked_at.is_none_or(|at| at < written) {
        "stale"
    } else {
        "linked"
    }
}

pub fn configure(command: &mut CommandBuilder, report: &Path) -> Result<String> {
    let session = session_id();
    let argv = command.get_argv_mut();
    let index = argv
        .iter()
        .position(|arg| arg == "--prompt-interactive")
        .unwrap_or(argv.len());
    ensure!(
        !argv[..index].iter().any(|arg| selects_session(arg)),
        "Gemini lifecycle hooks require a fresh native session"
    );
    argv.splice(
        index..index,
        ["--session-id".into(), session.clone().into()],
    );
    command.env(REPORT_ENV, report);
    command.env_remove(LEGACY_HELPER_ENV);
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

    fn pairing(label: &str) -> (PathBuf, Prepared) {
        let base = scratch(label);
        let prepared = prepare_for(&base, &std::env::current_exe().unwrap()).unwrap();
        (base, prepared)
    }

    fn install_metadata(home: &Path) -> PathBuf {
        home.join(".gemini")
            .join("extensions")
            .join(EXTENSION_NAME)
            .join(INSTALL_METADATA)
    }

    fn link(home: &Path, source: &Path, kind: &str) {
        let path = install_metadata(home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(
                &json!({"source": crate::process::display_path(source), "type": kind}),
            )
            .unwrap(),
        )
        .unwrap();
    }

    fn set_modified(path: &Path, offset: i64) {
        let now = SystemTime::now();
        let delta = std::time::Duration::from_secs(offset.unsigned_abs());
        let at = if offset < 0 { now - delta } else { now + delta };
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    fn age_source(prepared: &Prepared, offset: i64) {
        for (path, _) in source_files(prepared).unwrap() {
            set_modified(&path, offset);
        }
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
        first.env(LEGACY_HELPER_ENV, "C:/hostile/payload.exe");
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
        assert!(first.get_env(LEGACY_HELPER_ENV).is_none());
        let mut second = CommandBuilder::new("gemini");
        assert_ne!(configure(&mut second, report).unwrap(), id);
        assert_eq!(second.get_argv().len(), 3);
        let mut resumed = CommandBuilder::new("gemini");
        resumed.args(["--resume", "latest"]);
        assert!(configure(&mut resumed, report).is_err());
    }

    #[test]
    fn gemini_launch_refuses_session_selection_in_the_equals_form() {
        let report = Path::new("C:/private/nesvo-context-fixture/context.json");
        for selection in [
            "--session-id=0f8fad5b-d9cb-469f-a165-70867728950e",
            "--resume=latest",
            "-r=latest",
            "--session-file=C:/saved.json",
        ] {
            let mut command = CommandBuilder::new("gemini");
            command.arg(selection);
            assert!(configure(&mut command, report).is_err(), "{selection}");
        }
        for unrelated in ["--resumed", "--session-identity", "-rf"] {
            assert!(!selects_session(OsStr::new(unrelated)), "{unrelated}");
        }
    }

    #[test]
    fn gemini_extension_cache_refreshes_at_most_every_two_seconds_per_home() {
        let mut cache = RefreshingCache::new(EXTENSION_REFRESH);
        let home = Path::new("C:/home/owner");
        let current = |(cached, _): &(PathBuf, &str)| cached == home;
        let start = Instant::now();
        assert_eq!(cache.claim(start, current), (None, true));
        assert_eq!(cache.claim(start, current), (None, false));
        cache.store((home.to_path_buf(), "linked"), start);
        let within = start + EXTENSION_REFRESH - Duration::from_millis(1);
        assert!(!cache.claim(within, current).1);
        let due = start + EXTENSION_REFRESH;
        assert!(cache.claim(due, current).1);
        assert!(!cache.claim(due, current).1);
        cache.store((home.to_path_buf(), "notLinked"), due);
        assert_eq!(
            cache.claim(due, current),
            (Some((home.to_path_buf(), "notLinked")), false)
        );
        let other = |(cached, _): &(PathBuf, &str)| cached == Path::new("C:/home/other");
        assert_eq!(cache.claim(due, other), (None, true));
        assert!(!assemble(None, None, "checking").ready);
        assert!(
            assemble(
                Some(&version("ready", Some(VERIFIED_VERSION))),
                None,
                "checking"
            )
            .reason
            .contains("being checked")
        );
    }

    #[test]
    fn gemini_extension_source_runs_the_recorded_absolute_host_and_no_environment_command() {
        let (base, prepared) = pairing("source");
        let executable =
            crate::process::display_path(&std::env::current_exe().unwrap().canonicalize().unwrap());
        let directory = crate::process::display_path(&base.canonicalize().unwrap());
        assert!(Path::new(&executable).is_absolute());
        let hooks = hooks(&prepared);
        let events: Vec<_> = hooks["hooks"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let mut expected: Vec<_> = EVENTS.iter().map(|e| (*e).to_owned()).collect();
        expected.sort();
        assert_eq!(events, expected);
        let invoke = if cfg!(windows) { "&" } else { "exec" };
        for event in EVENTS {
            let handler = &hooks["hooks"][event][0]["hooks"][0];
            assert_eq!(handler["type"], "command");
            assert_eq!(handler["timeout"], 5000);
            assert!(hooks["hooks"][event][0].get("matcher").is_none());
            let command = handler["command"].as_str().unwrap();
            assert_eq!(
                command,
                format!("{invoke} '{executable}' {HOOK_FLAG} {PAIRING_FLAG} '{directory}'")
            );
            assert!(!command.contains('$') && !command.contains("env:"));
            assert!(!command.contains(LEGACY_HELPER_ENV) && !command.contains(REPORT_ENV));
            assert!(!command.contains("nesvo-context-"));
            assert!(!command.contains("--yolo") && !command.contains("--consent"));
        }
        for absent in ["StopFailure", "Interrupt", "AfterModel", "BeforeModel"] {
            assert!(hooks["hooks"].get(absent).is_none());
        }
        assert_eq!(manifest()["name"], EXTENSION_NAME);
        let written = std::fs::read(prepared.root.join("hooks").join("hooks.json")).unwrap();
        assert_eq!(written, serde_json::to_vec_pretty(&hooks).unwrap());
        assert_eq!(
            recorded_executable(&base.canonicalize().unwrap())
                .unwrap()
                .canonicalize()
                .unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        assert!(prepared.launches().is_dir());
        use clap::Parser;
        let parsed =
            crate::Args::try_parse_from(["nesvo-host", HOOK_FLAG, PAIRING_FLAG, &directory])
                .unwrap();
        assert!(parsed.gemini_context_hook);
        assert_eq!(parsed.pairing_dir.as_deref(), Some(Path::new(&directory)));
        assert!(!write_source(&prepared).unwrap());
        let quoted = base.join("it's $HOME");
        std::fs::create_dir_all(&quoted).unwrap();
        assert!(prepare_for(&quoted, &std::env::current_exe().unwrap()).is_err());
        assert!(!quoted.join(SOURCE_DIRECTORY).exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_gate_requires_the_owner_link_to_the_current_source_and_version() {
        let (base, prepared) = pairing("gate");
        let source = prepared.root.clone();
        let home = base.join("home");
        age_source(&prepared, -60);
        let verified = version("ready", Some(VERIFIED_VERSION));
        let missing = evaluate(Some(&verified), Some(&prepared), Some(&home));
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
            evaluate(Some(&verified), Some(&prepared), Some(&home)).extension,
            "linkedElsewhere"
        );
        link(&home, &source, "local");
        assert_eq!(
            evaluate(Some(&verified), Some(&prepared), Some(&home)).extension,
            "linkedElsewhere"
        );
        link(&home, &source, "link");
        let ready = evaluate(Some(&verified), Some(&prepared), Some(&home));
        assert!(ready.ready, "{}", ready.reason);
        assert!(
            !evaluate(
                Some(&version("ready", Some("0.64.0"))),
                Some(&prepared),
                Some(&home)
            )
            .ready
        );
        std::fs::write(source.join("hooks").join("hooks.json"), b"{\"hooks\":{}}").unwrap();
        let changed = evaluate(Some(&verified), Some(&prepared), Some(&home));
        assert_eq!((changed.ready, changed.extension), (false, "sourceChanged"));
        write_source(&prepared).unwrap();
        std::fs::write(
            install_metadata(&home),
            vec![b' '; METADATA_LIMIT as usize + 1],
        )
        .unwrap();
        assert_eq!(
            evaluate(Some(&verified), Some(&prepared), Some(&home)).extension,
            "unreadable"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_link_turns_stale_with_a_reason_when_the_host_executable_path_changes() {
        let (base, first) = pairing("stale");
        let home = base.join("home");
        let verified = version("ready", Some(VERIFIED_VERSION));
        age_source(&first, -60);
        link(&home, &first.root, "link");
        set_modified(&install_metadata(&home), -30);
        assert!(evaluate(Some(&verified), Some(&first), Some(&home)).ready);
        let same = prepare_for(&base, &std::env::current_exe().unwrap()).unwrap();
        assert!(evaluate(Some(&verified), Some(&same), Some(&home)).ready);
        let moved = base.join("moved").join("nesvo-host.exe");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::write(&moved, b"fixture").unwrap();
        let second = prepare_for(&base, &moved).unwrap();
        let command = hook_command(&second);
        assert!(command.contains(&crate::process::display_path(
            &moved.canonicalize().unwrap()
        )));
        let stale = evaluate(Some(&verified), Some(&second), Some(&home));
        assert_eq!((stale.ready, stale.extension), (false, "stale"));
        assert!(stale.reason.contains("relinks once"));
        assert!(stale.reason.contains("gemini extensions link"));
        assert_eq!(
            evaluate(Some(&verified), Some(&first), Some(&home)).extension,
            "sourceChanged"
        );
        link(&home, &second.root, "link");
        set_modified(&install_metadata(&home), 30);
        assert!(evaluate(Some(&verified), Some(&second), Some(&home)).ready);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_helper_accepts_only_an_existing_launch_report_inside_the_pairing_directory() {
        let (base, prepared) = pairing("helper");
        let directory = base.canonicalize().unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut command = CommandBuilder::new("gemini");
        let tracker = crate::agent_context::Tracker::install_gemini_in(
            &mut command,
            "host-session",
            &prepared,
        )
        .unwrap();
        let report = tracker.report();
        assert_eq!(
            report
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap(),
            prepared.launches().canonicalize().unwrap()
        );
        assert_eq!(command.get_env(REPORT_ENV).unwrap(), report.as_os_str());
        let accept = |pairing: Option<&Path>, executable: &Path, report: Option<&OsStr>| {
            accepted_report(pairing, executable, report)
        };
        assert_eq!(
            accept(Some(&directory), &executable, Some(report.as_os_str())),
            Some(
                report
                    .parent()
                    .unwrap()
                    .canonicalize()
                    .unwrap()
                    .join(REPORT_FILE)
            )
        );
        let mut outside_command = CommandBuilder::new("claude");
        let outside =
            crate::agent_context::Tracker::install_for(&mut outside_command, "host-session")
                .unwrap();
        let missing = prepared
            .launches()
            .join(format!("nesvo-context-{}", "0".repeat(32)))
            .join(REPORT_FILE);
        let unscoped = prepared
            .launches()
            .join(format!("nesvo-context-{}", "1".repeat(32)));
        std::fs::create_dir_all(&unscoped).unwrap();
        let other = base.join("other.exe");
        std::fs::write(&other, b"fixture").unwrap();
        for (pairing, executable, candidate) in [
            (None, executable.as_path(), Some(report.as_os_str())),
            (Some(directory.as_path()), executable.as_path(), None),
            (
                Some(directory.as_path()),
                executable.as_path(),
                Some(outside.report().as_os_str()),
            ),
            (
                Some(directory.as_path()),
                executable.as_path(),
                Some(missing.as_os_str()),
            ),
            (
                Some(directory.as_path()),
                executable.as_path(),
                Some(unscoped.join(REPORT_FILE).as_os_str()),
            ),
            (
                Some(directory.as_path()),
                executable.as_path(),
                Some(report.with_file_name("events.sqlite3").as_os_str()),
            ),
            (
                Some(directory.as_path()),
                executable.as_path(),
                Some(OsStr::new("relative/context.json")),
            ),
            (
                Some(directory.as_path()),
                other.as_path(),
                Some(report.as_os_str()),
            ),
            (
                Some(base.join("home").as_path()),
                executable.as_path(),
                Some(report.as_os_str()),
            ),
        ] {
            assert_eq!(
                accept(pairing, executable, candidate),
                None,
                "{candidate:?}"
            );
        }
        assert!(
            crate::agent_events::read(&outside.report(), "host-session", 0)
                .unwrap()
                .events
                .is_empty()
        );
        drop(outside);
        drop(tracker);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_restart_removes_only_previous_launch_directories() {
        let (base, prepared) = pairing("restart");
        let stale = prepared
            .launches()
            .join(format!("nesvo-context-{}", "a".repeat(32)));
        let foreign = prepared.launches().join("owner-notes");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&foreign).unwrap();
        prepare_for(&base, &std::env::current_exe().unwrap()).unwrap();
        assert!(!stale.exists());
        assert!(foreign.is_dir());
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
        let (base, prepared) = pairing("journal");
        let mut command = CommandBuilder::new("gemini");
        let tracker = crate::agent_context::Tracker::install_gemini_in(
            &mut command,
            "host-session",
            &prepared,
        )
        .unwrap();
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
        drop(tracker);
        std::fs::remove_dir_all(base).unwrap();
    }

    fn run_like_provider_shell(
        prepared: &Prepared,
        env: &[(&str, &std::ffi::OsStr)],
        input: &[u8],
    ) -> (i32, String) {
        use std::io::Write;
        let mut shell = if cfg!(windows) {
            let mut shell = std::process::Command::new("powershell.exe");
            shell.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "{}; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}",
                    hook_command(prepared)
                ),
            ]);
            shell
        } else {
            let mut shell = std::process::Command::new("bash");
            shell.args(["-c", &hook_command(prepared)]);
            shell
        };
        shell
            .env_remove(LEGACY_HELPER_ENV)
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

    fn hostile_program(directory: &Path, sentinel: &Path) -> PathBuf {
        let sentinel = crate::process::display_path(sentinel);
        if cfg!(windows) {
            let path = directory.join("hostile.cmd");
            std::fs::write(&path, format!("@echo off\r\necho hit> \"{sentinel}\"\r\n")).unwrap();
            path
        } else {
            let path = directory.join("hostile.sh");
            std::fs::write(&path, format!("#!/bin/sh\necho hit > '{sentinel}'\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            path
        }
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
        let base = scratch("shell");
        let prepared = prepare_for(&base, &helper).unwrap();
        let sentinel = base.join("hostile-ran");
        let hostile = hostile_program(&base, &sentinel);
        let hostile_env = [(LEGACY_HELPER_ENV, hostile.as_os_str())];
        assert_eq!(
            run_like_provider_shell(&prepared, &hostile_env, b"{}"),
            (0, "{}".to_owned())
        );
        let mut command = CommandBuilder::new("gemini");
        let tracker = crate::agent_context::Tracker::install_gemini_in(
            &mut command,
            "host-session",
            &prepared,
        )
        .unwrap();
        let root = command.get_argv()[2].to_string_lossy().into_owned();
        let report = tracker.report();
        let payload = synthesized_from_hook_reference(
            "BeforeAgent",
            &root,
            json!({"prompt": "zażółć 'quoted' $x ; & spaces"}),
        );
        let mut outside_command = CommandBuilder::new("claude");
        let outside =
            crate::agent_context::Tracker::install_for(&mut outside_command, "host-session")
                .unwrap();
        let outside_report = outside.report();
        let foreign = [
            (LEGACY_HELPER_ENV, hostile.as_os_str()),
            (REPORT_ENV, outside_report.as_os_str()),
        ];
        assert_eq!(
            run_like_provider_shell(&prepared, &foreign, payload.to_string().as_bytes()),
            (0, "{}".to_owned())
        );
        assert!(
            crate::agent_events::read(&outside.report(), "host-session", 0)
                .unwrap()
                .events
                .is_empty()
        );
        let env = [
            (LEGACY_HELPER_ENV, hostile.as_os_str()),
            (REPORT_ENV, report.as_os_str()),
        ];
        assert_eq!(
            run_like_provider_shell(&prepared, &env, payload.to_string().as_bytes()),
            (0, "{}".to_owned())
        );
        assert_eq!(
            run_like_provider_shell(&prepared, &env, b"not json"),
            (0, "{}".to_owned())
        );
        assert!(
            !sentinel.exists(),
            "the hook must never run NESVO_GEMINI_HOOK"
        );
        let batch = crate::agent_events::read(&report, "host-session", 0).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].name, "BeforeAgent");
        assert_eq!(batch.events[0].state, StatusState::Working);
        assert!(report.with_file_name("diagnostic.json").exists());
        drop(outside);
        drop(tracker);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn gemini_hook_cwd_sets_no_current_cwd_context() {
        let (base, prepared) = pairing("cwd");
        let mut command = CommandBuilder::new("gemini");
        let tracker = crate::agent_context::Tracker::install_gemini_in(
            &mut command,
            "host-session",
            &prepared,
        )
        .unwrap();
        let root = command.get_argv()[2].to_string_lossy().into_owned();
        let report = tracker.report();
        let directory = base.canonicalize().unwrap();
        for (event, extra) in [
            ("SessionStart", json!({"source": "startup"})),
            ("BeforeAgent", json!({"prompt": "PRIVATE_PROMPT_SENTINEL"})),
        ] {
            let mut value = synthesized_from_hook_reference(event, &root, extra);
            value["cwd"] = json!(directory);
            crate::agent_context::receive_gemini_from(&report, value.to_string().as_bytes())
                .unwrap();
        }
        assert_eq!(
            crate::agent_events::read(&report, "host-session", 0)
                .unwrap()
                .events
                .len(),
            2
        );
        assert!(
            crate::agent_context::observe_working_directory(&report)
                .await
                .is_none()
        );
        assert!(!report.with_file_name("cwd.json").exists());
        drop(tracker);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn gemini_helper_input_failures_are_bounded_and_record_only_a_constant_marker() {
        let (base, prepared) = pairing("input");
        let mut command = CommandBuilder::new("gemini");
        let tracker = crate::agent_context::Tracker::install_gemini_in(
            &mut command,
            "host-session",
            &prepared,
        )
        .unwrap();
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
        drop(tracker);
        std::fs::remove_dir_all(base).unwrap();
    }
}
