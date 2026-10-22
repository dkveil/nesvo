use super::*;

#[cfg(windows)]
fn shell_marks(marks: &str, label: &str) -> String {
    format!(
        "$e=[char]27; $b=[char]7; [Console]::Write(\"{}\"); 'NESVO_SHELL_' + '{label}'",
        marks
            .split(';')
            .map(|mark| format!("$e]133;{}$b", mark.replace(',', ";")))
            .collect::<String>()
    )
}

#[cfg(not(windows))]
fn shell_marks(marks: &str, label: &str) -> String {
    format!(
        "printf '{}'; echo NESVO_SHELL_\"\"{label}",
        marks
            .split(';')
            .map(|mark| format!("\\033]133;{}\\007", mark.replace(',', ";")))
            .collect::<String>()
    )
}

async fn explained_status(client: &RunningService<RoleClient, ()>, id: &str) -> Result<Value> {
    let explained = data(call(client, "nesvo_explain_session", json!({"sessionId":id})).await?)?;
    Ok(explained["data"]["report"]["sessions"][0]["status"].clone())
}

async fn shell_state(
    client: &RunningService<RoleClient, ()>,
    id: &str,
    state: &str,
    marks: Value,
) -> Result<Value> {
    waits::until(async || {
        let view = data(call(client, "nesvo_get_session", json!({"sessionId":id})).await?)?;
        let status = &view["data"]["session"]["status"];
        ensure!(
            view["data"]["session"]["running"] == true,
            "Shell exited before {state}: {status}"
        );
        if status["state"] != state || status["source"] != "screen" {
            return Ok(None);
        }
        let explained = explained_status(client, id).await?;
        Ok((explained["shellMarks"] == marks).then_some(explained))
    })
    .await
}

#[tokio::test]
#[ignore = "requires cargo build --workspace and an isolated native PTY host"]
async fn shell_prompt_marks_drive_working_idle_and_last_exit_code_through_the_native_pty()
-> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let created = waits::operation(
            &owner,
            "nesvo_create_session",
            json!({"key":"shell-marks","spec":{"name":"Shell marks","program":"shell","cwd":fixture.directory}}),
        )
        .await?;
        let id = created["data"]["receipt"]["sessionId"]
            .as_str()
            .context("shell session")?;
        #[cfg(windows)]
        wait_for_initialized_powershell_prompt(&owner, id).await?;
        let started = waits::operation(
            &owner,
            "nesvo_send_prompt",
            json!({"sessionId":id,"key":"shell-mark-started","prompt":shell_marks("C", "STARTED")}),
        )
        .await?;
        assert_eq!(started["data"]["receipt"]["phase"], "delivered");
        observed_output(&owner, id, "NESVO_SHELL_STARTED").await?;
        let running = shell_state(
            &owner,

            id,
            "working",
            json!({"mark":"commandRunning","lastExitCode":null}),
        )
        .await
        .context("A command-start mark must publish working")?;
        assert_eq!(
            running["reason"],
            "shell prompt marks (OSC 133); no task outcome inferred"
        );
        let finished = waits::operation(
            &owner,
            "nesvo_send_prompt",
            json!({"sessionId":id,"key":"shell-mark-finished","prompt":shell_marks("D,3;A", "FINISHED")}),
        )
        .await?;
        assert_eq!(finished["data"]["receipt"]["phase"], "delivered");
        observed_output(&owner, id, "NESVO_SHELL_FINISHED").await?;
        shell_state(
            &owner,

            id,
            "idle",
            json!({"mark":"prompt","lastExitCode":3}),
        )
        .await
        .context("Finish and prompt marks must publish idle with the exit code")?;
        let view = data(call(&owner, "nesvo_get_session", json!({"sessionId":id})).await?)?;
        let session = &view["data"]["session"];
        assert!(session["status"].get("evidence").is_none());
        assert!(session["status"].get("confirmedSource").is_none());
        assert_eq!(session["readiness"]["phase"], "notApplicable");
        assert_eq!(session["attention"], Value::Null);
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(value) => {
            value?;
            cleanup
        }
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
