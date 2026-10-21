//! Bounded builtin-only repository labels; no diff, hooks, network or models.
use std::{
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::{Instant, timeout, timeout_at},
};

const DISCOVERY_BYTES: usize = 8194;
const BRANCH_BYTES: usize = 512;
const STDERR_BYTES: usize = 2048;

#[cfg(windows)]
#[path = "git_repository_helper.rs"]
mod helper;
#[cfg(windows)]
pub(crate) const HELPER_FLAG: &str = "--repository-metadata-helper";
#[cfg(windows)]
pub(crate) fn helper_stdio() -> i32 {
    helper::stdio()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ready { name: String, branch: String },
    Detached { name: String },
    NotRepository,
    Unavailable,
}

fn label(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
impl Outcome {
    pub(crate) fn validated(self) -> Self {
        match &self {
            Self::Ready { name, branch } if !label(name, 128) || !label(branch, 256) => {
                Self::Unavailable
            }
            Self::Detached { name } if !label(name, 128) => Self::Unavailable,
            _ => self,
        }
    }
}

fn gate() -> &'static Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(1)))
}
pub(crate) fn cleanup_confirmed() -> bool {
    gate().available_permits() == 1
}

fn sanitize(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy().to_ascii_uppercase();
        if key_text.starts_with("GIT_TRACE")
            || key_text.starts_with("GIT_CONFIG_KEY_")
            || key_text.starts_with("GIT_CONFIG_VALUE_")
        {
            command.env_remove(key);
        }
    }
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_PREFIX",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_EXEC_PATH",
        "GIT_SHALLOW_FILE",
        "GIT_REPLACE_REF_BASE",
        "GIT_GRAFT_FILE",
        "GIT_QUARANTINE_PATH",
        "GIT_PAGER",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_TRACE",
        "GIT_TRACE_SETUP",
        "GIT_TRACE_PERFORMANCE",
        "GIT_TRACE_PACKET",
        "GIT_TRACE_CURL",
        "GIT_TRACE2",
        "GIT_TRACE2_EVENT",
        "GIT_TRACE2_PERF",
    ] {
        command.env_remove(key);
    }
    // Keep normal global/system configuration and its managed safety policy;
    // command-specific injection and repository/trace routing are removed.
    command
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("LANGUAGE", "C")
        .env("GIT_TRACE", "0")
        .env("GIT_TRACE2", "0")
        .env("GIT_TRACE2_EVENT", "0")
        .env("GIT_TRACE2_PERF", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::command_scope::configure(command);
}

