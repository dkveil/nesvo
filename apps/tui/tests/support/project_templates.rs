use super::*;
use budgets::owner_cli;

const TEMPLATES: &str = "[[workflow]]\nname = \"triage\"\ntitle = \"Triage\"\ngoal = \"Triage the open issues\"\nstart = \"draft\"\n\n[[workflow.task]]\nkey = \"triage\"\ninstruction = \"List the issues worth fixing\"\nprogram = \"claude\"\nworkspace = \"shared\"\n";

async fn git(directory: &Path, args: &[&str]) -> Result<()> {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .context("Owned template Git command deadline")??;
    ensure!(
        output.status.success(),
        "Owned template Git fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn repository(fixture: &Fixture) -> Result<PathBuf> {
    let directory = fixture.directory.join("templates");
    std::fs::create_dir(&directory)?;
    git(&directory, &["init", "--quiet"]).await?;
    git(&directory, &["config", "--local", "core.autocrlf", "false"]).await?;
    git(&directory, &["config", "--local", "core.hooksPath", ""]).await?;
    std::fs::write(directory.join("nesvo.toml"), TEMPLATES)?;
    git(&directory, &["add", "--", "nesvo.toml"]).await?;
    git(
        &directory,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "owned workflow templates",
        ],
    )
    .await?;
    Ok(directory)
}

async fn validate(envelopes: Vec<Value>) -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .arg(root.join("tests/fixtures/validate-harness-json.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut process = command.spawn()?;
    process
        .stdin
        .take()
        .context("schema input")?
        .write_all(&serde_json::to_vec(&envelopes)?)
        .await?;
    let output = timeout(Duration::from_secs(8), process.wait_with_output()).await??;
    ensure!(
        output.status.success(),
        "Real project and template contract validation: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn launched_project(fixture: &Fixture, session: &str) -> Result<(Value, String)> {
    timeout(Duration::from_secs(10), async {
        loop {
            let listed = owner_cli(fixture, &["project", "list", "--json"]).await?;
            let root = listed["data"]["projects"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|project| {
                    project["sessions"]
                        .as_array()
                        .is_some_and(|sessions| sessions.iter().any(|id| id == session))
                })
                .and_then(|project| project["root"].as_str())
                .map(str::to_owned);
            if let Some(root) = root {
                return Ok::<_, anyhow::Error>((listed, root));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("Launched shell project in the registry")?
}

#[tokio::test]
#[ignore = "requires built native binaries, Git and Node; project and workflow template CLI replies without model calls"]
async fn project_and_template_cli_replies_match_the_published_schema() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let repository = repository(&fixture).await?;
        let directory = repository.to_str().context("template repository path")?;
        let owner = client(&fixture.pairing()).await?;
        let shell = data(
            call(
                &owner,
                "nesvo_create_session",
                json!({"key":"project-shell","spec":{"name":"Project shell","program":"shell","cwd":directory}}),
            )
            .await?,
        )?;
        let session = shell["data"]["receipt"]["sessionId"]
            .as_str()
            .context("project shell")?
            .to_owned();
        let (listed, root) = launched_project(&fixture, &session).await?;
        let pinned = owner_cli(&fixture, &["project", "pin", &root, "--json"]).await?;
        assert_eq!(pinned["data"]["pinned"], true);
        let unpinned = owner_cli(&fixture, &["project", "unpin", &root, "--json"]).await?;
        assert_eq!(unpinned["data"]["pinned"], false);
        let layout = owner_cli(&fixture, &["project", "layout", &root, "Quad", "--json"]).await?;
        assert_eq!(layout["data"]["defaultLayout"], "Quad");
        let cleared =
            owner_cli(&fixture, &["project", "layout", &root, "--clear", "--json"]).await?;
        assert_eq!(cleared["data"]["defaultLayout"], Value::Null);
        let defaults = owner_cli(&fixture, &["project", "defaults", &root, "--json"]).await?;
        assert_eq!(defaults["data"]["root"], root.as_str());
        let templates = owner_cli(
            &fixture,
            &["workflow", "templates", "--directory", directory, "--json"],
        )
        .await?;
        assert_eq!(templates["data"]["approved"], false);
        let digest = templates["data"]["digest"]
            .as_str()
            .context("template digest")?
            .to_owned();
        let approved = owner_cli(
            &fixture,
            &[
                "workflow",
                "approve-templates",
                "--directory",
                directory,
                "--digest",
                &digest,
                "--json",
            ],
        )
        .await?;
        assert_eq!(approved["data"]["digest"], digest.as_str());
        let started = owner_cli(
            &fixture,
            &[
                "workflow",
                "start",
                "triage",
                "--directory",
                directory,
                "--key",
                "template-start",
                "--json",
            ],
        )
        .await?;
        assert_eq!(started["data"]["start"], "draft");
        assert_eq!(started["data"]["executor"], Value::Null);
        let revoked = owner_cli(
            &fixture,
            &[
                "workflow",
                "revoke-templates",
                "--directory",
                directory,
                "--digest",
                &digest,
                "--json",
            ],
        )
        .await?;
        assert_eq!(revoked["data"]["revoked"], true);
        validate(vec![
            listed, pinned, unpinned, layout, cleared, defaults, templates, approved, started,
            revoked,
        ])
        .await?;
        data(
            call(
                &owner,
                "nesvo_stop_session",
                json!({"key":"stop-project-shell","sessionId":session}),
            )
            .await?,
        )?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result?;
            cleanup?;
        }
        Err(panic) => {
            let _ = cleanup;
            std::panic::resume_unwind(panic);
        }
    }
    Ok(())
}
