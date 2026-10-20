//! Per-process capabilities. A caller's declared session ID never grants authority.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
};

const INSTRUCTIONS: &str = include_str!("../../../skills/nesvo-harness/SKILL.md");
const RUN_POLICY: &str =
    include_str!("../../../skills/nesvo-harness/references/run-policy-and-control.md");
const RUN_CONTEXT: &str = include_str!("../../../skills/nesvo-harness/references/run-context.md");
const REFERENCES: [(&str, &str); 2] = [
    ("run-policy-and-control.md", RUN_POLICY),
    ("run-context.md", RUN_CONTEXT),
];
const INSTRUCTION_VERSION: u32 = 11;

pub fn runtime_client() -> Option<PathBuf> {
    resolve_client(
        std::env::var_os("NESVO_CLIENT_BINARY"),
        &std::env::current_exe().ok()?,
    )
}

pub fn supports_claude_harness(version: &str) -> bool {
    let stable = version.split(['-', '+']).next().unwrap_or_default();
    let numbers: Option<Vec<u32>> = stable.split('.').map(|part| part.parse().ok()).collect();
    numbers.is_some_and(|v| v.len() == 3 && v[0] == 2 && v[1] == 1 && v[2] >= 303)
}

// Explicit owner configuration wins. An invalid override never falls through to PATH.
fn resolve_client(explicit: Option<OsString>, host: &Path) -> Option<PathBuf> {
    let candidate = explicit
        .map(PathBuf::from)
        .unwrap_or_else(|| host.with_file_name(if cfg!(windows) { "nesvo.exe" } else { "nesvo" }));
    if !candidate.is_absolute() || !candidate.is_file() {
        return None;
    }
    #[cfg(windows)]
    if !candidate
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&candidate).ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    candidate.canonicalize().ok()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    #[default]
    Worker,
    Coordinator,
}
impl Role {
    pub fn is_worker(&self) -> bool {
        *self == Self::Worker
    }
}
#[derive(Default)]
pub struct Policy {
    pub role: Role,
    children: HashSet<String>,
}
impl Policy {
    pub fn can_spawn(&self) -> bool {
        self.role == Role::Coordinator && self.children.len() < 256
    }
    pub fn new(role: Role) -> Self {
        Self {
            role,
            children: HashSet::new(),
        }
    }
    pub fn can_read(&self, own: &str, target: &str) -> bool {
        own == target || self.can_control(target)
    }
    pub fn can_control(&self, target: &str) -> bool {
        self.role == Role::Coordinator && self.children.contains(target)
    }
    pub fn grant_created_child(&mut self, child: String) {
        if self.can_spawn() {
            self.children.insert(child);
        }
    }
}