struct OwnedCommand {
    child: Option<Child>,
    scope: Option<crate::command_scope::Scope>,
    slot: Option<OwnedSemaphorePermit>,
    may_terminate: bool,
}
impl OwnedCommand {
    fn terminate(&mut self) {
        if !self.may_terminate {
            return;
        }
        self.may_terminate = false;
        if let Some(scope) = &self.scope {
            let _ = scope.terminate();
        } else if let Some(child) = &mut self.child {
            let _ = child.start_kill();
        }
    }
    async fn cleanup(&mut self) -> bool {
        self.terminate();
        matches!(
            timeout(Duration::from_secs(2), async {
                self.child
                    .as_mut()
                    .ok_or(())?
                    .wait()
                    .await
                    .map_err(|_| ())?;
                while let Some(scope) = &self.scope {
                    if scope.empty().map_err(|_| ())? {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok::<_, ()>(())
            })
            .await,
            Ok(Ok(()))
        )
    }
}
impl Drop for OwnedCommand {
    fn drop(&mut self) {
        self.terminate();
        let Some(mut child) = self.child.take() else {
            return;
        };
        let scope = self.scope.take();
        let slot = self.slot.take();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            std::mem::forget((child, scope, slot));
            return;
        };
        // Retain the single global slot until both exact root and scope are
        // observed terminated. After reaping, scope queries never send signals.
        runtime.spawn(async move {
            loop {
                if child.wait().await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            if let Some(scope) = scope {
                while !matches!(scope.empty(), Ok(true)) {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
            drop(slot);
        });
    }
}

struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[cfg(any(not(windows), test))]
async fn bounded_read(
    reader: impl tokio::io::AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ())?;
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}

async fn run(
    directory: &Path,
    args: &[&str],
    limit: usize,
    deadline: Instant,
    stopped: &mut watch::Receiver<bool>,
    slot: OwnedSemaphorePermit,
) -> Result<(Output, OwnedSemaphorePermit), ()> {
    if *stopped.borrow() || Instant::now() >= deadline {
        return Err(());
    }
    #[cfg(windows)]
    {
        let builtin = match args {
            [
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-common-dir",
            ] => helper::Builtin::Discovery,
            ["symbolic-ref", "--quiet", "HEAD"] => helper::Builtin::Symbolic,
            _ => return Err(()),
        };
        helper::run(directory, builtin, limit, deadline, stopped, slot).await
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("git");
        command
            .args(["--no-pager", "-c", "core.quotepath=false"])
            .args(args)
            .current_dir(directory);
        run_command(command, limit, deadline, stopped, slot).await
    }
}

#[cfg(any(not(windows), test))]
async fn run_command(
    command: Command,
    limit: usize,
    deadline: Instant,
    stopped: &mut watch::Receiver<bool>,
    slot: OwnedSemaphorePermit,
) -> Result<(Output, OwnedSemaphorePermit), ()> {
    #[cfg(windows)]
    {
        // Only compiled into unit tests. Fixture setup also goes through the
        // pre-enrolled test helper instead of racing the Git-for-Windows shim.
        let directory = command.as_std().get_current_dir().ok_or(())?.to_owned();
        if command.as_std().get_program() != std::ffi::OsStr::new("git") {
            return Err(());
        }
        let args = command
            .as_std()
            .get_args()
            .map(|argument| argument.to_str().map(str::to_owned).ok_or(()))
            .collect::<Result<Vec<_>, _>>()?;
        helper::run(
            &directory,
            helper::Builtin::Fixture { args },
            limit,
            deadline,
            stopped,
            slot,
        )
        .await
    }
    #[cfg(not(windows))]
    {
        let mut command = command;
        if *stopped.borrow() || Instant::now() >= deadline {
            return Err(());
        }
        sanitize(&mut command);
        let child = command.spawn().map_err(|_| ())?;
        let mut owned = OwnedCommand {
            child: Some(child),
            scope: None,
            slot: Some(slot),
            may_terminate: true,
        };
        owned.scope = Some(
            crate::command_scope::Scope::enroll(owned.child.as_ref().ok_or(())?).map_err(|_| ())?,
        );
        let stdout = owned.child.as_mut().ok_or(())?.stdout.take().ok_or(())?;
        let stderr = owned.child.as_mut().ok_or(())?.stderr.take().ok_or(())?;
        let result = tokio::select! {
            biased;
            _ = stopped.changed() => Err(()),
            result = timeout_at(deadline, async {
                let (stdout, stderr) = tokio::try_join!(bounded_read(stdout, limit), bounded_read(stderr, STDERR_BYTES))?;
                loop {
                    // This synchronous observation either leaves an unreaped root
                    // eligible for exact termination, or retires that right before
                    // any subsequent await. Never signal a recycled numeric group.
                    if let Some(status) = owned.child.as_mut().ok_or(())?.try_wait().map_err(|_| ())? {
                        owned.may_terminate = false;
                        return Ok::<_, ()>(Output { status, stdout, stderr });
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }) => result.map_err(|_| ()).and_then(|result| result),
        };
        if !owned.cleanup().await {
            return Err(());
        }
        owned.child.take();
        owned.scope.take();
        let slot = owned.slot.take().ok_or(())?;
        result.map(|output| (output, slot))
    }
}

fn records(bytes: &[u8], count: usize) -> Option<Vec<&str>> {
    let value = std::str::from_utf8(bytes).ok()?.strip_suffix('\n')?;
    let records = value
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    (records.len() == count && records.iter().all(|line| label(line, 4096))).then_some(records)
}
fn repository_name(bytes: &[u8]) -> Option<String> {
    let records = records(bytes, 2)?;
    let root = Path::new(records[0]);
    let common = Path::new(records[1]);
    if !root.is_absolute() || !common.is_absolute() {
        return None;
    }
    let label_path = if common.file_name()?.to_str()? == ".git" {
        common.parent()?
    } else {
        root
    };
    let name = label_path.file_name()?.to_str()?;
    label(name, 128).then(|| name.to_owned())
}
fn branch(bytes: &[u8]) -> Option<String> {
    let records = records(bytes, 1)?;
    let branch = records[0].strip_prefix("refs/heads/")?;
    label(branch, 256).then(|| branch.to_owned())
}
fn not_repository(output: &Output) -> bool {
    output.status.code() == Some(128)
        && output.stdout.is_empty()
        && matches!(
            output.stderr.as_slice(),
            b"fatal: not a git repository (or any of the parent directories): .git\n"
                | b"fatal: not a git repository (or any of the parent directories): .git\r\n"
        )
}

pub(crate) async fn inspect(directory: &Path, stopped: &mut watch::Receiver<bool>) -> Outcome {
    let deadline = Instant::now() + Duration::from_secs(3);
    let slot = tokio::select! {
        biased;
        _ = stopped.changed() => return Outcome::Unavailable,
        slot = timeout_at(deadline, gate().clone().acquire_owned()) => match slot {
            Ok(Ok(slot)) => slot,
            _ => return Outcome::Unavailable,
        },
    };
    let Ok((discovery, slot)) = run(
        directory,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
        ],
        DISCOVERY_BYTES,
        deadline,
        stopped,
        slot,
    )
    .await
    else {
        return Outcome::Unavailable;
    };
    if not_repository(&discovery) {
        return Outcome::NotRepository;
    }
    if !discovery.status.success() || !discovery.stderr.is_empty() {
        return Outcome::Unavailable;
    }
    let Some(name) = repository_name(&discovery.stdout) else {
        return Outcome::Unavailable;
    };
    let Ok((symbolic, _slot)) = run(
        directory,
        &["symbolic-ref", "--quiet", "HEAD"],
        BRANCH_BYTES,
        deadline,
        stopped,
        slot,
    )
    .await
    else {
        return Outcome::Unavailable;
    };
    if !symbolic.stderr.is_empty() {
        return Outcome::Unavailable;
    }
    if symbolic.status.code() == Some(1) && symbolic.stdout.is_empty() {
        return Outcome::Detached { name };
    }
    if !symbolic.status.success() {
        return Outcome::Unavailable;
    }
    let Some(branch) = branch(&symbolic.stdout) else {
        return Outcome::Unavailable;
    };
    Outcome::Ready { name, branch }.validated()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsStr, path::PathBuf};

    fn status(code: i32) -> ExitStatus {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            ExitStatus::from_raw(code << 8)
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            ExitStatus::from_raw(code as u32)
        }
    }

    #[test]
    fn only_exact_ordinary_non_repository_diagnostic_is_negative_evidence() {
        let mut output = Output {
            status: status(128),
            stdout: Vec::new(),
            stderr: b"fatal: not a git repository (or any of the parent directories): .git\n"
                .to_vec(),
        };
        assert!(not_repository(&output));
        for stderr in [
            "fatal: detected dubious ownership in repository at private-path\n",
            "fatal: not a git repository (or any parent up to mount point /private)\n",
            "fatal: invalid gitfile format: /private/.git\n",
            "fatal: not a git repository (or any of the parent directories): .git\nprivate-extra",
        ] {
            output.stderr = stderr.as_bytes().to_vec();
            assert!(!not_repository(&output));
        }
        output.stderr =
            b"fatal: not a git repository (or any of the parent directories): .git\n".to_vec();
        output.status = status(1);
        assert!(!not_repository(&output));
    }

    #[test]
    fn branch_and_labels_reject_controls_invalid_utf8_extra_records_and_byte_overflow() {
        assert_eq!(
            branch("refs/heads/feature/żółw\n".as_bytes()).as_deref(),
            Some("feature/żółw")
        );
        assert_eq!(branch(b"HEAD\n"), None);
        assert_eq!(branch(b"refs/heads/main\nextra\n"), None);
        assert_eq!(branch(b"refs/heads/private\0branch\n"), None);
        assert_eq!(branch(b"refs/heads/\xff\n"), None);
        assert_eq!(
            branch(format!("refs/heads/{}\n", "ż".repeat(129)).as_bytes()),
            None
        );
        assert_eq!(branch(b"refs/heads/main\r\n").as_deref(), Some("main"));
        assert_eq!(
            Outcome::Detached {
                name: "ż".repeat(65)
            }
            .validated(),
            Outcome::Unavailable
        );
        assert_eq!(
            Outcome::Ready {
                name: "repo".into(),
                branch: "unsafe\u{1b}branch".into()
            }
            .validated(),
            Outcome::Unavailable
        );
    }

    #[test]
    fn command_has_literal_args_null_stdin_and_cleared_repository_trace_injection() {
        let mut command = Command::new("git");
        command.args([
            "--no-pager",
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
        ]);
        sanitize(&mut command);
        let args = command.as_std().get_args().collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                OsStr::new("--no-pager"),
                OsStr::new("rev-parse"),
                OsStr::new("--path-format=absolute"),
                OsStr::new("--show-toplevel"),
                OsStr::new("--git-common-dir")
            ]
        );
        let env = command
            .as_std()
            .get_envs()
            .collect::<std::collections::HashMap<_, _>>();
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_PARAMETERS",
        ] {
            assert_eq!(env.get(OsStr::new(key)), Some(&None));
        }
        for key in [
            "GIT_TRACE",
            "GIT_TRACE2",
            "GIT_TRACE2_EVENT",
            "GIT_TRACE2_PERF",
        ] {
            assert_eq!(env.get(OsStr::new(key)), Some(&Some(OsStr::new("0"))));
        }
        assert_eq!(
            env.get(OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(&Some(OsStr::new("0")))
        );
        assert_eq!(env.get(OsStr::new("LC_ALL")), Some(&Some(OsStr::new("C"))));
    }

