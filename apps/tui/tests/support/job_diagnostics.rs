//! Bounded read-only failure evidence for controlled native job fixtures.
use super::*;

async fn diagnostic_cli(fixture: &Fixture, args: &[&str]) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .arg("--pairing")
        .arg(fixture.pairing())
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    match timeout(Duration::from_secs(1), command.output()).await {
        Ok(Ok(output)) => json!({
            "exitCode":output.status.code(),
            "reply":serde_json::from_slice::<Value>(&output.stdout).unwrap_or_else(|_| {
                json!({"unparsedStdout":String::from_utf8_lossy(&output.stdout).chars().take(1024).collect::<String>()})
            }),
            "stderr":String::from_utf8_lossy(&output.stderr).chars().take(1024).collect::<String>()
        }),
        Ok(Err(error)) => json!({"error":error.to_string()}),
        Err(_) => json!({"error":"Diagnostic CLI query exceeded one second"}),
    }
}

pub(super) async fn report_timeout_diagnostics(fixture: &mut Fixture, job: &str) -> Value {
    let host = match fixture.host.try_wait() {
        Ok(Some(status)) => json!({"exited":true,"exitCode":status.code()}),
        Ok(None) => json!({"exited":false}),
        Err(error) => json!({"error":error.to_string()}),
    };
    let mut diagnostics = json!({"host":host});
    // These reads start only after the acceptance deadline has already failed.
    // Keep partial observations if any diagnostic query itself gets stuck.
    let observed = timeout(Duration::from_millis(3800), async {
        let history_args = ["job", "history", job, "--json"];
        let definition_args = ["job", "show", job, "--json"];
        let (history, doctor, definition) = tokio::join!(
            diagnostic_cli(fixture, &history_args),
            diagnostic_cli(fixture, &["doctor", "--json"]),
            diagnostic_cli(fixture, &definition_args),
        );
        diagnostics["history"] = history;
        diagnostics["providerProbe"] = json!({
            "exitCode":doctor["exitCode"],"stderr":doctor["stderr"],"error":doctor["error"],
            "providerVersions":doctor["reply"]["providerVersions"],
            "eventJournal":doctor["reply"]["eventJournal"],
            "replyError":doctor["reply"]["error"]
        });
        diagnostics["job"] = definition;
        let occurrence = &diagnostics["history"]["reply"]["data"]["occurrences"][0];
        let run_id = occurrence["runId"].as_str().map(str::to_owned);
        let receipt = occurrence["launchReceiptId"].as_str().map(str::to_owned);
        let session = occurrence["sessionId"].as_str().map(str::to_owned);
        let (run, receipt, transcript, session_state) = tokio::join!(
            async {
                match run_id.as_deref() {
                    Some(run) => diagnostic_cli(fixture, &["run", "get", run, "--json"]).await,
                    None => Value::Null,
                }
            },
            async {
                match receipt {
                    Some(receipt) => {
                        diagnostic_cli(fixture, &["operation", &receipt, "--json"]).await
                    }
                    None => Value::Null,
                }
            },
            async {
                match session.as_deref() {
                    Some(session) => {
                        diagnostic_cli(
                            fixture,
                            &["session", "read", session, "--max-bytes", "2048", "--json"],
                        )
                        .await
                    }
                    None => Value::Null,
                }
            },
            async {
                match session.as_deref() {
                    Some(session) => {
                        diagnostic_cli(fixture, &["session", "get", session, "--json"]).await
                    }
                    None => Value::Null,
                }
            },
        );
        diagnostics["run"] = run;
        diagnostics["launchReceipt"] = receipt;
        // Controlled Node stderr shares its native PTY with stdout. The fixture
        // host's own stderr is already inherited by the test process.
        diagnostics["controlledWorkerOutput"] = transcript;
        diagnostics["session"] = session_state;
        let task_id = diagnostics["run"]["reply"]["data"]["tasks"][0]["id"]
            .as_str()
            .map(str::to_owned);
        if let (Some(run), Some(task)) = (run_id, task_id) {
            diagnostics["taskAttempts"] =
                diagnostic_cli(fixture, &["run", "task", &run, &task, "--json"]).await;
        }
    })
    .await;
    if observed.is_err() {
        diagnostics["diagnosticDeadlineElapsed"] = true.into();
    }
    diagnostics
}
