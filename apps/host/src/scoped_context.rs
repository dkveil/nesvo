//! Private review context. Accepted transaction order is authoritative; callback
//! start order within one provider generation is deliberately not promised.
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const DESCRIPTOR_LIMIT: u64 = 1024;
const PATH_LIMIT: usize = 4096;

/// Written once in the owned launch directory. Journal loss never changes mode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Descriptor {
    Journal {
        host_session_id: String,
        launch_id: String,
    },
    Legacy,
}

impl Descriptor {
    pub fn journal_backed(&self) -> bool {
        matches!(self, Self::Journal { .. })
    }

    fn matches(&self, host: &str, launch: &str) -> bool {
        matches!(self, Self::Journal { host_session_id, launch_id }
            if host_session_id == host && launch_id == launch)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Ticket {
    host_session_id: String,
    launch_id: String,
    provider_session_id: String,
    generation: u64,
}

/// Both variants select review context; only CwdChanged establishes actual cwd.
pub(crate) enum Change {
    EditedFile(PathBuf),
    CwdChanged(PathBuf),
}

impl Change {
    fn directory(&self) -> &Path {
        match self {
            Self::EditedFile(path) | Self::CwdChanged(path) => path,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            Self::EditedFile(_) => "editedFile",
            Self::CwdChanged(_) => "cwdChanged",
        }
    }
}

struct Stored {
    ticket: Ticket,
    revision: i64,
    directory: PathBuf,
    kind: String,
    cwd: Option<PathBuf>,
}

fn descriptor_path(report: &Path) -> PathBuf {
    report.with_file_name("context-scope.json")
}

fn valid_host(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn valid_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|value| value.len() <= PATH_LIMIT && !value.chars().any(char::is_control))
}
fn validate_descriptor(descriptor: &Descriptor) -> Result<()> {
    if let Descriptor::Journal {
        host_session_id,
        launch_id,
    } = descriptor
    {
        ensure!(
            valid_host(host_session_id)
                && launch_id.len() == 32
                && launch_id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid context scope"
        );
    }
    Ok(())
}

/// Called after journal initialization, before installing any native hook.
pub(crate) fn install(report: &Path, session_id: Option<&str>) -> Result<Descriptor> {
    let descriptor = if let Some(session_id) = session_id {
        let mut connection = crate::agent_events::capture_connection(report)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (host_session_id, launch_id, _, generation) =
            crate::agent_events::quota_scope(&transaction)?;
        ensure!(
            host_session_id == session_id && generation > 0,
            "Context launch identity changed"
        );
        let descriptor = Descriptor::Journal {
            host_session_id,
            launch_id,
        };
        validate_descriptor(&descriptor)?;
        transaction.execute_batch("CREATE TABLE review_context (
            id INTEGER PRIMARY KEY CHECK(id=1),
            host_session TEXT NOT NULL CHECK(length(host_session) BETWEEN 1 AND 128),
            launch_id TEXT NOT NULL CHECK(length(launch_id)=32),
            provider_session TEXT NOT NULL CHECK(length(provider_session) BETWEEN 1 AND 128),
            generation INTEGER NOT NULL CHECK(generation>0),
            revision INTEGER NOT NULL CHECK(revision>0),
            review_directory TEXT NOT NULL CHECK(length(review_directory) BETWEEN 1 AND 4096),
            review_kind TEXT NOT NULL CHECK(review_kind IN ('editedFile','cwdChanged')),
            cwd_directory TEXT CHECK(cwd_directory IS NULL OR length(cwd_directory) BETWEEN 1 AND 4096)
        )")?;
        transaction.commit()?;
        descriptor
    } else {
        Descriptor::Legacy
    };
    let bytes = serde_json::to_vec(&descriptor)?;
    ensure!(
        bytes.len() <= DESCRIPTOR_LIMIT as usize,
        "Oversized context scope"
    );
    // The fresh private directory is already owned. Never replace this anchor.
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(descriptor_path(report))?.write_all(&bytes)?;
    Ok(descriptor)
}

pub(crate) fn load(report: &Path) -> Result<Descriptor> {
    let path = descriptor_path(report);
    let metadata = std::fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Context scope must be a regular file"
    );
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= DESCRIPTOR_LIMIT,
        "Context scope is not a bounded regular file"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                == 0,
            "Context scope cannot be a reparse point"
        );
    }
    let mut bytes = Vec::new();
    file.take(DESCRIPTOR_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= DESCRIPTOR_LIMIT as usize,
        "Oversized context scope"
    );
    let descriptor = serde_json::from_slice(&bytes)?;
    validate_descriptor(&descriptor)?;
    Ok(descriptor)
}

