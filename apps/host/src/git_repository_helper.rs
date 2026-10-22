use super::*;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tokio::io::AsyncWriteExt;

const REQUEST_BYTES: usize = 16 * 1024;
const HEADER_BYTES: usize = 13;
#[cfg(test)]
const TEST_GATE: &str = "NESVO_REPOSITORY_TEST_HELPER";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Builtin {
    Discovery,
    Symbolic,
    #[cfg(test)]
    Fixture {
        args: Vec<String>,
    },
    #[cfg(test)]
    WrapperFixture,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    directory: PathBuf,
    builtin: Builtin,
}

fn helper_command() -> Result<Command, ()> {
    let mut command = Command::new(std::env::current_exe().map_err(|_| ())?);
    #[cfg(not(test))]
    command.arg(super::HELPER_FLAG);
    #[cfg(test)]
    command
        .args([
            "--ignored",
            "--exact",
            "git_repository::helper::tests::waiting_helper_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(TEST_GATE, "1");
    sanitize(&mut command);
    command.stdin(Stdio::piped());
    #[cfg(not(test))]
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(test)]
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    Ok(command)
}

pub(super) async fn run(
    directory: &Path,
    builtin: Builtin,
    limit: usize,
    deadline: Instant,
    stopped: &mut watch::Receiver<bool>,
    slot: OwnedSemaphorePermit,
) -> Result<(Output, OwnedSemaphorePermit), ()> {
    if *stopped.borrow() || Instant::now() >= deadline {
        return Err(());
    }
    let bytes = serde_json::to_vec(&Request {
        directory: directory.to_owned(),
        builtin,
    })
    .map_err(|_| ())?;
    if bytes.len() > REQUEST_BYTES {
        return Err(());
    }
    let child = helper_command()?.spawn().map_err(|_| ())?;
    let mut owned = OwnedCommand {
        child: Some(child),
        scope: None,
        slot: Some(slot),
        may_terminate: true,
    };
    owned.scope =
        Some(crate::command_scope::Scope::enroll(owned.child.as_ref().ok_or(())?).map_err(|_| ())?);
    #[cfg(not(test))]
    let mut response = owned.child.as_mut().ok_or(())?.stdout.take().ok_or(())?;
    #[cfg(test)]
    let mut response = owned.child.as_mut().ok_or(())?.stderr.take().ok_or(())?;
    let stop_requested = *stopped.borrow();
    let result = tokio::select! {
        biased;
        _ = stopped.changed() => Err(()),
        result = timeout_at(deadline, async {
            if stop_requested || Instant::now() >= deadline { return Err(()); }
            let input = owned.child.as_mut().ok_or(())?.stdin.as_mut().ok_or(())?;
            input.write_all(&u32::try_from(bytes.len()).map_err(|_| ())?.to_be_bytes()).await.map_err(|_| ())?;
            input.write_all(&bytes).await.map_err(|_| ())?;
            input.flush().await.map_err(|_| ())?;
            let mut header = [0; HEADER_BYTES];
            response.read_exact(&mut header).await.map_err(|_| ())?;
            if header[0] != 0 { return Err(()); }
            let code = i32::from_be_bytes(header[1..5].try_into().map_err(|_| ())?);
            let out_len = usize::try_from(u32::from_be_bytes(header[5..9].try_into().map_err(|_| ())?)).map_err(|_| ())?;
            let err_len = usize::try_from(u32::from_be_bytes(header[9..13].try_into().map_err(|_| ())?)).map_err(|_| ())?;
            if out_len > limit || err_len > STDERR_BYTES { return Err(()); }
            let mut stdout = vec![0; out_len]; let mut stderr = vec![0; err_len];
            response.read_exact(&mut stdout).await.map_err(|_| ())?;
            response.read_exact(&mut stderr).await.map_err(|_| ())?;
            use std::os::windows::process::ExitStatusExt;
            Ok::<_, ()>(Output { status: ExitStatus::from_raw(u32::from_ne_bytes(code.to_ne_bytes())), stdout, stderr })
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

fn read_frame(input: &mut impl Read) -> Result<Request, ()> {
    let mut length = [0; 4];
    input.read_exact(&mut length).map_err(|_| ())?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(|_| ())?;
    if length == 0 || length > REQUEST_BYTES {
        return Err(());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(|_| ())?;
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if !request.directory.is_absolute() {
        return Err(());
    }
    Ok(request)
}

fn read_stream(reader: impl Read, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}

fn execute(request: Request) -> Result<Output, ()> {
    let (mut command, limit) = match request.builtin {
        Builtin::Discovery => {
            let mut command = Command::new("git");
            command.args([
                "--no-pager",
                "-c",
                "core.quotepath=false",
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-common-dir",
            ]);
            (command, DISCOVERY_BYTES)
        }
        Builtin::Symbolic => {
            let mut command = Command::new("git");
            command.args([
                "--no-pager",
                "-c",
                "core.quotepath=false",
                "symbolic-ref",
                "--quiet",
                "HEAD",
            ]);
            (command, BRANCH_BYTES)
        }
        #[cfg(test)]
        Builtin::Fixture { args } => {
            if args.len() > 64
                || args
                    .iter()
                    .any(|argument| argument.len() > 8192 || argument.contains('\0'))
            {
                return Err(());
            }
            let mut command = Command::new("git");
            command.args(args);
            command
                .env("GIT_AUTHOR_NAME", "Repository fixture")
                .env("GIT_COMMITTER_NAME", "Repository fixture")
                .env("GIT_AUTHOR_EMAIL", "repository-fixture@example.invalid")
                .env("GIT_COMMITTER_EMAIL", "repository-fixture@example.invalid");
            (command, DISCOVERY_BYTES)
        }
        #[cfg(test)]
        Builtin::WrapperFixture => {
            let mut command = Command::new(std::env::current_exe().map_err(|_| ())?);
            command
                .args([
                    "--ignored",
                    "--exact",
                    "git_repository::helper::tests::wrapper_fixture_entry",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(TEST_GATE, "1");
            (command, DISCOVERY_BYTES)
        }
    };
    command.current_dir(request.directory);
    sanitize(&mut command);
    let mut child = command.as_std_mut().spawn().map_err(|_| ())?;
    let stdout = child.stdout.take().ok_or(())?;
    let stderr = child.stderr.take().ok_or(())?;
    let (finished, readers) = std::sync::mpsc::channel();
    let out_finished = finished.clone();
    std::thread::spawn(move || {
        let _ = out_finished.send((0, read_stream(stdout, limit)));
    });
    std::thread::spawn(move || {
        let _ = finished.send((1, read_stream(stderr, STDERR_BYTES)));
    });
    let mut stdout = None;
    let mut stderr = None;
    for _ in 0..2 {
        let (stream, bytes) = readers.recv().map_err(|_| ())?;
        let bytes = bytes?;
        if stream == 0 {
            stdout = Some(bytes);
        } else {
            stderr = Some(bytes);
        }
    }
    let status = child.wait().map_err(|_| ())?;
    let stdout = stdout.ok_or(())?;
    let stderr = stderr.ok_or(())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn write_response(output: &mut impl Write, result: Result<Output, ()>) -> Result<(), ()> {
    let mut header = [0; HEADER_BYTES];
    let result = match result {
        Ok(result) => result,
        Err(()) => {
            header[0] = 1;
            output.write_all(&header).map_err(|_| ())?;
            return output.flush().map_err(|_| ());
        }
    };
    let code = result.status.code().ok_or(())?;
    header[1..5].copy_from_slice(&code.to_be_bytes());
    header[5..9].copy_from_slice(
        &u32::try_from(result.stdout.len())
            .map_err(|_| ())?
            .to_be_bytes(),
    );
    header[9..13].copy_from_slice(
        &u32::try_from(result.stderr.len())
            .map_err(|_| ())?
            .to_be_bytes(),
    );
    output
        .write_all(&header)
        .and_then(|_| output.write_all(&result.stdout))
        .and_then(|_| output.write_all(&result.stderr))
        .and_then(|_| output.flush())
        .map_err(|_| ())
}

fn stdio_to(mut input: impl Read, mut output: impl Write) -> i32 {
    let result = read_frame(&mut input).and_then(execute);
    let failed = write_response(&mut output, result).is_err();
    let mut ignored = [0; 1];
    while matches!(input.read(&mut ignored), Ok(1)) {}
    i32::from(failed)
}

pub(super) fn stdio() -> i32 {
    stdio_to(std::io::stdin(), std::io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    const CANCELLATION_BOUND: Duration = Duration::from_secs(3);

    fn enabled() -> bool {
        std::env::var_os(TEST_GATE).as_deref() == Some(std::ffi::OsStr::new("1"))
    }
    fn frame(request: &Request) -> Vec<u8> {
        let bytes = serde_json::to_vec(request).unwrap();
        let mut framed = u32::try_from(bytes.len()).unwrap().to_be_bytes().to_vec();
        framed.extend(bytes);
        framed
    }

    #[test]
    fn private_frame_is_bounded_absolute_and_does_not_accept_executable_fields() {
        let directory = std::env::temp_dir().canonicalize().unwrap();
        let request = Request {
            directory: directory.clone(),
            builtin: Builtin::Discovery,
        };
        assert!(matches!(
            read_frame(&mut std::io::Cursor::new(frame(&request)))
                .unwrap()
                .builtin,
            Builtin::Discovery
        ));
        for bytes in [
            vec![0, 0, 0, 0],
            ((REQUEST_BYTES as u32) + 1).to_be_bytes().to_vec(),
        ] {
            assert!(read_frame(&mut std::io::Cursor::new(bytes)).is_err());
        }
        let wrong = serde_json::json!({"directory":directory,"builtin":"discovery","executable":"untrusted.exe"});
        let bytes = serde_json::to_vec(&wrong).unwrap();
        let mut framed = u32::try_from(bytes.len()).unwrap().to_be_bytes().to_vec();
        framed.extend(bytes);
        assert!(read_frame(&mut std::io::Cursor::new(framed)).is_err());
        let relative = Request {
            directory: PathBuf::from("relative"),
            builtin: Builtin::Symbolic,
        };
        assert!(read_frame(&mut std::io::Cursor::new(frame(&relative))).is_err());
    }

    #[test]
    #[ignore = "internal exact waiting-helper entry; harmless without its test-only environment gate"]
    fn waiting_helper_entry() {
        if !enabled() {
            return;
        }
        std::process::exit(stdio_to(std::io::stdin(), std::io::stderr()));
    }

    #[test]
    #[ignore = "internal exact owned wrapper fixture; harmless without test gate"]
    fn wrapper_fixture_entry() {
        if !enabled() {
            return;
        }
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "git_repository::helper::tests::long_child_fixture_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(TEST_GATE, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write(
            "wrapper.processes.json",
            serde_json::to_vec(&[std::process::id(), child.id()]).unwrap(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_secs(60));
        drop(child);
    }

    #[test]
    #[ignore = "internal exact owned long child; harmless without test gate"]
    fn long_child_fixture_entry() {
        if !enabled() {
            return;
        }
        std::thread::sleep(Duration::from_secs(60));
    }

    fn process(pid: u32) -> OwnedHandle {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        // SAFETY: the fixture publishes only this test's descendants; the handle pins that one.
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "Open the exact owned wrapper descendant before cancel"
        );
        // SAFETY: a successful OpenProcess returns an independently owned handle.
        unsafe { OwnedHandle::from_raw_handle(raw) }
    }
    fn exited(process: &OwnedHandle) -> bool {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        // SAFETY: the owned live handle pins the exact observed process.
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_OBJECT_0 }
    }
    fn signals_after_job_drains_by(process: &OwnedHandle, deadline: Instant) -> bool {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let remaining = u32::try_from(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u32::MAX - 1);
        unsafe { WaitForSingleObject(process.as_raw_handle(), remaining) == WAIT_OBJECT_0 }
    }

    #[tokio::test]
    #[ignore = "Windows process conformance; real contained test wrapper plus long child, no providers/models"]
    async fn windows_waiting_helper_cancellation_contains_wrapper_descendants_before_releasing_capacity()
     {
        let directory = std::env::temp_dir().join(format!(
            "nesvo-git-wrapper-{}",
            hex::encode(crate::wire::random::<8>())
        ));
        std::fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let temporary = std::env::temp_dir().canonicalize().unwrap();
        let (stop, mut stopped) = watch::channel(false);
        let slot = gate().clone().acquire_owned().await.unwrap();
        let owned_directory = directory.clone();
        let mut task = tokio::spawn(async move {
            run(
                &owned_directory,
                Builtin::WrapperFixture,
                DISCOVERY_BYTES,
                Instant::now() + Duration::from_secs(3),
                &mut stopped,
                slot,
            )
            .await
            .map(|_| ())
        });
        let result = std::panic::AssertUnwindSafe(async {
            let pids = timeout(Duration::from_secs(3), async {
                loop {
                    if let Ok(bytes) =
                        tokio::fs::read(directory.join("wrapper.processes.json")).await
                        && let Ok(pids) = serde_json::from_slice::<[u32; 2]>(&bytes)
                    {
                        break pids;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("Owned wrapper must start within the unchanged inspection deadline");
            let wrapper = process(pids[0]);
            let child = process(pids[1]);
            assert!(!exited(&wrapper) && !exited(&child));
            assert!(
                !cleanup_confirmed(),
                "Capacity remains pinned while descendants run"
            );
            stop.send_replace(true);
            let cancellation = Instant::now() + CANCELLATION_BOUND;
            let outcome = timeout_at(cancellation, &mut task)
                .await
                .expect("Bounded canceled helper cleanup")
                .expect("Owned helper task");
            assert!(outcome.is_err());
            assert!(
                signals_after_job_drains_by(&wrapper, cancellation)
                    && signals_after_job_drains_by(&child, cancellation),
                "Both exact process handles must signal termination"
            );
            assert!(
                cleanup_confirmed(),
                "Release only after exact root plus job-empty observation"
            );
        })
        .catch_unwind()
        .await;
        stop.send_replace(true);
        if !task.is_finished() {
            let _ = timeout(Duration::from_secs(3), &mut task).await;
        }
        if cleanup_confirmed()
            && directory.parent() == Some(temporary.as_path())
            && directory
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("nesvo-git-wrapper-"))
        {
            let _ = std::fs::remove_dir_all(&directory);
        }
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
