//! Per-process capabilities. A caller's declared session ID never grants authority.
use anyhow::Result;
use serde_json::json;
use std::path::PathBuf;

#[derive(Clone, Default)]
pub enum Authority {
    #[default]
    Owner,
    Session {
        id: String,
        scope_id: String,
    },
}
pub struct Context {
    pub scope_id: String,
    pub key: [u8; 32],
    directory: PathBuf,
}
impl Context {
    pub fn new(url: &str, session_id: &str) -> Result<Self> {
        let context = Self {
            scope_id: hex::encode(crate::wire::random::<16>()),
            key: crate::wire::random::<32>(),
            directory: std::env::temp_dir().join(format!(
                "nesvo-caller-{}",
                hex::encode(crate::wire::random::<16>())
            )),
        };
        std::fs::create_dir(&context.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&context.directory, std::fs::Permissions::from_mode(0o700))?;
        }
        crate::private_write(
            &context.path(),
            &serde_json::to_vec(
                &json!({"version":1,"url":url,"key":hex::encode(context.key),"scopeId":context.scope_id,"sessionId":session_id,"authority":"session"}),
            )?,
        )?;
        Ok(context)
    }
    pub fn path(&self) -> PathBuf {
        self.directory.join("context.json")
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
    fn capabilities_are_unique_private_and_cleanup_does_not_delete_unowned_contents() {
        let first = Context::new("ws://127.0.0.1:1", "s").unwrap();
        let second = Context::new("ws://127.0.0.1:1", "s").unwrap();
        assert_ne!(first.key, second.key);
        assert_ne!(first.scope_id, second.scope_id);
        assert!(valid_scope_id(&first.scope_id));
        assert!(!valid_scope_id("caller-claims-to-be-owner"));
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(first.path()).unwrap()).unwrap();
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["authority"], "session");
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
        }
        let path = first.path();
        let directory = first.directory.clone();
        std::fs::write(directory.join("unowned.txt"), b"preserve").unwrap();
        drop(first);
        assert!(!path.exists());
        assert!(directory.join("unowned.txt").exists());
        std::fs::remove_file(directory.join("unowned.txt")).unwrap();
        std::fs::remove_dir(directory).unwrap();
        let path = second.path();
        drop(second);
        assert!(!path.exists());
    }
}
