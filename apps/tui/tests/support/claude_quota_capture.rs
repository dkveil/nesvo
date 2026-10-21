use super::*;
use tokio::io::AsyncReadExt;

type Owner = RunningService<RoleClient, ()>;

fn launch_settings(fixture: &Fixture, id: &str) -> Result<Value> {
    let argv: Vec<String> = serde_json::from_slice(&std::fs::read(
        fixture
            .directory
            .join("callers")
            .join(format!("{id}.launch-argv.json")),
    )?)?;
    let index = argv
        .iter()
        .position(|arg| arg == "--settings")
        .context("Actual launch settings")?;
    ensure!(
        argv.iter().filter(|arg| *arg == "--settings").count() == 1,
        "One launch-local settings argument"
    );
    Ok(serde_json::from_str(&argv[index + 1])?)
}
async fn explain(owner: &Owner, id: &str) -> Result<Value> {
    let view = data(call(owner, "nesvo_explain_session", json!({"sessionId":id})).await?)?;
    Ok(view["data"]["report"]["sessions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["sessionId"] == id))
        .context("Captured session diagnostics")?
        .clone())
}

async fn completed_capture(owner: &Owner, id: &str, outcome: &str) -> Result<Value> {
    timeout(Duration::from_secs(4), async {
        loop {
            let view = explain(owner, id).await?;
            if view["claudeQuotaCapture"]["delivery"]["latestCompleted"]["outcome"] == outcome
                && view["claudeQuotaCapture"]["reader"]["outcome"] == "readable"
            {
                return Ok::<_, anyhow::Error>(view);
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Typed native capture completion")?
}

fn private_capture(view: &Value) {
    let encoded = view["claudeQuotaCapture"].to_string();
    for sentinel in ["foreign root", "private input", "configured-main-agent"] {
        assert!(
            !encoded.contains(sentinel),
            "Capture diagnostics must not retain input identities or contents"
        );
    }
}

async fn human_capture(fixture: &Fixture, id: &str) -> Result<String> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .arg("--pairing")
        .arg(fixture.pairing())
        .args(["session", "explain", id])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(15), command.output()).await??;
    ensure!(
        output.status.success(),
        "Human capture explain must succeed"
    );
    let output = String::from_utf8(output.stdout)?;
    for sentinel in ["foreign root", "private input", "configured-main-agent"] {
        assert!(
            !output.contains(sentinel),
            "Human diagnostics must not expose callback input"
        );
    }
    Ok(output)
}

struct MissingJournal {
    original: PathBuf,
    saved: PathBuf,
    restored: bool,
}

impl MissingJournal {
    async fn take(settings: &Value) -> Result<Self> {
        let report = PathBuf::from(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["args"][1]
                .as_str()
                .context("Owned lifecycle report argument")?,
        );
        let directory = report
            .parent()
            .context("Owned report directory")?
            .canonicalize()?;
        ensure!(
            directory.parent() == Some(std::env::temp_dir().canonicalize()?.as_path())
                && directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.strip_prefix("nesvo-context-").is_some_and(|suffix| {
                            suffix.len() == 32
                                && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                        })
                    }),
            "Only the fixture's randomly owned launch journal can be moved"
        );
        let original = directory.join("events.sqlite3");
        let saved = directory.join("events.capture-sdk-backup");
        ensure!(!saved.exists(), "Owned journal backup must be new");
        timeout(Duration::from_secs(2), async {
            loop {
                match std::fs::rename(&original, &saved) {
                    Ok(()) => return Ok::<_, anyhow::Error>(()),
                    Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        })
        .await
        .context("Temporarily unavailable owned journal")??;
        Ok(Self {
            original,
            saved,
            restored: false,
        })
    }

    fn restore(&mut self) -> Result<()> {
        ensure!(
            !self.original.exists(),
            "A failed reader must not recreate the owned journal"
        );
        std::fs::rename(&self.saved, &self.original)?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for MissingJournal {
    fn drop(&mut self) {
        if !self.restored
            && !self.original.exists()
            && std::fs::rename(&self.saved, &self.original).is_err()
        {
            eprintln!("Owned capture fixture journal restore was not confirmed");
        }
    }
}

async fn generated(command: &str, input: &[u8], cwd: &Path) -> Result<std::process::Output> {
    #[cfg(windows)]
    let (mut shell, release) = {
        let system = PathBuf::from(
            std::env::var_os("SystemRoot").context("Owned Windows system directory")?,
        )
        .join("System32");
        let release = cwd.join(format!(
            ".generated-command-{}.release",
            hex::encode(nesvo_wire::random::<16>())
        ));
        let mut shell = Command::new(process_fixture::executable());
        shell
            .arg("gate")
            .arg(&release)
            .arg(system.join("cmd.exe"))
            .arg(format!("/d /s /c {command}"));
        (shell, release)
    };
    #[cfg(not(windows))]
    let mut shell = {
        let mut shell = Command::new("/bin/sh");
        shell.args(["-c", command]);
        shell
    };
    shell
        .current_dir(cwd)
        .env("NESVO_CAPTURE_TEST", "owned raw handles")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    shell.creation_flags(0x08000000);
    let mut child = shell.spawn()?;
    #[cfg(windows)]
    let job = match WindowsJob::enroll(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.start_kill();
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
            return Err(error);
        }
    };
    #[cfg(windows)]
    std::fs::write(&release, b"owned job enrolled")?;
    let mut stdin = child.stdin.take().context("Production wrapper input")?;
    let mut stdout = child.stdout.take().context("Production wrapper stdout")?;
    let mut stderr = child.stderr.take().context("Production wrapper stderr")?;
    let mut output = Vec::new();
    let mut diagnostic = Vec::new();
    let result = timeout(Duration::from_secs(12), async {
        stdin.write_all(input).await?;
        stdin.flush().await?;
        drop(stdin);
        let (status, _, _) = tokio::try_join!(
            child.wait(),
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut diagnostic)
        )?;
        Ok::<_, std::io::Error>(status)
    })
    .await;
    #[cfg(windows)]
    terminate_job_before_canceled_pipe_reads_outlive_runtime(&job, &mut child, &release).await?;
    #[cfg(not(windows))]
    if result.is_err() {
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
    }
    let status = result.with_context(|| {
        format!(
            "Actual generated command timeout: {}",
            json!({
                "stderrBytes": diagnostic.len(),
                "stderrClass": stderr_class(&diagnostic),
                "stderrPrefixTruncated": diagnostic.len() > 4096
            })
        )
    })??;
    Ok(std::process::Output {
        status,
        stdout: output,
        stderr: diagnostic,
    })
}

#[cfg(windows)]
async fn terminate_job_before_canceled_pipe_reads_outlive_runtime(
    job: &WindowsJob,
    child: &mut Child,
    release: &Path,
) -> Result<()> {
    let terminated = job.terminate();
    let reaped = timeout(Duration::from_secs(2), child.wait()).await;
    let _ = std::fs::remove_file(release);
    terminated?;
    ensure!(
        matches!(reaped, Ok(Ok(_))),
        "Owned generated-command root cleanup"
    );
    Ok(())
}

fn stderr_class(bytes: &[u8]) -> &'static str {
    if bytes.is_empty() {
        return "empty";
    }
    let prefix = &bytes[..bytes.len().min(4096)];
    let contains = |needle: &[u8]| prefix.windows(needle.len()).any(|part| part == needle);
    match (
        contains(
            b"nesvo declared status-line forwarding is unavailable; inspect the launch profile",
        ),
        contains(b"nesvo quota capture diagnostics are unavailable"),
    ) {
        (true, true) => "bothKnownWarnings",
        (true, false) => "forwardingUnavailable",
        (false, true) => "captureDiagnosticsUnavailable",
        (false, false) => "other",
    }
}
#[cfg(windows)]
struct WindowsJob(std::os::windows::io::OwnedHandle);
#[cfg(windows)]
impl WindowsJob {
    fn enroll(child: &Child) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        #[repr(C)]
        #[derive(Default)]
        struct Basic {
            process_time: i64,
            job_time: i64,
            flags: u32,
            min_ws: usize,
            max_ws: usize,
            active: u32,
            affinity: usize,
            priority: u32,
            scheduling: u32,
        }
        #[repr(C)]
        #[derive(Default)]
        struct Extended {
            basic: Basic,
            io: [u64; 6],
            process_memory: usize,
            job_memory: usize,
            peak_process_memory: usize,
            peak_job_memory: usize,
        }
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        ensure!(
            !raw.is_null(),
            "Create owned generated-command job: {}",
            std::io::Error::last_os_error()
        );
        let job = Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw) });
        let mut info = Extended::default();
        info.basic.flags = 0x2000;
        ensure!(
            unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    9,
                    std::ptr::from_ref(&info).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
            } != 0,
            "Set owned job lifetime: {}",
            std::io::Error::last_os_error()
        );
        let process = child
            .raw_handle()
            .context("Owned generated-command process handle")?;
        ensure!(
            unsafe { AssignProcessToJobObject(job.0.as_raw_handle(), process) } != 0,
            "Enroll owned generated-command job: {}",
            std::io::Error::last_os_error()
        );
        Ok(job)
    }
    fn terminate(&self) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        ensure!(
            unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } != 0,
            "Terminate owned generated-command job: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