fn current(connection: &Connection, descriptor: &Descriptor) -> Result<Option<Ticket>> {
    let (host_session_id, launch_id, provider_session_id, generation) =
        crate::agent_events::quota_scope(connection)?;
    ensure!(
        descriptor.matches(&host_session_id, &launch_id) && generation > 0,
        "Context launch identity changed"
    );
    let Some(provider_session_id) = provider_session_id else {
        return Ok(None);
    };
    ensure!(
        valid_provider(&provider_session_id),
        "Invalid context provider identity"
    );
    Ok(Some(Ticket {
        host_session_id,
        launch_id,
        provider_session_id,
        generation,
    }))
}

/// Capture before the first stdin read. This never binds a provider identity.
pub(crate) fn begin(report: &Path, descriptor: &Descriptor) -> Result<Option<Ticket>> {
    if !descriptor.journal_backed() {
        return Ok(None);
    }
    let mut connection = crate::agent_events::context_connection(report)?;
    let transaction = connection.transaction()?;
    let ticket = current(&transaction, descriptor)?;
    transaction.commit()?;
    Ok(ticket)
}

fn stored(connection: &Connection) -> Result<Option<Stored>> {
    let row = connection.query_row(
        "SELECT host_session,launch_id,provider_session,generation,revision,review_directory,review_kind,cwd_directory FROM review_context WHERE id=1",
        [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?)),
    ).optional()?;
    let Some((
        host_session_id,
        launch_id,
        provider_session_id,
        generation,
        revision,
        directory,
        kind,
        cwd,
    )) = row
    else {
        return Ok(None);
    };
    let value = Stored {
        ticket: Ticket {
            host_session_id,
            launch_id,
            provider_session_id,
            generation: u64::try_from(generation)?,
        },
        revision,
        directory: directory.into(),
        kind,
        cwd: cwd.map(PathBuf::from),
    };
    ensure!(
        value.ticket.generation > 0
            && value.revision > 0
            && valid_path(&value.directory)
            && matches!(value.kind.as_str(), "editedFile" | "cwdChanged")
            && value.cwd.as_deref().is_none_or(valid_path),
        "Invalid stored context"
    );
    Ok(Some(value))
}

/// The input identity is independently checked; a ticket alone is insufficient.
pub(crate) fn append(
    report: &Path,
    descriptor: &Descriptor,
    ticket: &Ticket,
    provider_session: Option<&str>,
    change: &Change,
) -> Result<bool> {
    if provider_session != Some(ticket.provider_session_id.as_str()) {
        return Ok(false);
    }
    ensure!(valid_path(change.directory()), "Invalid review directory");
    let mut connection = crate::agent_events::capture_connection(report)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if current(&transaction, descriptor)?.as_ref() != Some(ticket) {
        return Ok(false);
    }
    let previous = stored(&transaction)?;
    let revision = previous.as_ref().map_or(Ok(1), |value| {
        value
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Context revision exhausted"))
    })?;
    let cwd = match change {
        Change::CwdChanged(directory) => Some(directory.as_path()),
        Change::EditedFile(_) => previous
            .as_ref()
            .filter(|value| value.ticket == *ticket)
            .and_then(|value| value.cwd.as_deref()),
    };
    transaction.execute("INSERT INTO review_context(id,host_session,launch_id,provider_session,generation,revision,review_directory,review_kind,cwd_directory)
        VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(id) DO UPDATE SET host_session=excluded.host_session,launch_id=excluded.launch_id,
        provider_session=excluded.provider_session,generation=excluded.generation,revision=excluded.revision,
        review_directory=excluded.review_directory,review_kind=excluded.review_kind,cwd_directory=excluded.cwd_directory",
        params![ticket.host_session_id, ticket.launch_id, ticket.provider_session_id,
            i64::try_from(ticket.generation)?, revision, change.directory().to_str(), change.kind(), cwd.and_then(Path::to_str)])?;
    transaction.commit()?;
    Ok(true)
}