    #[tokio::test]
    async fn stream_caps_fail_at_overflow_sentinel_without_waiting_for_eof() {
        use tokio::io::AsyncWriteExt;
        let (reader, mut writer) = tokio::io::duplex(64);
        writer.write_all(b"123456789").await.unwrap();
        // Writer deliberately remains open. The overflow sentinel must finish
        // this read without EOF; no source body is carried by the error.
        assert!(
            timeout(Duration::from_secs(1), bounded_read(reader, 8))
                .await
                .unwrap()
                .is_err()
        );
    }

    fn serial() -> &'static tokio::sync::Mutex<()> {
        static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "nesvo-repository-{}-łódź",
                hex::encode(crate::wire::random::<8>())
            ));
            std::fs::create_dir(&directory).unwrap();
            Self(directory.canonicalize().unwrap())
        }
        async fn git(&self, args: &[&str]) {
            let mut command = Command::new("git");
            command
                .args([
                    "--no-pager",
                    "-c",
                    "init.templateDir=",
                    "-c",
                    "core.hooksPath=",
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "commit.gpgSign=false",
                    "-c",
                    "tag.gpgSign=false",
                    "-c",
                    "user.name=Repository fixture",
                    "-c",
                    "user.email=repository-fixture@example.invalid",
                ])
                .args(args)
                .current_dir(&self.0)
                .env("GIT_AUTHOR_NAME", "Repository fixture")
                .env("GIT_COMMITTER_NAME", "Repository fixture")
                .env("GIT_AUTHOR_EMAIL", "repository-fixture@example.invalid")
                .env("GIT_COMMITTER_EMAIL", "repository-fixture@example.invalid");
            sanitize(&mut command);
            let slot = gate().clone().acquire_owned().await.unwrap();
            let (_sender, mut stopped) = watch::channel(false);
            let (output, _slot) = run_command(
                command,
                DISCOVERY_BYTES,
                Instant::now() + Duration::from_secs(3),
                &mut stopped,
                slot,
            )
            .await
            .map_err(|_| "Owned Git fixture command failed with confirmed/retained cleanup")
            .unwrap();
            assert!(
                output.status.success(),
                "Owned fixture Git command must succeed"
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let Ok(temporary) = std::env::temp_dir().canonicalize() else {
                return;
            };
            if self.0.parent() == Some(temporary.as_path())
                && self
                    .0
                    .file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| {
                        name.starts_with("nesvo-repository-") && name.ends_with("-łódź")
                    })
            {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[tokio::test]
    async fn real_git_unborn_nested_unicode_and_detached_have_honest_branches() {
        let _serial = serial().lock().await;
        let fixture = Fixture::new();
        fixture
            .git(&["init", "--initial-branch=feature/żółw"])
            .await;
        let nested = fixture.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let (_sender, mut stopped) = watch::channel(false);
        let expected_name = fixture.0.file_name().unwrap().to_str().unwrap().to_owned();
        assert_eq!(
            inspect(&nested, &mut stopped).await,
            Outcome::Ready {
                name: expected_name.clone(),
                branch: "feature/żółw".into()
            }
        );
        fixture
            .git(&["commit", "--allow-empty", "-m", "owned fixture"])
            .await;
        fixture.git(&["checkout", "--detach"]).await;
        assert_eq!(
            inspect(&fixture.0, &mut stopped).await,
            Outcome::Detached {
                name: expected_name
            }
        );
        assert!(cleanup_confirmed());
    }

    #[tokio::test]
    async fn real_git_linked_worktree_uses_common_repository_name_and_own_branch() {
        let _serial = serial().lock().await;
        let fixture = Fixture::new();
        fixture.git(&["init", "--initial-branch=main"]).await;
        fixture
            .git(&["commit", "--allow-empty", "-m", "owned fixture"])
            .await;
        let linked = fixture.0.join("linked-worktree");
        let linked_argument = crate::process::display_path(&linked);
        fixture
            .git(&["worktree", "add", "-b", "feature/linked", &linked_argument])
            .await;
        let (_sender, mut stopped) = watch::channel(false);
        let name = fixture.0.file_name().unwrap().to_str().unwrap().to_owned();
        assert_eq!(
            inspect(&linked, &mut stopped).await,
            Outcome::Ready {
                name: name.clone(),
                branch: "feature/linked".into()
            }
        );
        assert_eq!(
            inspect(&fixture.0, &mut stopped).await,
            Outcome::Ready {
                name,
                branch: "main".into()
            }
        );
    }

    #[tokio::test]
    async fn real_non_repository_and_canceled_read_never_manufacture_labels() {
        let _serial = serial().lock().await;
        let fixture = Fixture::new();
        let (_sender, mut stopped) = watch::channel(false);
        assert_eq!(
            inspect(&fixture.0, &mut stopped).await,
            Outcome::NotRepository
        );
        let (sender, mut stopped) = watch::channel(false);
        sender.send_replace(true);
        assert_eq!(
            inspect(&fixture.0, &mut stopped).await,
            Outcome::Unavailable
        );
        assert!(cleanup_confirmed());
    }
}
