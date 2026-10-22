use crate::{
    launchers::{Demand, Launchers, Program, Version},
    refreshing_cache::{RefreshingCache, refresh_in_background},
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

pub(crate) const REFRESH: Duration = Duration::from_secs(2);
const SETTINGS_LIMIT: u64 = 256 * 1024;
const PROVIDERS: [Program; 3] = [Program::Claude, Program::Codex, Program::Gemini];
const CLAUDE_ENVIRONMENT: [&str; 6] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];
const CODEX_ENVIRONMENT: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];
const GEMINI_ENVIRONMENT: [&str; 5] = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_APPLICATION_CREDENTIALS",
];
const HOME_UNKNOWN: &str = "the provider home directory is unknown to the host";
const ENVIRONMENT_CREDENTIAL: &str =
    "a credential variable is set in the host environment; the host does not validate it";

static EVIDENCE: Mutex<RefreshingCache<Evidence>> = Mutex::new(RefreshingCache::new(REFRESH));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ok,
    NoCli,
    NotLoggedIn,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Availability {
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Login {
    Stored,
    Missing(&'static str),
    Unknown(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Evidence {
    claude: Login,
    codex: Login,
    gemini: Login,
}

impl Evidence {
    fn observe(context: &Context) -> Self {
        Self {
            claude: claude_login(context),
            codex: codex_login(context),
            gemini: gemini_login(context),
        }
    }

    fn login(&self, program: Program) -> Option<Login> {
        match program {
            Program::Claude => Some(self.claude),
            Program::Codex => Some(self.codex),
            Program::Gemini => Some(self.gemini),
            Program::Shell => None,
        }
    }
}

struct Context {
    claude: Option<PathBuf>,
    codex: Option<PathBuf>,
    gemini: Option<PathBuf>,
    keychain: bool,
    environment: Vec<&'static str>,
}

impl Context {
    fn current() -> Self {
        let path = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let home =
            path(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).or_else(|| path("HOME"));
        let environment = CLAUDE_ENVIRONMENT
            .into_iter()
            .chain(CODEX_ENVIRONMENT)
            .chain(GEMINI_ENVIRONMENT)
            .filter(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
            .collect();
        Self {
            claude: path("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude"))),
            codex: path("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
            gemini: path("GEMINI_CLI_HOME")
                .or_else(|| home.clone())
                .map(|h| h.join(".gemini")),
            keychain: cfg!(target_os = "macos"),
            environment,
        }
    }

    fn credential_variable(&self, keys: &[&str]) -> bool {
        self.environment.iter().any(|key| keys.contains(key))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Presence {
    Present,
    Absent,
    Unreadable,
}

fn presence(path: &Path) -> Presence {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Presence::Present,
        Ok(_) => Presence::Unreadable,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Presence::Absent,
        Err(_) => Presence::Unreadable,
    }
}

fn mentions(path: &Path, needles: &[&str]) -> Option<bool> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(false),
        Err(_) => return None,
    };
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(SETTINGS_LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > SETTINGS_LIMIT {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    Some(needles.iter().any(|needle| text.contains(needle)))
}

fn claude_login(context: &Context) -> Login {
    let Some(directory) = &context.claude else {
        return Login::Unknown(HOME_UNKNOWN);
    };
    match presence(&directory.join(".credentials.json")) {
        Presence::Present => return Login::Stored,
        Presence::Unreadable => {
            return Login::Unknown("the Claude credentials file could not be inspected");
        }
        Presence::Absent => {}
    }
    if context.keychain {
        return Login::Unknown(
            "Claude keeps its login in the macOS Keychain, which the host does not inspect",
        );
    }
    if context.credential_variable(&CLAUDE_ENVIRONMENT) {
        return Login::Unknown(ENVIRONMENT_CREDENTIAL);
    }
    match mentions(&directory.join("settings.json"), &["apiKeyHelper"]) {
        Some(false) => {
            Login::Missing("Claude has no stored login; sign in with /login after launch")
        }
        Some(true) => {
            Login::Unknown("Claude settings configure apiKeyHelper, which the host does not run")
        }
        None => Login::Unknown("Claude settings could not be inspected"),
    }
}

fn codex_login(context: &Context) -> Login {
    let Some(home) = &context.codex else {
        return Login::Unknown(HOME_UNKNOWN);
    };
    match presence(&home.join("auth.json")) {
        Presence::Present => return Login::Stored,
        Presence::Unreadable => {
            return Login::Unknown("the Codex auth.json could not be inspected");
        }
        Presence::Absent => {}
    }
    if context.credential_variable(&CODEX_ENVIRONMENT) {
        return Login::Unknown(ENVIRONMENT_CREDENTIAL);
    }
    match mentions(&home.join("config.toml"), &["cli_auth_credentials_store"]) {
        Some(false) => Login::Missing("Codex has no stored login; sign in after launch"),
        Some(true) => {
            Login::Unknown("Codex config selects a credential store the host does not inspect")
        }
        None => Login::Unknown("Codex config.toml could not be inspected"),
    }
}

fn gemini_login(context: &Context) -> Login {
    let Some(directory) = &context.gemini else {
        return Login::Unknown(HOME_UNKNOWN);
    };
    match presence(&directory.join("oauth_creds.json")) {
        Presence::Present => return Login::Stored,
        Presence::Unreadable => {
            return Login::Unknown("the Gemini OAuth credentials file could not be inspected");
        }
        Presence::Absent => {}
    }
    if context.credential_variable(&GEMINI_ENVIRONMENT) {
        return Login::Unknown(ENVIRONMENT_CREDENTIAL);
    }
    if presence(&directory.join("google_accounts.json")) != Presence::Absent {
        return Login::Unknown(
            "Gemini records a Google account without a credentials file the host can inspect",
        );
    }
    match mentions(
        &directory.join("settings.json"),
        &["selectedType", "selectedAuthType"],
    ) {
        Some(false) => {
            Login::Missing("Gemini has no stored login or auth method; choose one after launch")
        }
        Some(true) => Login::Unknown(
            "Gemini selects an auth method whose credential the host does not inspect",
        ),
        None => Login::Unknown("Gemini settings could not be inspected"),
    }
}

fn missing_cli(program: Program) -> &'static str {
    match program {
        Program::Claude => {
            "claude was not found on the host PATH; install Claude Code and restart the host"
        }
        Program::Codex => {
            "codex was not found on the host PATH; install Codex and restart the host"
        }
        Program::Gemini => {
            "gemini was not found on the host PATH; install Gemini CLI and restart the host"
        }
        Program::Shell => "no shell was found on the host",
    }
}

fn resolve(
    program: Program,
    installed: bool,
    version: Option<&Version>,
    login: Option<Login>,
) -> Availability {
    let availability = |state, reason: Option<&str>| Availability {
        state,
        version: version
            .filter(|version| version.status == "ready")
            .and_then(|version| version.version.clone()),
        reason: reason.map(str::to_owned),
    };
    if !installed {
        return Availability {
            state: State::NoCli,
            version: None,
            reason: Some(missing_cli(program).to_owned()),
        };
    }
    if version.is_some_and(|version| version.status == "unavailable") {
        return availability(
            State::Unknown,
            Some("the version command failed; the host retries it at the next launch"),
        );
    }
    match login {
        None => availability(State::Unknown, Some("the login check has not finished")),
        Some(Login::Stored) => availability(State::Ok, None),
        Some(Login::Missing(reason)) => availability(State::NotLoggedIn, Some(reason)),
        Some(Login::Unknown(reason)) => availability(State::Unknown, Some(reason)),
    }
}

fn report(launchers: &Launchers, versions: &[Version], evidence: Option<Evidence>) -> Value {
    let providers: Map<String, Value> = PROVIDERS
        .into_iter()
        .map(|program| {
            let availability = resolve(
                program,
                launchers.available(program),
                versions.iter().find(|version| version.program == program),
                evidence.and_then(|evidence| evidence.login(program)),
            );
            (
                serde_json::to_value(program)
                    .ok()
                    .and_then(|name| name.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                serde_json::to_value(availability).unwrap_or(Value::Null),
            )
        })
        .collect();
    Value::Object(providers)
}

fn cached() -> Option<Evidence> {
    let (evidence, due) = EVIDENCE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim(Instant::now(), |_| true);
    if due {
        refresh_in_background(&EVIDENCE, "provider-availability", || {
            Evidence::observe(&Context::current())
        });
    }
    evidence
}

pub fn warm() {
    cached();
}

pub fn capabilities(launchers: &Launchers, versions: &[Version]) -> Value {
    for version in versions
        .iter()
        .filter(|version| version.status == "unavailable")
    {
        launchers.request_version(version.program, Demand::Availability);
    }
    report(launchers, versions, cached())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nesvo-provider-availability-{}",
                hex::encode(crate::wire::random::<8>())
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn binary(&self, name: &str) {
            let file = if cfg!(windows) {
                format!("bin/{name}.exe")
            } else {
                format!("bin/{name}")
            };
            let path = self.file(&file, "fake provider binary");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            #[cfg(not(unix))]
            let _ = path;
        }

        fn context(&self, environment: Vec<&'static str>) -> Context {
            Context {
                claude: Some(self.0.join("claude")),
                codex: Some(self.0.join("codex")),
                gemini: Some(self.0.join("gemini")),
                keychain: false,
                environment,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ready(program: Program, version: &str) -> Version {
        Version {
            program,
            status: "ready",
            version: Some(version.into()),
        }
    }

    fn state(value: &Value, provider: &str) -> String {
        value[provider]["state"].as_str().unwrap().to_owned()
    }

    #[test]
    fn provider_availability_reports_no_cli_for_absent_fake_binaries() {
        let fixture = Fixture::new();
        fixture.binary("claude");
        fixture.file("claude/.credentials.json", "{}");
        let launchers = Launchers::locate(&[fixture.0.join("bin")]);
        let evidence = Evidence::observe(&fixture.context(Vec::new()));
        let report = report(
            &launchers,
            &[ready(Program::Claude, "2.1.3")],
            Some(evidence),
        );
        assert_eq!(state(&report, "claude"), "ok");
        assert_eq!(report["claude"]["version"], "2.1.3");
        assert!(report["claude"].get("reason").is_none());
        for provider in ["codex", "gemini"] {
            assert_eq!(state(&report, provider), "noCli");
            assert!(report[provider].get("version").is_none());
            assert!(
                report[provider]["reason"]
                    .as_str()
                    .unwrap()
                    .contains("not found on the host PATH")
            );
        }
        assert_eq!(report.as_object().unwrap().len(), 3);
    }

    #[test]
    fn provider_availability_ok_needs_a_stored_credentials_file_per_provider() {
        let fixture = Fixture::new();
        for name in ["claude", "codex", "gemini"] {
            fixture.binary(name);
        }
        fixture.file("claude/.credentials.json", "not read");
        fixture.file("codex/auth.json", "not read");
        fixture.file("gemini/oauth_creds.json", "not read");
        let launchers = Launchers::locate(&[fixture.0.join("bin")]);
        let evidence = Evidence::observe(&fixture.context(vec!["ANTHROPIC_API_KEY"]));
        let report = report(&launchers, &[], Some(evidence));
        for provider in ["claude", "codex", "gemini"] {
            assert_eq!(state(&report, provider), "ok", "{provider}");
            assert!(report[provider].get("version").is_none());
        }
    }

    #[test]
    fn provider_availability_not_logged_in_only_on_deterministic_absence() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("claude")).unwrap();
        fs::create_dir_all(fixture.0.join("codex")).unwrap();
        fixture.file("claude/settings.json", r#"{"theme":"dark"}"#);
        fixture.file("codex/config.toml", "model = \"gpt\"\n");
        let evidence = Evidence::observe(&fixture.context(Vec::new()));
        assert!(matches!(evidence.claude, Login::Missing(_)));
        assert!(matches!(evidence.codex, Login::Missing(_)));
        assert!(matches!(evidence.gemini, Login::Missing(_)));
        let available = resolve(
            Program::Gemini,
            true,
            Some(&ready(Program::Gemini, "0.65.0")),
            Some(evidence.gemini),
        );
        assert_eq!(available.state, State::NotLoggedIn);
        assert_eq!(available.version.as_deref(), Some("0.65.0"));
        assert!(available.reason.unwrap().contains("after launch"));
    }

    #[test]
    fn provider_availability_unknown_when_login_may_live_elsewhere() {
        let fixture = Fixture::new();
        let environment = fixture.context(vec![
            "ANTHROPIC_AUTH_TOKEN",
            "CODEX_API_KEY",
            "GEMINI_API_KEY",
        ]);
        let evidence = Evidence::observe(&environment);
        for login in [evidence.claude, evidence.codex, evidence.gemini] {
            assert_eq!(login, Login::Unknown(ENVIRONMENT_CREDENTIAL));
        }
        fixture.file("claude/settings.json", r#"{"apiKeyHelper":"~/bin/key"}"#);
        fixture.file(
            "codex/config.toml",
            "cli_auth_credentials_store = \"keyring\"\n",
        );
        fixture.file(
            "gemini/settings.json",
            r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
        );
        let evidence = Evidence::observe(&fixture.context(Vec::new()));
        assert!(
            matches!(evidence.claude, Login::Unknown(reason) if reason.contains("apiKeyHelper"))
        );
        assert!(
            matches!(evidence.codex, Login::Unknown(reason) if reason.contains("credential store"))
        );
        assert!(
            matches!(evidence.gemini, Login::Unknown(reason) if reason.contains("auth method"))
        );
        fixture.file("gemini/settings.json", "{}");
        fixture.file("gemini/google_accounts.json", "{}");
        assert!(matches!(
            gemini_login(&fixture.context(Vec::new())),
            Login::Unknown(reason) if reason.contains("Google account")
        ));
        let keychain = Context {
            keychain: true,
            ..fixture.context(Vec::new())
        };
        assert!(
            matches!(claude_login(&keychain), Login::Unknown(reason) if reason.contains("Keychain"))
        );
        let homeless = Context {
            claude: None,
            codex: None,
            gemini: None,
            keychain: false,
            environment: Vec::new(),
        };
        let evidence = Evidence::observe(&homeless);
        for login in [evidence.claude, evidence.codex, evidence.gemini] {
            assert_eq!(login, Login::Unknown(HOME_UNKNOWN));
        }
    }

    #[test]
    fn provider_availability_unreadable_or_oversized_evidence_is_unknown() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("claude/.credentials.json")).unwrap();
        fs::create_dir_all(fixture.0.join("codex")).unwrap();
        fixture.file(
            "codex/config.toml",
            &"#".repeat(SETTINGS_LIMIT as usize + 1),
        );
        fs::create_dir_all(fixture.0.join("gemini/settings.json")).unwrap();
        let evidence = Evidence::observe(&fixture.context(Vec::new()));
        assert!(
            matches!(evidence.claude, Login::Unknown(reason) if reason.contains("credentials file"))
        );
        assert!(matches!(evidence.codex, Login::Unknown(reason) if reason.contains("config.toml")));
        assert!(matches!(evidence.gemini, Login::Unknown(reason) if reason.contains("settings")));
    }

    #[test]
    fn provider_availability_pending_or_failed_probes_stay_unknown() {
        let pending = resolve(Program::Codex, true, None, None);
        assert_eq!(pending.state, State::Unknown);
        assert!(pending.reason.unwrap().contains("has not finished"));
        let failed = Version {
            program: Program::Codex,
            status: "unavailable",
            version: None,
        };
        let broken = resolve(Program::Codex, true, Some(&failed), Some(Login::Stored));
        assert_eq!(broken.state, State::Unknown);
        assert!(broken.reason.unwrap().contains("version command failed"));
        let checking = Version {
            program: Program::Codex,
            status: "checking",
            version: None,
        };
        let stored = resolve(Program::Codex, true, Some(&checking), Some(Login::Stored));
        assert_eq!(stored.state, State::Ok);
        assert_eq!(stored.version, None);
        assert_eq!(
            serde_json::to_value(resolve(Program::Gemini, false, None, Some(Login::Stored)))
                .unwrap()["state"],
            "noCli"
        );
    }

    #[test]
    fn provider_availability_read_requests_a_retry_of_each_failed_version_probe() {
        let fixture = Fixture::new();
        let mut launchers = Launchers::locate(&[fixture.0.join("bin")]);
        let (prober, mut requests) = crate::launchers::VersionProber::channel();
        launchers.attach_prober(prober);
        let failed = Version {
            program: Program::Codex,
            status: "unavailable",
            version: None,
        };
        let pending = Version {
            program: Program::Gemini,
            status: "checking",
            version: None,
        };
        capabilities(
            &launchers,
            &[ready(Program::Claude, "2.1.303"), failed, pending],
        );
        assert_eq!(
            requests.try_next(),
            Some((Program::Codex, Demand::Availability))
        );
        assert_eq!(requests.try_next(), None);
    }

    #[test]
    fn provider_availability_capabilities_read_only_launchers_and_the_cache() {
        let fixture = Fixture::new();
        let launchers = Launchers::locate(&[fixture.0.join("bin")]);
        warm();
        let value = capabilities(&launchers, &[]);
        assert_eq!(value.as_object().unwrap().len(), 3);
        for provider in ["claude", "codex", "gemini"] {
            assert_eq!(state(&value, provider), "noCli", "{provider}");
        }
    }
}