#[allow(non_snake_case)]
unsafe extern "system" {
    fn CreateJobObjectW(
        attributes: *const std::ffi::c_void,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn SetInformationJobObject(
        job: *mut std::ffi::c_void,
        class: i32,
        information: *const std::ffi::c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
    fn TerminateJobObject(job: *mut std::ffi::c_void, code: u32) -> i32;
}
fn display_profile(fixture: &Fixture, mode: &str) -> Result<PathBuf> {
    let script = fixture.directory.join("owned display łódź.cjs");
    std::fs::write(
        &script,
        r#"const fs=require('node:fs'); const {spawn}=require('node:child_process');
const mode=process.argv[2], record=process.argv[3];
const input=fs.readFileSync(0);
fs.writeFileSync(record,JSON.stringify({cwd:process.cwd(),env:process.env.NESVO_CAPTURE_TEST,input:input.toString('hex')}));
if(mode==='hang') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(record+'.pid',String(child.pid)); setInterval(()=>{},1000);
} else { process.stdout.write(Buffer.from('1b5b33356d5a61c5bcc3b3c582c48720e697a5e69cace8aa9e1b5b306d0d0a','hex')); process.stdout.write(input); process.exitCode=7; }
"#,
    )?;
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let profile = fixture.directory.join(format!("display-{mode}.json"));
    std::fs::write(
        &profile,
        serde_json::to_vec(
            &json!({"display":{"program":node,"args":[script,mode,fixture.directory.join(format!("{mode}.display.json"))]},"padding":2,"hideVimModeIndicator":true}),
        )?,
    )?;
    Ok(profile)
}
async fn ready(fixture: &Fixture) -> Result<()> {
    timeout(Duration::from_secs(6), async {
        loop {
            let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
            if doctor["providerVersions"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["program"] == "claude" && row["status"] == "ready")
            }) {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Controlled Claude version")?
}
async fn ended_process(fixture: &Fixture, pid: &str) -> Result<()> {
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    timeout(Duration::from_secs(4),async { loop {
        let mut command=Command::new(&node);
        command.args(["-e",r#"const pid=Number(process.argv[1]);try {process.kill(pid,0);if(process.platform==='linux'&&/\) Z /.test(require('node:fs').readFileSync('/proc/'+pid+'/stat','utf8')))process.exit(0);process.exit(1)}catch(e){process.exit(e.code==='ESRCH'?0:2)}"#,pid]);
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)] command.creation_flags(0x08000000);
        let status=timeout(Duration::from_secs(1),command.status()).await??;
        if status.success() {return Ok::<_,anyhow::Error>(());}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }}).await.context("Owned declared display descendant cleanup")?
}

#[tokio::test]
#[ignore = "native host and Node; actual declared statusLine helper and scoped callback, no models"]
async fn explicit_claude_capture_preserves_display_and_bounds_owned_helper_cleanup() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome=std::panic::AssertUnwindSafe(async {
        ready(&fixture).await?;
        let owner=client(&fixture.pairing()).await?;
        let global=fixture.directory.join("claude-config/settings.json");
        std::fs::create_dir_all(global.parent().context("Owned Claude settings directory")?)?;
        let global_bytes=b"{\"statusLine\":{\"type\":\"command\",\"command\":\"OWNED_GLOBAL_SENTINEL_NOT_EXECUTED\"}}";
        std::fs::write(&global,global_bytes)?;
        let profile=display_profile(&fixture,"echo")?;
        let spec=json!({"name":"Explicit capture","program":"claude","role":"coordinator","harness":true,"claudeQuotaCapture":{"displayProfile":profile}});
        let created=data(call(&owner,"nesvo_create_session",json!({"key":"capture-once","spec":spec})).await?)?;
        let id=created["data"]["receipt"]["sessionId"].as_str().context("Capture session")?;
        session_ready(&owner,id).await?;
        let settings=launch_settings(&fixture,id)?;
        assert_eq!(settings["statusLine"]["padding"],2);
        assert!(settings["statusLine"].get("refreshInterval").is_none());
        let command=settings["statusLine"]["command"].as_str().context("Actual generated statusLine command")?;
        let callback=json!({"session_id":format!("fixture-{id}"),"agent":{"name":"configured-main-agent"},"rate_limits":{"five_hour":{"used_percentage":23,"resets_at":chrono::Utc::now().timestamp()+3600},"seven_day":{"used_percentage":31,"resets_at":chrono::Utc::now().timestamp()+86400}}});
        let input=serde_json::to_vec(&callback)?;
        let output=generated(command,&input,&fixture.directory).await?;
        assert_eq!(output.status.code(),Some(7),"{}",String::from_utf8_lossy(&output.stderr));
        let mut expected=hex::decode("1b5b33356d5a61c5bcc3b3c582c48720e697a5e69cace8aa9e1b5b306d0d0a")?;
        expected.extend_from_slice(&input);
        assert_eq!(output.stdout,expected,"Production shell/helper must preserve exact Unicode/ANSI/input bytes");
        let recorded:Value=serde_json::from_slice(&std::fs::read(fixture.directory.join("echo.display.json"))?)?;
        assert_eq!(recorded["env"],"owned raw handles");
        assert_eq!(PathBuf::from(recorded["cwd"].as_str().context("Declared display cwd")?).canonicalize()?,fixture.directory.canonicalize()?);
        assert_eq!(recorded["input"],hex::encode(&input));
        timeout(Duration::from_secs(4),async {loop {
            let view=explain(&owner,id).await?;
            if view["nativeQuotaCallback"]["snapshot"]["reason"] == "observed" {
                assert_eq!(view["nativeQuotaCallback"]["snapshot"]["five_hour"]["used_percentage"],23.0);
                assert!(view["nativeQuotaCallback"]["ordinaryUsageAllowed"].is_null());
                assert_eq!(view["claudeQuotaCapture"]["configured"],true);
                assert!(view["claudeQuotaCapture"]["observed"].is_null());
                return Ok::<_,anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }}).await.context("Actual callback projection")??;
        let recorded = completed_capture(&owner, id, "recorded").await?;
        let first_attempt = recorded["claudeQuotaCapture"]["delivery"]["latestCompleted"]["attemptSequence"]
            .as_u64().context("Capture attempt sequence")?;
        assert!(first_attempt > 0);
        assert_eq!(recorded["claudeQuotaCapture"]["delivery"]["latestStarted"]["attemptSequence"], first_attempt);
        assert_eq!(recorded["claudeQuotaCapture"]["delivery"]["latestCompleted"]["state"], "completed");
        assert_eq!(recorded["claudeQuotaCapture"]["delivery"]["latestCompleted"]["boundAtEntry"], true);
        assert_eq!(recorded["claudeQuotaCapture"]["delivery"]["latestCompleted"]["entryGeneration"], recorded["conversationIdentity"]["generation"]);
        assert_eq!(recorded["claudeQuotaCapture"]["delivery"]["latestCompleted"]["parseReason"], "observed");
        assert!(recorded["claudeQuotaCapture"]["delivery"]["latestRejected"].is_null());
        let accepted_callback = recorded["nativeQuotaCallback"].clone();
        assert_eq!(accepted_callback["sequence"], 1);
        private_capture(&recorded);
        let foreign=b"{\"session_id\":\"foreign root\",\"literal\":\"private input\"}\r\n";
        let rejected=generated(command,foreign,&fixture.directory).await?;
        let mut expected=hex::decode("1b5b33356d5a61c5bcc3b3c582c48720e697a5e69cace8aa9e1b5b306d0d0a")?;expected.extend_from_slice(foreign);
        assert_eq!(rejected.status.code(),Some(7));assert_eq!(rejected.stdout,expected);
        let rejected_view = completed_capture(&owner, id, "payloadScopeRejected").await?;
        assert_eq!(rejected_view["nativeQuotaCallback"], accepted_callback,
            "A diagnostic rejection cannot replace accepted quota or renew its receipt clocks");
        let rejected_attempt = rejected_view["claudeQuotaCapture"]["delivery"]["latestRejected"]["attemptSequence"]
            .as_u64().context("Rejected capture attempt")?;
        assert!(rejected_attempt > first_attempt);
        assert_eq!(rejected_view["claudeQuotaCapture"]["delivery"]["latestCompleted"]["attemptSequence"], rejected_attempt);
        private_capture(&rejected_view);
        let human = human_capture(&fixture, id).await?;
        assert!(human.contains("Claude capture: reader readable"));
        assert!(human.contains("payload scope rejected"));
        std::fs::write(&profile,b"changed invalid source manifest")?;
        let replay=data(call(&owner,"nesvo_create_session",json!({"key":"capture-once","spec":spec})).await?)?;
        assert_eq!(replay["data"]["receipt"]["id"],created["data"]["receipt"]["id"]);
        assert_eq!(generated(command,foreign,&fixture.directory).await?.stdout,expected,"Bound private manifest is not reread on replay");
        let mut missing_journal = MissingJournal::take(&settings).await?;
        let unavailable_output = generated(command, &input, &fixture.directory).await?;
        assert_eq!(unavailable_output.status.code(), Some(7));
        let mut expected_input = hex::decode("1b5b33356d5a61c5bcc3b3c582c48720e697a5e69cace8aa9e1b5b306d0d0a")?;
        expected_input.extend_from_slice(&input);
        assert_eq!(unavailable_output.stdout, expected_input, "Unavailable capture storage cannot change display bytes or exit");
        timeout(Duration::from_secs(4), async {
            loop {
                let view = explain(&owner, id).await?;
                if view["claudeQuotaCapture"]["reader"]["outcome"] == "unreadable"
                    && view["claudeQuotaCapture"]["delivery"]["lastStorageFailure"]["outcome"] == "storageUnavailable"
                {
                    assert!(view["nativeQuotaCallback"].is_null(), "Read failure must clear accepted quota visibility");
                    assert_eq!(view["claudeQuotaCapture"]["delivery"]["lastStorageFailure"]["stage"], "begin");
                    assert_eq!(view["claudeQuotaCapture"]["reader"]["storageFailureOutcome"], "readable");
                    private_capture(&view);
                    return Ok::<_, anyhow::Error>(());
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }).await.context("Anchored storage failure is visible while the journal is unavailable")??;
        let human = human_capture(&fixture, id).await?;
        assert!(human.contains("Claude capture: reader unreadable"));
        assert!(human.contains("historical"));
        missing_journal.restore()?;
        let recovered = completed_capture(&owner, id, "payloadScopeRejected").await?;
        assert_eq!(recovered["nativeQuotaCallback"], accepted_callback,
            "Storage recovery reads the original receipt, not new backend evidence");
        assert_eq!(recovered["claudeQuotaCapture"]["delivery"]["lastStorageFailure"]["outcome"], "storageUnavailable",
            "Historical storage failure remains distinct from a healthy current reader");
        let started = tokio::time::Instant::now();
        let wrapped = generated(command, &input, &fixture.directory).await?;
        assert!(wrapped.status.code() == Some(7) && wrapped.stdout == expected_input,
            "Post-restore forwarding failed: {}", json!({
                "phase": "postJournalRestore",
                "elapsedMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                "exitCode": wrapped.status.code(),
                "stdoutBytes": wrapped.stdout.len(),
                "expectedStdoutBytes": expected_input.len(),
                "stdoutMatches": wrapped.stdout == expected_input,
                "stderrBytes": wrapped.stderr.len(),
                "stderrClass": stderr_class(&wrapped.stderr),
                "stderrPrefixTruncated": wrapped.stderr.len() > 4096
            }));
        let recovered = completed_capture(&owner, id, "recorded").await?;
        assert!(recovered["claudeQuotaCapture"]["delivery"]["latestCompleted"]["attemptSequence"]
            .as_u64().context("Recovered capture attempt")? > rejected_attempt);
        assert_eq!(recovered["nativeQuotaCallback"]["snapshot"]["reason"], "observed");
        assert!(recovered["nativeQuotaCallback"]["ordinaryUsageAllowed"].is_null());
        private_capture(&recovered);
        let context=PathBuf::from(std::fs::read_to_string(fixture.directory.join("callers").join(format!("{id}.txt")))?);
        let scoped=scoped_client(&context,id).await?;
        let refused=call(&scoped,"nesvo_create_session",json!({"key":"capture-scoped-refused","spec":{"name":"Refused scoped capture","program":"claude","claudeQuotaCapture":{"displayProfile":profile}}})).await?;
        assert_eq!(refused.structured_content.context("Scoped refusal")?["error"]["code"],"forbidden");
        let default=data(call(&owner,"nesvo_create_session",json!({"key":"default-display-untouched","spec":{"name":"Default display","program":"claude"}})).await?)?;
        let default=default["data"]["receipt"]["sessionId"].as_str().context("Default session")?;session_ready(&owner,default).await?;
        assert!(launch_settings(&fixture,default)?.get("statusLine").is_none());
        let hang=display_profile(&fixture,"hang")?;
        let created=data(call(&owner,"nesvo_create_session",json!({"key":"capture-hang","spec":{"name":"Bounded display hang","program":"claude","claudeQuotaCapture":{"displayProfile":hang}}})).await?)?;
        let hang=created["data"]["receipt"]["sessionId"].as_str().context("Hang session")?;session_ready(&owner,hang).await?;
        let settings=launch_settings(&fixture,hang)?;
        let started=tokio::time::Instant::now();
        let result=generated(settings["statusLine"]["command"].as_str().context("Hang generated command")?,b"{}",&fixture.directory).await?;
        assert!(!result.status.success());assert!(started.elapsed()<Duration::from_secs(10));
        let pid=std::fs::read_to_string(fixture.directory.join("hang.display.json.pid"))?;
        ended_process(&fixture,pid.trim()).await?;
        assert_eq!(std::fs::read(&global)?,global_bytes);
        scoped.cancel().await?;owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    }).catch_unwind().await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}