/// A single snapshot validates both current scope and the expected host session.
pub(crate) fn read(
    report: &Path,
    descriptor: &Descriptor,
    expected_session: &str,
) -> Result<Option<crate::agent_context::Context>> {
    ensure!(
        matches!(descriptor, Descriptor::Journal { host_session_id, .. }
        if host_session_id == expected_session),
        "Unexpected review session"
    );
    let mut connection = crate::agent_events::context_connection(report)?;
    let transaction = connection.transaction()?;
    let current = current(&transaction, descriptor)?;
    let value = stored(&transaction)?;
    let result = value
        .filter(|value| current.as_ref() == Some(&value.ticket))
        .map(|value| crate::agent_context::Context {
            directory: value.directory,
            source: match value.kind.as_str() {
                "editedFile" => "Auto: edited file",
                _ => "Auto: agent directory",
            }
            .into(),
        });
    transaction.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_context::Tracker;
    use portable_pty::CommandBuilder;

    struct Fixture {
        tracker: Tracker,
        descriptor: Descriptor,
    }
    impl Fixture {
        fn new() -> Self {
            let tracker =
                Tracker::install_for(&mut CommandBuilder::new("fixture"), "owner").unwrap();
            let descriptor = load(&tracker.report()).unwrap();
            Self {
                tracker,
                descriptor,
            }
        }
        fn report(&self) -> PathBuf {
            self.tracker.report()
        }
        fn directory(&self, name: &str) -> PathBuf {
            self.report().parent().unwrap().join(name)
        }
        fn bind(&self, provider: &str) {
            assert!(
                crate::agent_events::append(
                    &self.report(),
                    Some(provider),
                    "SessionStart",
                    crate::status::StatusState::Idle,
                    true,
                    None
                )
                .unwrap()
                .is_some()
            );
        }
        fn ticket(&self) -> Ticket {
            begin(&self.report(), &self.descriptor).unwrap().unwrap()
        }
        fn apply(&self, ticket: &Ticket, change: Change) -> bool {
            append(
                &self.report(),
                &self.descriptor,
                ticket,
                Some(&ticket.provider_session_id),
                &change,
            )
            .unwrap()
        }
        fn saved(&self) -> Stored {
            stored(&crate::agent_events::context_connection(&self.report()).unwrap())
                .unwrap()
                .unwrap()
        }
        fn read(&self) -> Option<crate::agent_context::Context> {
            read(&self.report(), &self.descriptor, "owner").unwrap()
        }
    }

    #[test]
    fn previous_generation_cannot_displace_current_context_or_its_revision() {
        let fixture = Fixture::new();
        fixture.bind("a");
        let old = fixture.ticket();
        assert!(fixture.apply(&old, Change::CwdChanged(fixture.directory("a"))));
        fixture.bind("b");
        assert!(
            fixture.read().is_none(),
            "rebind alone invalidates old review context"
        );
        let current = fixture.ticket();
        assert!(fixture.apply(&current, Change::EditedFile(fixture.directory("b"))));
        let revision = fixture.saved().revision;
        assert!(!fixture.apply(&old, Change::CwdChanged(fixture.directory("late-a"))));
        assert_eq!(fixture.saved().revision, revision);
        assert_eq!(fixture.read().unwrap().directory, fixture.directory("b"));
        assert!(
            fixture.saved().cwd.is_none(),
            "edited-file review cannot inherit an old generation cwd"
        );
    }

    #[test]
    fn repeated_provider_id_does_not_revive_a_pre_rebind_ticket() {
        let fixture = Fixture::new();
        fixture.bind("a");
        let old = fixture.ticket();
        fixture.bind("b");
        fixture.bind("a");
        let current = fixture.ticket();
        assert_eq!(old.provider_session_id, current.provider_session_id);
        assert_ne!(old.generation, current.generation);
        assert!(fixture.apply(&current, Change::CwdChanged(fixture.directory("new-a"))));
        assert!(!fixture.apply(&old, Change::EditedFile(fixture.directory("old-a"))));
        assert_eq!(
            fixture.read().unwrap().directory,
            fixture.directory("new-a")
        );
    }

    #[test]
    fn external_edit_changes_review_only_and_cwd_changes_both_fields() {
        let fixture = Fixture::new();
        fixture.bind("a");
        let ticket = fixture.ticket();
        let external = std::env::temp_dir().join("external-review-fixture");
        assert!(fixture.apply(&ticket, Change::EditedFile(external.clone())));
        assert_eq!(fixture.read().unwrap().directory, external);
        assert_eq!(fixture.read().unwrap().source, "Auto: edited file");
        assert!(fixture.saved().cwd.is_none());
        let cwd = fixture.directory("actual-cwd");
        assert!(fixture.apply(&ticket, Change::CwdChanged(cwd.clone())));
        assert_eq!(fixture.saved().cwd, Some(cwd.clone()));
        assert_eq!(fixture.read().unwrap().source, "Auto: agent directory");
        assert!(fixture.apply(&ticket, Change::EditedFile(external.clone())));
        assert_eq!(fixture.read().unwrap().directory, external);
        assert_eq!(fixture.saved().cwd, Some(cwd));
    }

    #[test]
    fn unbound_missing_foreign_and_invalid_input_cannot_create_context_authority() {
        let fixture = Fixture::new();
        assert!(
            begin(&fixture.report(), &fixture.descriptor)
                .unwrap()
                .is_none()
        );
        fixture.bind("a");
        let ticket = fixture.ticket();
        let change = Change::CwdChanged(fixture.directory("current"));
        for provider in [None, Some("b"), Some("")] {
            assert!(
                !append(
                    &fixture.report(),
                    &fixture.descriptor,
                    &ticket,
                    provider,
                    &change
                )
                .unwrap()
            );
        }
        for path in [
            PathBuf::from("relative"),
            fixture.directory("line\nbreak"),
            fixture.directory(&"x".repeat(PATH_LIMIT + 1)),
        ] {
            assert!(
                append(
                    &fixture.report(),
                    &fixture.descriptor,
                    &ticket,
                    Some("a"),
                    &Change::CwdChanged(path)
                )
                .is_err()
            );
        }
        assert!(fixture.read().is_none());
        assert!(read(&fixture.report(), &fixture.descriptor, "foreign-owner").is_err());
        let mut foreign = fixture.descriptor.clone();
        if let Descriptor::Journal { launch_id, .. } = &mut foreign {
            *launch_id = "0".repeat(32);
        }
        assert!(begin(&fixture.report(), &foreign).is_err());
    }

    #[test]
    fn accepted_transactions_order_context_without_a_callback_start_order_promise() {
        let fixture = Fixture::new();
        fixture.bind("a");
        let first = fixture.ticket();
        let second = fixture.ticket();
        assert_eq!(
            first, second,
            "context tickets do not reserve quota/callback sequences"
        );
        assert!(fixture.apply(
            &second,
            Change::CwdChanged(fixture.directory("first-commit"))
        ));
        assert!(fixture.apply(
            &first,
            Change::EditedFile(fixture.directory("second-commit"))
        ));
        assert_eq!(fixture.saved().revision, 2);
        assert_eq!(
            fixture.read().unwrap().directory,
            fixture.directory("second-commit")
        );
    }

    #[test]
    fn context_rows_stay_constant_across_rebinds_and_revisions_are_checked() {
        let fixture = Fixture::new();
        for index in 0..24 {
            fixture.bind(if index % 2 == 0 { "a" } else { "b" });
            assert!(fixture.apply(
                &fixture.ticket(),
                Change::CwdChanged(fixture.directory("bounded"))
            ));
        }
        let connection = crate::agent_events::capture_connection(&fixture.report()).unwrap();
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM review_context", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(fixture.saved().revision, 24);
        connection
            .execute("UPDATE review_context SET revision=?1", [i64::MAX])
            .unwrap();
        assert!(
            append(
                &fixture.report(),
                &fixture.descriptor,
                &fixture.ticket(),
                Some("b"),
                &Change::CwdChanged(fixture.directory("overflow"))
            )
            .is_err()
        );
        assert_eq!(fixture.saved().revision, i64::MAX);
        connection
            .execute("UPDATE scope SET generation=-1", [])
            .unwrap();
        assert!(begin(&fixture.report(), &fixture.descriptor).is_err());
    }

    #[test]
    fn descriptor_is_bounded_immutable_and_unknown_is_not_legacy() {
        let fixture = Fixture::new();
        assert!(
            install(&fixture.report(), None).is_err(),
            "cannot replace a Journal descriptor with Legacy"
        );
        assert_eq!(load(&fixture.report()).unwrap(), fixture.descriptor);
        std::fs::write(
            descriptor_path(&fixture.report()),
            "x".repeat(DESCRIPTOR_LIMIT as usize + 1),
        )
        .unwrap();
        assert!(load(&fixture.report()).is_err());
        std::fs::remove_file(descriptor_path(&fixture.report())).unwrap();
        assert!(load(&fixture.report()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_special_files_and_symlinks_are_refused_without_waiting_for_a_writer() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let fixture = Fixture::new();
        let path = descriptor_path(&fixture.report());
        let saved = path.with_extension("saved");
        std::fs::rename(&path, &saved).unwrap();
        symlink(&saved, &path).unwrap();
        assert!(load(&fixture.report()).is_err());
        std::fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(load(&fixture.report()).is_err());
        std::fs::remove_file(&path).unwrap();
    }
}
