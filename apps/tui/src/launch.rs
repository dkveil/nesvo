use crate::session_kind::SessionKind;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

const MODEL_ADVERTISED_EFFORTS: [&str; 3] = ["low", "medium", "high"];

#[derive(Clone, Debug, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    #[default]
    Shell,
    Claude,
    Gemini,
    Codex,
}

impl Program {
    pub const ALL: [Self; 4] = [Self::Shell, Self::Claude, Self::Gemini, Self::Codex];

    pub fn icon(self, ascii: bool) -> &'static str {
        match (self, ascii) {
            (Self::Claude, false) => "✳",
            (Self::Codex, false) => "◈",
            (Self::Gemini, false) => "✦",
            (Self::Shell, _) => ">",
            (Self::Claude, true) => "C",
            (Self::Codex, true) => "O",
            (Self::Gemini, true) => "G",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Shell => "Terminal",
            Self::Claude => "Claude",
            Self::Gemini => "Gemini",
            Self::Codex => "Codex",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ProgramCapability {
    pub id: Program,
    pub available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percent: u8,
    pub duration_mins: u32,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ProviderLimit {
    pub id: Program,
    pub status: String,
    pub windows: Vec<LimitWindow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSupport {
    pub program: Program,
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub effort_values: Option<Vec<String>>,
    #[serde(default)]
    pub effort_source: Option<String>,
}

fn profile_support<'de, D>(deserializer: D) -> Result<Vec<ProfileSupport>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<Value>>::deserialize(deserializer)?
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .collect())
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderState {
    Ok,
    NoCli,
    NotLoggedIn,
    #[default]
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProviderAvailability {
    #[serde(default)]
    pub state: ProviderState,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl ProviderAvailability {
    pub fn label(&self) -> String {
        match (self.state, self.version.as_deref()) {
            (ProviderState::Ok, Some(version)) => format!("ok · {version}"),
            (ProviderState::Ok, None) => "ok".into(),
            (ProviderState::NoCli, _) => "CLI not found".into(),
            (ProviderState::NotLoggedIn, _) => "not logged in".into(),
            (ProviderState::Unknown, _) => "login unknown".into(),
        }
    }

    pub fn hint(&self) -> Option<String> {
        let reason = self.reason.as_deref().unwrap_or("no detail from the host");
        match self.state {
            ProviderState::Ok => None,
            ProviderState::NoCli => Some(format!("Cannot launch: {reason}")),
            ProviderState::NotLoggedIn | ProviderState::Unknown => {
                Some(format!("Launch allowed · {reason}"))
            }
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct Providers {
    #[serde(default, deserialize_with = "provider_availability")]
    pub claude: Option<ProviderAvailability>,
    #[serde(default, deserialize_with = "provider_availability")]
    pub codex: Option<ProviderAvailability>,
    #[serde(default, deserialize_with = "provider_availability")]
    pub gemini: Option<ProviderAvailability>,
}

fn provider_availability<'de, D>(deserializer: D) -> Result<Option<ProviderAvailability>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(deserializer)?
        .and_then(|entry| serde_json::from_value(entry).ok()))
}

fn providers<'de, D>(deserializer: D) -> Result<Providers, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Value>::deserialize(deserializer)?
        .and_then(|entry| serde_json::from_value(entry).ok())
        .unwrap_or_default())
}

#[derive(Default, Debug, Deserialize)]
pub struct Capabilities {
    pub workspace: String,
    pub programs: Vec<ProgramCapability>,
    #[serde(default, rename = "directoryBrowser")]
    pub directory_browser: bool,
    #[serde(default, rename = "gitDiff")]
    pub git_diff: bool,
    #[serde(default, rename = "advancedLaunch")]
    pub advanced_launch: bool,
    #[serde(default)]
    pub schedules: bool,
    #[serde(default)]
    pub attention: bool,
    #[serde(default)]
    pub templates: bool,
    #[serde(default)]
    pub recovery: bool,
    #[serde(default, rename = "quotaWake")]
    pub quota_wake: bool,
    #[serde(default)]
    pub hibernation: bool,
    #[serde(default, rename = "providerLimits")]
    pub provider_limits: Vec<ProviderLimit>,
    #[serde(default, rename = "sessionModelProfiles")]
    pub session_model_profiles: bool,
    #[serde(
        default,
        rename = "launchProfileSupport",
        deserialize_with = "profile_support"
    )]
    pub launch_profile_support: Vec<ProfileSupport>,
    #[serde(default, deserialize_with = "providers")]
    pub providers: Providers,
}

impl Capabilities {
    pub fn available(&self, program: Program) -> bool {
        self.programs
            .iter()
            .any(|item| item.id == program && item.available)
            && self
                .provider(program)
                .is_none_or(|provider| provider.state != ProviderState::NoCli)
    }

    pub fn provider(&self, program: Program) -> Option<&ProviderAvailability> {
        match program {
            Program::Claude => self.providers.claude.as_ref(),
            Program::Codex => self.providers.codex.as_ref(),
            Program::Gemini => self.providers.gemini.as_ref(),
            Program::Shell => None,
        }
    }

    pub fn launch_refusal(&self, program: Program) -> Option<String> {
        if self.available(program) {
            return None;
        }
        Some(
            match self
                .provider(program)
                .and_then(|provider| provider.reason.as_deref())
            {
                Some(reason) => format!("Cannot launch: {reason}."),
                None => "This program is unavailable on the host. Install it and restart the host."
                    .into(),
            },
        )
    }

    pub fn profile_efforts(&self, program: Program) -> Option<Vec<String>> {
        if !self.session_model_profiles {
            return None;
        }
        let support = self
            .launch_profile_support
            .iter()
            .find(|support| support.program == program && support.supported)?;
        Some(
            match (&support.effort_values, support.effort_source.as_deref()) {
                (Some(values), _) => values.clone(),
                (None, Some("modelAdvertised")) => MODEL_ADVERTISED_EFFORTS
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                (None, _) => Vec::new(),
            },
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Field {
    #[default]
    Name,
    Directory,
    Program,
    Worktree,
    Prompt,
    When,
    Model,
    Effort,
}

#[derive(Clone, Default)]
pub struct SessionForm {
    pub advanced: bool,
    pub worktree: bool,
    pub prompt: String,
    pub when: String,
    pub name: String,
    pub cwd: String,
    pub program: Program,
    pub field: Field,
    pub group_id: Option<String>,
    pub kind: Option<SessionKind>,
    pub model: String,
    pub effort: String,
}

impl SessionForm {
    pub fn programs(&self) -> &'static [Program] {
        match self.kind {
            Some(kind) => kind.programs(),
            None => &Program::ALL,
        }
    }

    pub fn profile_efforts(&self, capabilities: Option<&Capabilities>) -> Option<Vec<String>> {
        if self.kind != Some(SessionKind::Agent) {
            return None;
        }
        capabilities?.profile_efforts(self.program)
    }

    pub fn next_field(&self, profiles: bool) -> Option<Field> {
        match self.field {
            Field::Name => Some(Field::Directory),
            Field::Directory if self.programs().len() > 1 => Some(Field::Program),
            Field::Program if profiles && self.kind == Some(SessionKind::Agent) => {
                Some(Field::Model)
            }
            Field::Model => Some(Field::Effort),
            _ => None,
        }
    }

    pub fn previous_field(&self) -> Field {
        match self.field {
            Field::Directory | Field::Name => Field::Name,
            Field::Program => Field::Directory,
            Field::Model => Field::Program,
            Field::Effort => Field::Model,
            Field::Worktree | Field::Prompt => Field::Worktree,
            Field::When => Field::Prompt,
        }
    }

    pub fn last_field(&self, profiles: bool) -> Field {
        if self.advanced {
            return Field::When;
        }
        let mut probe = Self {
            field: Field::Name,
            kind: self.kind,
            ..Default::default()
        };
        while let Some(next) = probe.next_field(profiles) {
            probe.field = next;
        }
        probe.field
    }

    pub fn cycle_program(&mut self, backward: bool) {
        let programs = self.programs();
        let position = programs
            .iter()
            .position(|item| item == &self.program)
            .unwrap_or(0);
        let step = if backward { programs.len() - 1 } else { 1 };
        let next = programs[(position + step) % programs.len()];
        if next != self.program {
            self.effort.clear();
        }
        self.program = next;
    }

    pub fn cycle_effort(&mut self, efforts: &[String], backward: bool) {
        let choices: Vec<&str> = std::iter::once("")
            .chain(efforts.iter().map(String::as_str))
            .collect();
        let position = choices
            .iter()
            .position(|choice| *choice == self.effort)
            .unwrap_or(0);
        let step = if backward { choices.len() - 1 } else { 1 };
        self.effort = choices[(position + step) % choices.len()].to_owned();
    }

    pub fn profile(
        &self,
        efforts: Option<&[String]>,
    ) -> Result<Option<(String, Option<String>)>, &'static str> {
        if efforts.is_none() {
            return Ok(None);
        }
        let model = self.model.trim();
        let effort = (!self.effort.is_empty()).then(|| self.effort.clone());
        if model.is_empty() {
            return match effort {
                Some(_) => Err("Effort needs an explicit model. Type a model or keep default."),
                None => Ok(None),
            };
        }
        if model.len() > 256 || model.starts_with('-') || model.chars().any(char::is_control) {
            return Err("Use a model of 1–256 bytes without a leading dash.");
        }
        Ok(Some((model.to_owned(), effort)))
    }

    pub fn append(&mut self, text: &str) {
        let (value, limit) = match self.field {
            Field::Name => (&mut self.name, 80usize),
            Field::Model => (&mut self.model, 256),
            Field::Prompt => (&mut self.prompt, 2048),
            Field::When => (&mut self.when, 40),
            _ => return,
        };
        let remaining = limit.saturating_sub(value.chars().count());
        value.extend(text.chars().filter(|c| !c.is_control()).take(remaining));
    }

    pub fn backspace(&mut self) {
        match self.field {
            Field::Name => {
                self.name.pop();
            }
            Field::Prompt => {
                self.prompt.pop();
            }
            Field::When => {
                self.when.pop();
            }
            Field::Model => {
                self.model.pop();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_name_accepts_text() {
        let mut form = SessionForm {
            field: Field::Directory,
            ..Default::default()
        };
        form.append("C:\\My Projects\\api\r\n");
        assert!(form.cwd.is_empty());
        form.field = Field::Program;
        form.cycle_program(false);
        form.append("not text");
        assert_eq!(form.program, Program::Claude);
        assert!(form.cwd.is_empty());
        form.field = Field::Name;
        form.append("A\r\nB");
        assert_eq!(form.name, "AB");
    }

    fn capabilities(profiles: bool) -> Capabilities {
        serde_json::from_value(serde_json::json!({
            "workspace": "/work",
            "programs": [],
            "sessionModelProfiles": profiles,
            "launchProfileSupport": [
                {"program":"claude","supported":true,"effortValues":["low","high"],"effortSource":"cli"},
                {"program":"codex","supported":true,"effortValues":null,"effortSource":"modelAdvertised"},
                {"program":"gemini","supported":false},
                {"program":"future-agent","supported":true},
                "malformed"
            ]
        }))
        .unwrap()
    }

    #[test]
    fn launch_provider_availability_gates_no_cli_and_tolerates_malformed_entries() {
        let caps: Capabilities = serde_json::from_value(serde_json::json!({
            "workspace": "/work",
            "programs": [
                {"id":"claude","available":true},
                {"id":"codex","available":true},
                {"id":"gemini","available":true}
            ],
            "providers": {
                "claude": {"state":"ok","version":"2.1.3"},
                "codex": {"state":"noCli","reason":"codex was not found on the host PATH"},
                "gemini": {"state":"futureState","reason":"later"},
                "extra": {"state":"ok"}
            }
        }))
        .unwrap();
        assert!(caps.available(Program::Claude));
        assert!(!caps.available(Program::Codex));
        assert!(caps.available(Program::Gemini));
        assert_eq!(
            caps.provider(Program::Claude).unwrap().label(),
            "ok · 2.1.3"
        );
        assert_eq!(caps.provider(Program::Claude).unwrap().hint(), None);
        assert_eq!(
            caps.provider(Program::Gemini).unwrap().state,
            ProviderState::Unknown
        );
        assert_eq!(
            caps.launch_refusal(Program::Codex).unwrap(),
            "Cannot launch: codex was not found on the host PATH."
        );
        assert_eq!(caps.launch_refusal(Program::Claude), None);
        assert_eq!(caps.launch_refusal(Program::Gemini), None);
        let malformed: Capabilities = serde_json::from_value(serde_json::json!({
            "workspace": "/work",
            "programs": [{"id":"claude","available":true}],
            "providers": {"claude": "broken"}
        }))
        .unwrap();
        assert!(malformed.provider(Program::Claude).is_none());
        assert!(malformed.available(Program::Claude));
        let legacy: Capabilities = serde_json::from_value(serde_json::json!({
            "workspace": "/w",
            "programs": [{"id":"codex","available":false}],
            "providers": 7
        }))
        .unwrap();
        assert!(legacy.provider(Program::Codex).is_none());
        assert!(
            legacy
                .launch_refusal(Program::Codex)
                .unwrap()
                .contains("Install it")
        );
    }

    #[test]
    fn launch_profile_efforts_follow_host_capabilities() {
        let caps = capabilities(true);
        assert_eq!(caps.launch_profile_support.len(), 3);
        assert_eq!(
            caps.profile_efforts(Program::Claude),
            Some(vec!["low".into(), "high".into()])
        );
        assert_eq!(
            caps.profile_efforts(Program::Codex),
            Some(vec!["low".into(), "medium".into(), "high".into()])
        );
        assert_eq!(caps.profile_efforts(Program::Gemini), None);
        assert_eq!(capabilities(false).profile_efforts(Program::Claude), None);
        let legacy: Capabilities =
            serde_json::from_value(serde_json::json!({"workspace":"/w","programs":[]})).unwrap();
        assert!(legacy.launch_profile_support.is_empty());
        let classic = SessionForm {
            program: Program::Claude,
            ..Default::default()
        };
        assert_eq!(classic.profile_efforts(Some(&caps)), None);
        let agent = SessionForm {
            kind: Some(SessionKind::Agent),
            program: Program::Claude,
            ..Default::default()
        };
        assert!(agent.profile_efforts(Some(&caps)).is_some());
        assert_eq!(agent.profile_efforts(None), None);
    }

    #[test]
    fn launch_form_fields_follow_kind_and_profile_support() {
        let walk = |form: &mut SessionForm, profiles: bool| {
            let mut fields = vec![form.field];
            while let Some(next) = form.next_field(profiles) {
                form.field = next;
                fields.push(next);
            }
            fields
        };
        let mut classic = SessionForm::default();
        assert_eq!(
            walk(&mut classic, true),
            [Field::Name, Field::Directory, Field::Program]
        );
        let mut agent = SessionForm {
            kind: Some(SessionKind::Agent),
            ..Default::default()
        };
        assert_eq!(
            walk(&mut agent, true),
            [
                Field::Name,
                Field::Directory,
                Field::Program,
                Field::Model,
                Field::Effort
            ]
        );
        assert_eq!(agent.previous_field(), Field::Model);
        assert_eq!(agent.last_field(true), Field::Effort);
        assert_eq!(agent.last_field(false), Field::Program);
        let mut terminal = SessionForm {
            kind: Some(SessionKind::Terminal),
            ..Default::default()
        };
        assert_eq!(walk(&mut terminal, true), [Field::Name, Field::Directory]);
        assert_eq!(terminal.last_field(true), Field::Directory);
    }

    #[test]
    fn launch_agent_cycles_programs_efforts_and_validates_profile() {
        let mut form = SessionForm {
            kind: Some(SessionKind::Agent),
            program: Program::Claude,
            effort: "high".into(),
            ..Default::default()
        };
        form.cycle_program(true);
        assert_eq!(form.program, Program::Codex);
        assert!(form.effort.is_empty());
        form.cycle_program(false);
        assert_eq!(form.program, Program::Claude);
        let efforts = vec!["low".to_owned(), "high".to_owned()];
        form.cycle_effort(&efforts, false);
        assert_eq!(form.effort, "low");
        form.cycle_effort(&efforts, true);
        form.cycle_effort(&efforts, true);
        assert_eq!(form.effort, "high");
        assert!(form.profile(Some(&efforts)).is_err());
        assert_eq!(form.profile(None), Ok(None));
        form.field = Field::Model;
        form.append(" opus\u{7} ");
        assert_eq!(
            form.profile(Some(&efforts)),
            Ok(Some(("opus".into(), Some("high".into()))))
        );
        form.backspace();
        form.backspace();
        form.backspace();
        form.backspace();
        form.backspace();
        form.append("-x");
        assert!(form.profile(Some(&efforts)).is_err());
        form.model.clear();
        form.effort.clear();
        assert_eq!(form.profile(Some(&efforts)), Ok(None));
    }
}