#[derive(Clone, Default)]
pub enum Authority {
    #[default]
    Owner,
    Session {
        id: String,
        scope_id: String,
    },
    /// Host-created grant for a fixed coordinator wake, never authenticated from
    /// client input. General API/launch/control paths reject this authority.
    RunWake {
        id: String,
        scope_id: String,
    },
}
pub struct Context {
    pub scope_id: String,
    pub key: [u8; 32],
    directory: PathBuf,
    client: Option<PathBuf>,
}
impl Context {
    pub fn new(url: &str, session_id: &str, role: Role) -> Result<Self> {
        let context = Self {
            scope_id: hex::encode(crate::wire::random::<16>()),
            key: crate::wire::random::<32>(),
            directory: std::env::temp_dir().join(format!(
                "nesvo-caller-{}",
                hex::encode(crate::wire::random::<16>())
            )),
            client: runtime_client(),
        };
        std::fs::create_dir(&context.directory)?;
        std::fs::create_dir(context.references())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&context.directory, std::fs::Permissions::from_mode(0o700))?;
            std::fs::set_permissions(context.references(), std::fs::Permissions::from_mode(0o700))?;
        }
        crate::private_write(&context.skill(), INSTRUCTIONS.as_bytes())?;
        let mut instructions = INSTRUCTIONS.to_owned();
        for (name, content) in REFERENCES {
            crate::private_write(&context.references().join(name), content.as_bytes())?;
            instructions.push_str(&format!(
                "\n\n---\n\nBundled reference: references/{name}\n\n{content}"
            ));
        }
        // Native injection includes referenced control rules up front. Requiring
        // a new provider Read permission to learn safe control would deadlock a
        // blocked coordinator. Generic skill users still get normal references.
        crate::private_write(&context.instructions(), instructions.as_bytes())?;
        crate::private_write(
            &context.path(),
            &serde_json::to_vec(
                &json!({"version":1,"url":url,"key":hex::encode(context.key),"scopeId":context.scope_id,"sessionId":session_id,"authority":"session","role":role,"cli":context.client,"instructions":{"version":INSTRUCTION_VERSION,"path":context.skill()}}),
            )?,
        )?;
        Ok(context)
    }
    pub fn path(&self) -> PathBuf {
        self.directory.join("context.json")
    }
    pub fn skill(&self) -> PathBuf {
        self.directory.join("SKILL.md")
    }
    fn references(&self) -> PathBuf {
        self.directory.join("references")
    }
    fn instructions(&self) -> PathBuf {
        self.directory.join("instructions.md")
    }
    pub fn bind(&self, command: &mut portable_pty::CommandBuilder) {
        command.env("NESVO_AGENT_CONTEXT", self.path());
        command.env("NESVO_AGENT_SKILL", self.skill());
        command.env_remove("NESVO_CLI");
        if let Some(path) = &self.client {
            command.env("NESVO_CLI", path);
        }
    }
    pub fn configure_claude(&self, command: &mut portable_pty::CommandBuilder) -> Result<()> {
        let client = self.client.as_ref().ok_or_else(||crate::api_error::Error::new("harness_client_unavailable","Harness needs a discoverable native nesvo executable beside the host or NESVO_CLIENT_BINARY"))?;
        let config = json!({"mcpServers":{"nesvo":{"type":"stdio","command":crate::process::display_path(client),"args":["mcp"],"env":{"NESVO_AGENT_CONTEXT":self.path()}}}});
        crate::private_write(&self.mcp(), &serde_json::to_vec(&config)?)?;
        let argv = command.get_argv_mut();
        let index = argv
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(argv.len());
        argv.splice(
            index..index,
            [
                "--mcp-config".into(),
                self.mcp().into_os_string(),
                "--append-system-prompt-file".into(),
                self.instructions().into_os_string(),
            ],
        );
        Ok(())
    }
    fn mcp(&self) -> PathBuf {
        self.directory.join("mcp.json")
    }
    pub fn configuration(&self, enabled: bool) -> serde_json::Value {
        json!({"enabled":enabled,"cliAvailable":self.client.is_some(),"instructionVersion":INSTRUCTION_VERSION,"instructions":if enabled {"append-system-prompt-file"} else {"available-only"},"mcp":if enabled {vec!["nesvo"]} else {vec![]},"scope":"launch","loaded":null,"globalConfigChanged":false})
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        let safe = || -> Option<PathBuf> {
            let target = self.directory.canonicalize().ok()?;
            let parent = std::env::temp_dir().canonicalize().ok()?;
            (target.parent() == Some(parent.as_path())
                && target.file_name() == self.directory.file_name())
            .then_some(target)
        };
        if let Some(directory) = safe() {
            let _ = std::fs::remove_file(directory.join("context.json"));
            let _ = std::fs::remove_file(directory.join("SKILL.md"));
            let _ = std::fs::remove_file(directory.join("mcp.json"));
            let _ = std::fs::remove_file(directory.join("instructions.md"));
            // Remove only our named references, never caller-created contents.
            let reference = directory.join("references");
            if reference
                .canonicalize()
                .is_ok_and(|resolved| resolved == reference)
            {
                for (name, _) in REFERENCES {
                    let _ = std::fs::remove_file(reference.join(name));
                }
                let _ = std::fs::remove_dir(reference);
            }
            // Never recursively delete caller-controlled contents.
            let _ = std::fs::remove_dir(directory);
        }
    }
}
pub fn valid_scope_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_host_grants_enable_child_access_and_never_recursive_authority() {
        let mut worker = Policy::default();
        worker.grant_created_child("foreign".into());
        assert!(worker.can_read("self", "self"));
        assert!(!worker.can_read("self", "foreign"));
        assert!(!worker.can_control("self"));
        let mut coordinator = Policy::new(Role::Coordinator);
        assert!(!coordinator.can_read("parent", "metadata-child"));
        coordinator.grant_created_child("owned-child".into());
        assert!(coordinator.can_read("parent", "owned-child"));
        assert!(coordinator.can_control("owned-child"));
        assert!(!coordinator.can_control("parent"));
        assert!(!coordinator.can_read("parent", "unrelated"));
        for index in 0..300 {
            coordinator.grant_created_child(format!("child-{index}"));
        }
        assert_eq!(coordinator.children.len(), 256);
        assert!(!coordinator.can_spawn());
    }
    #[test]
    fn capabilities_are_unique_private_and_cleanup_does_not_delete_unowned_contents() {
        let first = Context::new("ws://127.0.0.1:1", "s", Role::Worker).unwrap();
        let second = Context::new("ws://127.0.0.1:1", "s", Role::Coordinator).unwrap();
        assert_ne!(first.key, second.key);
        assert_ne!(first.scope_id, second.scope_id);
        assert!(valid_scope_id(&first.scope_id));
        assert!(!valid_scope_id("caller-claims-to-be-owner"));
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(first.path()).unwrap()).unwrap();
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["authority"], "session");
        assert_eq!(value["instructions"]["version"], INSTRUCTION_VERSION);
        assert_eq!(
            std::fs::read_to_string(first.skill()).unwrap(),
            INSTRUCTIONS
        );
        assert!(INSTRUCTIONS.lines().count() < 500);
        for (name, content) in REFERENCES {
            assert_eq!(
                std::fs::read_to_string(first.references().join(name)).unwrap(),
                content
            );
        }
        let bundle = std::fs::read_to_string(first.instructions()).unwrap();
        assert!(bundle.starts_with(INSTRUCTIONS));
        assert!(bundle.ends_with(RUN_CONTEXT));
        assert_eq!(
            bundle
                .matches("# Run policy and native control reference")
                .count(),
            1
        );
        assert_eq!(
            bundle
                .matches("# Run context and owner constraints reference")
                .count(),
            1
        );
        let mut command = portable_pty::CommandBuilder::new("unused-test-program");
        command.env("NESVO_CLI", "do-not-inherit-a-foreign-client");
        first.bind(&mut command);
        assert!(
            command
                .iter_extra_env_as_str()
                .any(|(key, value)| key == "NESVO_AGENT_SKILL"
                    && value == first.skill().to_str().unwrap())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(first.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            for path in std::iter::once(first.instructions()).chain(
                REFERENCES
                    .iter()
                    .map(|(name, _)| first.references().join(name)),
            ) {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        let path = first.path();
        let directory = first.directory.clone();
        std::fs::write(directory.join("unowned.txt"), b"preserve").unwrap();
        std::fs::write(
            first.references().join("unowned.txt"),
            b"preserve reference",
        )
        .unwrap();
        drop(first);
        assert!(!path.exists());
        assert!(!directory.join("SKILL.md").exists());
        assert!(!directory.join("instructions.md").exists());
        for (name, _) in REFERENCES {
            assert!(!directory.join("references").join(name).exists());
        }
        assert!(directory.join("references/unowned.txt").exists());
        assert!(directory.join("unowned.txt").exists());
        std::fs::remove_file(directory.join("unowned.txt")).unwrap();
        std::fs::remove_file(directory.join("references/unowned.txt")).unwrap();
        std::fs::remove_dir(directory.join("references")).unwrap();
        std::fs::remove_dir(directory).unwrap();
        let path = second.path();
        drop(second);
        assert!(!path.exists());
    }
    #[test]
    fn launch_local_config_is_literal_private_and_does_not_claim_loaded() {
        assert!(supports_claude_harness("2.1.303"));
        assert!(supports_claude_harness("2.1.304-fixture"));
        for unsupported in ["2.1.302", "unknown", "3.0.0", "2.broken.1.303", "2.1.303.1"] {
            assert!(!supports_claude_harness(unsupported), "{unsupported}");
        }
        let mut context = Context::new("ws://127.0.0.1:1", "s", Role::Coordinator).unwrap();
        context.client = Some(PathBuf::from(if cfg!(windows) {
            r"C:\native client\nesvo.exe"
        } else {
            "/native client/nesvo"
        }));
        let mut command = portable_pty::CommandBuilder::new("fixture");
        command.args(["--resume", "--", "literal --mcp-config malicious"]);
        context.configure_claude(&mut command).unwrap();
        let argv = command.get_argv();
        assert_eq!(argv.last().unwrap(), "literal --mcp-config malicious");
        assert_eq!(argv[2], "--mcp-config");
        assert_eq!(argv[5], context.instructions().into_os_string());
        assert_eq!(argv[6], "--");
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(context.mcp()).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["nesvo"]["args"], json!(["mcp"]));
        assert_eq!(
            config["mcpServers"]["nesvo"]["env"]["NESVO_AGENT_CONTEXT"],
            json!(context.path())
        );
        assert!(!config.to_string().contains(&hex::encode(context.key)));
        assert_eq!(
            context.configuration(true)["loaded"],
            serde_json::Value::Null
        );
        let directory = context.directory.clone();
        drop(context);
        assert!(!directory.exists());
    }
    #[cfg(unix)]
    #[test]
    fn reference_cleanup_never_follows_a_replaced_directory_symlink() {
        use std::os::unix::fs::symlink;
        let context = Context::new("ws://127.0.0.1:1", "s", Role::Coordinator).unwrap();
        let outside = std::env::temp_dir().join(format!(
            "nesvo-unowned-reference-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&outside).unwrap();
        for (name, _) in REFERENCES {
            std::fs::write(outside.join(name), "Preserve caller-controlled target").unwrap();
        }
        for (name, _) in REFERENCES {
            std::fs::remove_file(context.references().join(name)).unwrap();
        }
        std::fs::remove_dir(context.references()).unwrap();
        symlink(&outside, context.references()).unwrap();
        let directory = context.directory.clone();
        drop(context);
        for (name, _) in REFERENCES {
            assert!(outside.join(name).exists());
        }
        assert!(
            directory
                .join("references")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        std::fs::remove_file(directory.join("references")).unwrap();
        std::fs::remove_dir(directory).unwrap();
        for (name, _) in REFERENCES {
            std::fs::remove_file(outside.join(name)).unwrap();
        }
        std::fs::remove_dir(outside).unwrap();
    }
    #[test]
    fn client_discovery_is_absolute_explicit_and_never_uses_a_shell_shim() {
        let root = std::env::temp_dir().join(format!(
            "nesvo-cli-discovery-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&root).unwrap();
        let host = root.join("host");
        let executable = root.join(if cfg!(windows) { "nesvo.exe" } else { "nesvo" });
        std::fs::write(&executable, b"owned fixture only").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            resolve_client(None, &host),
            Some(executable.canonicalize().unwrap())
        );
        assert_eq!(resolve_client(Some("relative-client".into()), &host), None);
        assert_eq!(
            resolve_client(Some(root.join("missing").into()), &host),
            None
        );
        assert_eq!(resolve_client(Some(root.clone().into()), &host), None);
        std::fs::remove_file(executable).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
