use super::*;

#[tokio::test]
#[ignore = "requires native binaries; data-directory ownership and crash release, no model calls"]
async fn data_directory_has_one_live_host_and_os_lock_releases_after_owned_process_death()
-> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let before = std::fs::read(fixture.pairing())?;
        let mut command = Command::new(Fixture::host_binary());
        command
            .args(["--port", "0", "--rotate-key", "--pairing-dir"])
            .arg(&fixture.directory)
            .arg("--workspace")
            .arg(&fixture.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = timeout(Duration::from_secs(8), command.output()).await??;
        ensure!(
            !output.status.success(),
            "A second host must not open the same metadata directory"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("already owns this pairing/data directory")
        );
        assert_eq!(
            std::fs::read(fixture.pairing())?,
            before,
            "A refused rotate-key launch cannot rewrite live pairing"
        );
        let owner = client(&fixture.pairing()).await?;
        data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        owner.cancel().await?;
        fixture.restart(true).await?;
        assert!(
            fixture.directory.join("host.lock").is_file(),
            "Stale lock filename is not stale OS ownership"
        );
        let after: Value = serde_json::from_slice(&std::fs::read(fixture.pairing())?)?;
        assert_eq!(
            after["key"],
            serde_json::from_slice::<Value>(&before)?["key"]
        );
        let owner = client(&fixture.pairing()).await?;
        data(call(&owner, "nesvo_list_sessions", json!({})).await?)?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
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
