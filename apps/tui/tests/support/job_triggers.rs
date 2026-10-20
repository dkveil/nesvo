//! Actual signed loopback HTTP -> durable jobs -> controlled native CLI workers.
//! No models, external accounts, global configuration or database seeding.
use super::*;

type Owner = RunningService<RoleClient, ()>;
type ScenarioOutcome =
    std::thread::Result<std::result::Result<Result<()>, tokio::time::error::Elapsed>>;
const PAYLOAD_ONLY: &str = "UNTRUSTED_PAYLOAD_MUST_NOT_EXECUTE";

async fn reply(owner: &Owner, name: &'static str, args: Value) -> Result<Value> {
    data(call(owner, name, args).await?)
}

async fn listener(fixture: &Fixture) -> Result<String> {
    timeout(Duration::from_secs(5), async {
        loop {
            let doctor = budgets::owner_cli(fixture, &["doctor", "--json"]).await?;
            assert_eq!(doctor["jobTriggerListener"]["enabled"], true);
            if doctor["providerVersions"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["program"] == "claude" && row["status"] == "ready")
            }) {
                let address = doctor["jobTriggerListener"]["address"]
                    .as_str()
                    .context("Nonsecret owned webhook listener address")?;
                ensure!(
                    address.starts_with("http://127.0.0.1:"),
                    "Webhook listener must remain loopback"
                );
                return Ok::<_, anyhow::Error>(address.to_owned());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .context("Discover enabled loopback listener and controlled provider")?
}

fn job_spec(instruction: &str, overlap: &str) -> Value {
    json!({"title":"Controlled external job","instruction":instruction,
        "profile":{"program":"claude","workspace":"shared","harness":true,
            "allowedNesvoTools":["nesvo_get_current_task","nesvo_report_task_result"]},
        "schedule":{"kind":"external"},"overlap":overlap})
}

async fn job(owner: &Owner, key: &str, spec: &Value) -> Result<Value> {
    let created = reply(owner, "nesvo_create_job", json!({"key":key,"spec":spec})).await?;
    assert!(
        created["data"]["job"]["nextDueAt"].is_null(),
        "External jobs must not acquire ghost calendar deadlines"
    );
    assert_eq!(
        created["data"]["job"]["spec"]["schedule"]["kind"],
        "external"
    );
    Ok(created)
}

fn private_secret(fixture: &Fixture, name: &str, secret: &str) -> Result<PathBuf> {
    let file = fixture.directory.join(name);
    std::fs::write(&file, secret)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

async fn create_trigger(
    fixture: &Fixture,
    owner: &Owner,
    key: &str,
    job: &Value,
    adapter: Value,
) -> Result<(String, String, Value, Vec<Value>)> {
    let secret = hex::encode(nesvo_wire::random::<32>());
    let spec = json!({"title":"Owned external trigger","jobId":job["id"],"jobRevision":job["revision"],"adapter":adapter});
    let file = fixture.directory.join(format!("{key}-trigger.json"));
    std::fs::write(&file, serde_json::to_vec(&spec)?)?;
    let secret_file = private_secret(fixture, &format!("{key}-secret.txt"), &secret)?;
    let created = budgets::owner_cli(
        fixture,
        &[
            "job",
            "trigger",
            "create",
            "--key",
            key,
            "--file",
            file.to_str().context("Owned trigger file")?,
            "--secret-file",
            secret_file.to_str().context("Owned secret file")?,
            "--json",
        ],
    )
    .await?;
    let replay = reply(
        owner,
        "nesvo_create_job_trigger",
        json!({"key":key,"spec":spec,"secret":secret}),
    )
    .await?;
    assert_eq!(replay["data"], created["data"]);
    assert_eq!(created["data"]["trigger"]["enabled"], false);
    assert_eq!(created["data"]["trigger"]["revoked"], false);
    assert_eq!(created["data"]["trigger"]["revision"], 1);
    assert_eq!(created["data"]["trigger"]["credentialGeneration"], 1);
    ensure!(
        !created.to_string().contains(&secret),
        "Owner result exposed trigger secret"
    );
    let id = created["data"]["trigger"]["id"]
        .as_str()
        .context("Owned trigger ID")?
        .to_owned();
    Ok((id, secret, spec, vec![created, replay]))
}

async fn enabled(
    owner: &Owner,
    id: &str,
    key: &str,
    revision: u64,
    enabled: bool,
) -> Result<Value> {
    reply(
        owner,
        "nesvo_set_job_trigger_enabled",
        json!({"key":key,"id":id,"expectedRevision":revision,"enabled":enabled}),
    )
    .await
}

fn generic(id: &str) -> String {
    json!({"schemaVersion":1,"id":id,"event":"fixture.ready","sentAt":chrono::Utc::now().timestamp_millis(),
        "payload":{"instruction":PAYLOAD_ONLY,"profile":{"program":"shell"},"text":"łódź ✓"}}).to_string()
}

fn github(repository: u64, name: &str, branch: &str, after: &str) -> String {
    let commit = json!({"id":after,"message":PAYLOAD_ONLY,
        "timestamp":"2020-01-01T00:00:00Z","added":[],"modified":[],"removed":[],
        "author":{"name":"Fixture","email":"fixture@example.invalid"},
        "committer":{"name":"Fixture","email":"fixture@example.invalid"}});
    json!({"ref":format!("refs/heads/{branch}"),"before":"0".repeat(40),"after":after,
        "created":true,"deleted":false,"forced":false,
        "repository":{"id":repository,"full_name":name},
        "commits":[commit],"head_commit":commit,"sender":{"login":"fixture-sender"}})
    .to_string()
}

fn request(
    id: &str,
    secret: &str,
    adapter: &str,
    delivery: &str,
    event: &str,
    body: &str,
) -> Value {
    json!({"triggerId":id,"secret":secret,"adapter":adapter,"deliveryId":delivery,"event":event,"body":body})
}

async fn http(fixture: &Fixture, address: &str, requests: Vec<Value>) -> Result<Vec<Value>> {
    let node = fixture
        .directory
        .join("bin")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new(node);
    command
        .arg(root.join("tests/fixtures/job-trigger-http.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().context("Owned HTTP sender stdin")?;
    stdin
        .write_all(&serde_json::to_vec(
            &json!({"address":address,"requests":requests}),
        )?)
        .await?;
    drop(stdin);
    let output = timeout(Duration::from_secs(8), child.wait_with_output())
        .await
        .context("Owned HTTP sender bounded deadline")??;
    ensure!(
        output.status.success(),
        "Owned signed HTTP sender failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = std::str::from_utf8(&output.stdout)?;
    for req in &requests {
        ensure!(
            !text.contains(req["secret"].as_str().context("Private signing key")?),
            "HTTP response exposed a trigger secret"
        );
    }
    Ok(serde_json::from_str(text)?)
}

fn accepted(response: &Value, status: u16) -> &Value {
    assert_eq!(
        response["status"], status,
        "Unexpected actual HTTP response: {response}"
    );
    assert_eq!(response["envelope"]["ok"], true);
    let delivery = &response["envelope"]["data"]["delivery"];
    assert_eq!(
        delivery.as_object().expect("Public receipt object").len(),
        12
    );
    assert!(delivery["id"].is_string() && delivery["acceptedAt"].is_number());
    delivery
}

fn concurrent_once(responses: &[Value]) -> &Value {
    assert_eq!(responses.len(), 2);
    let first = responses
        .iter()
        .find(|row| row["status"] == 202)
        .expect("One fresh HTTP acceptance");
    let replay = responses
        .iter()
        .find(|row| row["status"] == 200)
        .expect("One replay of concurrent delivery");
    assert_eq!(accepted(first, 202), accepted(replay, 200));
    accepted(first, 202)
}

fn file_count(fixture: &Fixture, suffix: &str) -> Result<usize> {
    Ok(std::fs::read_dir(fixture.directory.join("callers"))?
        .collect::<std::io::Result<Vec<_>>>()?
        .iter()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(suffix))
        .count())
}

async fn observed_files(fixture: &Fixture, suffix: &str, wanted: usize) -> Result<()> {
    timeout(Duration::from_secs(15),async {
        loop {
            let count = file_count(fixture,suffix)?;
            ensure!(count<=wanted,"Duplicate controlled native effects: {suffix}");
            if count==wanted {return Ok::<_,anyhow::Error>(());}
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }).await.with_context(||format!("Controlled native {suffix} count did not reach {wanted} while owner clients were closed"))?
}

async fn occurrence(owner: &Owner, job: &str, id: &str) -> Result<Value> {
    reply(
        owner,
        "nesvo_get_job_occurrence",
        json!({"jobId":job,"occurrenceId":id}),
    )
    .await
}

async fn native_report(owner: &Owner, row: &Value) -> Result<Vec<Value>> {
    assert_eq!(row["trigger"], "external");
    assert_eq!(row["state"], "needsValidation");
    assert_eq!(row["jobAttemptOrdinal"], 1);
    assert!(row["finishedAt"].is_null());
    let run = reply(owner, "nesvo_get_run", json!({"runId":row["runId"]})).await?;
    assert_eq!(run["data"]["tasks"][0]["attempts"], 1);
    assert_eq!(
        run["data"]["tasks"][0]["currentAttempt"]["id"],
        row["attemptId"]
    );
    let attempts = reply(
        owner,
        "nesvo_get_task_attempts",
        json!({"runId":row["runId"],"taskId":run["data"]["tasks"][0]["id"]}),
    )
    .await?;
    let records = attempts["data"]["attempts"]
        .as_array()
        .context("One real external native attempt")?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["launch"]["phase"], "created");
    assert_eq!(records[0]["launch"]["receiptId"], row["launchReceiptId"]);
    assert_eq!(records[0]["result"]["outcome"], "succeeded");
    assert!(records[0]["validation"].is_null());
    let worker = row["sessionId"]
        .as_str()
        .context("Controlled external worker")?;
    observed_output(owner, worker, "FIXTURE_RESPONSE report-task").await?;
    let transcript = reply(
        owner,
        "nesvo_read_session",
        json!({"sessionId":worker,"maxBytes":8192}),
    )
    .await?;
    let text = transcript["data"]["page"]["data"]
        .as_str()
        .context("External worker transcript")?;
    assert_eq!(text.matches("FIXTURE_RESPONSE report-task").count(), 1);
    assert!(
        !text.contains(PAYLOAD_ONLY),
        "Webhook payload was interpolated into native agent input"
    );
    Ok(vec![run, attempts, transcript])
}

async fn finish(
    fixture: &mut Fixture,
    phase: &str,
    job: Option<&str>,
    outcome: ScenarioOutcome,
) -> Result<()> {
    if !matches!(&outcome, Ok(Ok(Ok(())))) {
        let diagnostics = match job {
            Some(job) => job_diagnostics::report_timeout_diagnostics(fixture, job).await,
            None => json!({"jobNotCreated":true}),
        };
        eprintln!(
            "JOB_TRIGGER_NATIVE_DIAGNOSTIC {}",
            json!({"phase":phase,"actual":diagnostics})
                .to_string()
                .chars()
                .take(16384)
                .collect::<String>()
        );
    }
    let cleanup = fixture.close().await;
    match outcome {
        Ok(result) => {
            result.with_context(|| {
                format!("Signed HTTP native scenario deadline; last phase: {phase}")
            })??;
            cleanup
        }
        Err(panic) => {
            cleanup?;
            std::panic::resume_unwind(panic)
        }
    }
}

#[tokio::test]
#[ignore = "real signed HTTP/CLI/MCP, closed-owner native PTY and durable replay/rotation; no models"]
async fn signed_webhook_dispatches_once_without_clients_and_retains_replay_across_restart()
-> Result<()> {
    let mut fixture = Fixture::start_with_webhooks().await?;
    let mut phase = "listener and external-only definition";
    let mut diagnostic_job = None;
    let outcome = std::panic::AssertUnwindSafe(timeout(Duration::from_secs(60),async {
        let address = listener(&fixture).await?;
        let owner = client(&fixture.pairing()).await?;
        let created = job(&owner,"webhook-job",&job_spec("report-task","queue")).await?;
        let job_id = created["data"]["job"]["id"].as_str().context("Webhook job")?;
        diagnostic_job=Some(job_id.to_owned());
        let (id,secret,_,mut envelopes)=create_trigger(&fixture,&owner,"generic-trigger",&created["data"]["job"],json!({"kind":"webhook","event":"fixture.ready"})).await?;
        let enabled_cli = budgets::owner_cli(&fixture,&["job","trigger","enable",&id,"--key","generic-enable","--revision","1","--json"]).await?;
        let enabled_replay = enabled(&owner,&id,"generic-enable",1,true).await?;
        assert_eq!(enabled_replay["data"],enabled_cli["data"]);
        let shown=budgets::owner_cli(&fixture,&["job","trigger","show",&id,"--json"]).await?;
        let shown_mcp=reply(&owner,"nesvo_get_job_trigger",json!({"id":id})).await?;
        assert_eq!(shown["data"],shown_mcp["data"]);
        let listed=budgets::owner_cli(&fixture,&["job","trigger","list","--json"]).await?;
        let listed_mcp=reply(&owner,"nesvo_list_job_triggers",json!({})).await?;
        assert_eq!(listed["data"],listed_mcp["data"]);
        let mutation=budgets::owner_cli(&fixture,&["job","trigger","mutation","--key","generic-trigger","--json"]).await?;
        let mutation_mcp=reply(&owner,"nesvo_get_job_trigger_mutation",json!({"key":"generic-trigger"})).await?;
        assert_eq!(mutation["data"],mutation_mcp["data"]);
        assert_eq!(mutation["data"]["trigger"]["enabled"],false,"Mutation lookup retains original redacted acceptance");
        phase="owner closed before concurrent signed HTTP acceptance";
        owner.cancel().await?;
        let body=generic("generic-once");
        let req=request(&id,&secret,"webhook","generic-once","fixture.ready",&body);
        let responses=http(&fixture,&address,vec![req.clone(),req.clone()]).await?;
        let delivery=concurrent_once(&responses).clone();
        assert_eq!(delivery["disposition"],"queued");
        observed_files(&fixture,".result.json",1).await?;
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        phase="reconnect to the one actual native report";
        let owner=client(&fixture.pairing()).await?;
        let occurrence_id=delivery["occurrenceId"].as_str().context("Webhook occurrence")?;
        let reported=job_cancellation::occurrence(&owner,job_id,occurrence_id,"needsValidation").await?;
        envelopes.extend(native_report(&owner,&reported["data"]["occurrence"]).await?);
        let read=budgets::owner_cli(&fixture,&["job","trigger","delivery",&id,delivery["deliveryId"].as_str().context("Public delivery ID")?,"--json"]).await?;
        let read_mcp=reply(&owner,"nesvo_get_job_trigger_delivery",json!({"id":id,"deliveryId":delivery["deliveryId"]})).await?;
        assert_eq!(read["data"],read_mcp["data"]);
        assert_eq!(read["data"]["delivery"],delivery);
        let row=&reported["data"]["occurrence"];
        run_checkpoints::mutate(&owner,row["runId"].as_str().context("External run")?,"nesvo_validate_task_result",json!({"key":"validate-before-webhook-restart","attemptId":row["attemptId"],"validation":{"passed":true,"summary":"Inspected controlled external result","checks":[{"name":"fixture","outcome":"passed","details":"One actual scoped native report"}]}})).await?;
        let succeeded=job_cancellation::occurrence(&owner,job_id,occurrence_id,"succeeded").await?;
        owner.cancel().await?;
        phase="graceful restart preserves opt-in listener and delivery identity";
        fixture.restart(false).await?;
        let address=listener(&fixture).await?;
        let replay=http(&fixture,&address,vec![req.clone()]).await?;
        assert_eq!(accepted(&replay[0],200),&delivery);
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        let owner=client(&fixture.pairing()).await?;
        let retained=occurrence(&owner,job_id,occurrence_id).await?;
        assert_eq!(retained["data"]["occurrence"]["state"],"succeeded");
        phase="rotation requires the current secret even for immutable replay";
        let replacement=hex::encode(nesvo_wire::random::<32>());
        let replacement_file=private_secret(&fixture,"rotated-trigger-secret.txt",&replacement)?;
        let rotated=budgets::owner_cli(&fixture,&["job","trigger","rotate",&id,"--key","generic-rotate","--revision","2","--secret-file",replacement_file.to_str().context("Rotation secret file")?,"--json"]).await?;
        let rotation_replay=reply(&owner,"nesvo_rotate_job_trigger",json!({"key":"generic-rotate","id":id,"expectedRevision":2,"secret":replacement})).await?;
        assert_eq!(rotation_replay["data"],rotated["data"]);
        assert_eq!(rotated["data"]["trigger"]["credentialGeneration"],2);
        let old=http(&fixture,&address,vec![req]).await?;
        assert_eq!(old[0]["status"],401);
        let current_req=request(&id,&replacement,"webhook","generic-once","fixture.ready",&body);
        let current=http(&fixture,&address,vec![current_req.clone()]).await?;
        assert_eq!(accepted(&current[0],200),&delivery);
        let revoked=budgets::owner_cli(&fixture,&["job","trigger","revoke",&id,"--key","generic-revoke","--revision","3","--json"]).await?;
        let revoke_replay=reply(&owner,"nesvo_revoke_job_trigger",json!({"key":"generic-revoke","id":id,"expectedRevision":3})).await?;
        assert_eq!(revoke_replay["data"],revoked["data"]);
        assert_eq!(revoked["data"]["trigger"]["revoked"],true);
        let denied=http(&fixture,&address,vec![current_req]).await?;
        assert_eq!(denied[0]["status"],401);
        let deliveries=reply(&owner,"nesvo_get_job_trigger_deliveries",json!({"id":id})).await?;
        let deliveries_cli=budgets::owner_cli(&fixture,&["job","trigger","deliveries",&id,"--json"]).await?;
        assert_eq!(deliveries_cli["data"],deliveries["data"]);
        assert_eq!(deliveries["data"]["deliveries"].as_array().context("One durable authenticated delivery")?.len(),1);
        let history=reply(&owner,"nesvo_get_job_history",json!({"jobId":job_id})).await?;
        assert_eq!(history["data"]["occurrences"].as_array().context("One external occurrence")?.len(),1);
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        envelopes.extend([created.clone(),enabled_cli,enabled_replay,shown,shown_mcp,listed,listed_mcp,mutation,mutation_mcp,read,read_mcp,reported,succeeded,retained,rotated,rotation_replay,revoked,revoke_replay,deliveries,deliveries_cli,history]);
        for responses in [responses,replay,old,current,denied] {envelopes.extend(responses.into_iter().map(|r|r["envelope"].clone()));}
        phase="actual CLI/MCP/HTTP JSON schema";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(&mut fixture, phase, diagnostic_job.as_deref(), outcome).await
}

#[tokio::test]
#[ignore = "real GitHub HMAC adapter, signed repository filters and closed-owner native worker; no models"]
async fn github_signature_filters_and_unsigned_delivery_replays_cannot_duplicate_native_work()
-> Result<()> {
    let mut fixture = Fixture::start_with_webhooks().await?;
    let mut phase = "GitHub trigger authorization";
    let mut diagnostic_job = None;
    let outcome=std::panic::AssertUnwindSafe(timeout(Duration::from_secs(50),async {
        let address=listener(&fixture).await?;
        let owner=client(&fixture.pairing()).await?;
        let created=job(&owner,"github-job",&job_spec("report-task","skip")).await?;
        let job_id=created["data"]["job"]["id"].as_str().context("GitHub job")?;
        diagnostic_job=Some(job_id.to_owned());
        let (id,secret,_,mut envelopes)=create_trigger(&fixture,&owner,"github-trigger",&created["data"]["job"],json!({"kind":"github","repositoryId":4242,"repository":"fixture/owned","event":"push","actions":[],"branch":"main"})).await?;
        let on=enabled(&owner,&id,"github-enable",1,true).await?;
        phase="invalid authentication cannot poison the later authentic delivery ID";
        let body=github(4242,"fixture/owned","main",&"1".repeat(40));
        let good=request(&id,&secret,"github","github-authentic","push",&body);
        let mut bad=good.clone();bad["invalidSignature"]=true.into();
        let mut tampered=good.clone();tampered["body"]=github(4242,"fixture/owned","main",&"2".repeat(40)).into();tampered["signedBody"]=body.clone().into();
        let invalid=http(&fixture,&address,vec![bad,tampered]).await?;
        for r in &invalid {assert_eq!(r["status"],401);}
        let none=reply(&owner,"nesvo_get_job_trigger_deliveries",json!({"id":id})).await?;
        assert!(none["data"]["deliveries"].as_array().context("Authentication failures leave no accepted records")?.is_empty());
        assert_eq!(file_count(&fixture,".launch-argv.json")?,0);
        phase="signed repository, ref and event filters are immutable ignored receipts";
        let denied_requests=vec![
            request(&id,&secret,"github","wrong-repository","push",&github(999,"fixture/other","main",&"3".repeat(40))),
            request(&id,&secret,"github","wrong-branch","push",&github(4242,"fixture/owned","other",&"4".repeat(40))),
            request(&id,&secret,"github","wrong-event","pull_request",&json!({"repository":{"id":4242,"full_name":"fixture/owned"},"number":1,"action":"opened","pull_request":{"base":{"ref":"main"}}}).to_string())
        ];
        let ignored=http(&fixture,&address,denied_requests).await?;
        for r in &ignored {let d=accepted(r,202);assert_eq!(d["disposition"],"ignored");assert!(d["occurrenceId"].is_null());assert!(d["reason"].is_string());}
        assert_eq!(file_count(&fixture,".launch-argv.json")?,0);
        let empty=reply(&owner,"nesvo_get_job_history",json!({"jobId":job_id})).await?;
        assert!(empty["data"]["occurrences"].as_array().context("Filtered events cannot admit runs")?.is_empty());
        phase="closed-owner real GitHub delivery; body hash fences unsigned header-ID changes";
        owner.cancel().await?;
        let mut changed_header=good.clone();changed_header["deliveryId"]="github-same-signed-body-new-header".into();
        let delivered=http(&fixture,&address,vec![good,changed_header]).await?;
        let delivery=concurrent_once(&delivered).clone();
        observed_files(&fixture,".result.json",1).await?;
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        let owner=client(&fixture.pairing()).await?;
        let current=job_cancellation::occurrence(&owner,job_id,delivery["occurrenceId"].as_str().context("GitHub occurrence")?,"needsValidation").await?;
        envelopes.extend(native_report(&owner,&current["data"]["occurrence"]).await?);
        let deliveries=reply(&owner,"nesvo_get_job_trigger_deliveries",json!({"id":id})).await?;
        let rows=deliveries["data"]["deliveries"].as_array().context("GitHub retained receipts")?;
        assert_eq!(rows.len(),4,"Neither auth failures nor unsigned header duplicates add accepted records");
        assert_eq!(rows.iter().filter(|r|r["occurrenceId"].is_string()).count(),1);
        let history=reply(&owner,"nesvo_get_job_history",json!({"jobId":job_id})).await?;
        assert_eq!(history["data"]["occurrences"].as_array().context("One GitHub occurrence")?.len(),1);
        envelopes.extend([created.clone(),on,none,empty,current,deliveries,history]);
        for responses in [invalid,ignored,delivered] {envelopes.extend(responses.into_iter().map(|r|r["envelope"].clone()));}
        phase="actual GitHub HTTP and owner JSON schema";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(&mut fixture, phase, diagnostic_job.as_deref(), outcome).await
}

#[tokio::test]
#[ignore = "real authenticated HTTP overlap/disable controls and exact native worker cancellation; no models"]
async fn disabled_receipts_stay_ignored_and_accepted_overlap_queue_waits_for_native_cleanup()
-> Result<()> {
    let mut fixture = Fixture::start_with_webhooks().await?;
    let mut phase = "disabled trigger receipt";
    let mut diagnostic_job = None;
    let outcome=std::panic::AssertUnwindSafe(timeout(Duration::from_secs(60),async {
        let address=listener(&fixture).await?;
        let owner=client(&fixture.pairing()).await?;
        let spec=job_spec("hold-response","queue");
        let created=job(&owner,"overlap-external-job",&spec).await?;
        let job_id=created["data"]["job"]["id"].as_str().context("External overlap job")?;
        diagnostic_job=Some(job_id.to_owned());
        let (id,secret,mut trigger_spec,mut envelopes)=create_trigger(&fixture,&owner,"overlap-trigger",&created["data"]["job"],json!({"kind":"webhook","event":"fixture.ready"})).await?;
        let disabled_body=generic("initially-disabled");
        let disabled_req=request(&id,&secret,"webhook","initially-disabled","fixture.ready",&disabled_body);
        let disabled=http(&fixture,&address,vec![disabled_req.clone()]).await?;
        let ignored_trigger=accepted(&disabled[0],202).clone();assert_eq!(ignored_trigger["disposition"],"ignored");assert!(ignored_trigger["occurrenceId"].is_null());
        let on=enabled(&owner,&id,"overlap-trigger-enable",1,true).await?;
        let ignored_replay=http(&fixture,&address,vec![disabled_req]).await?;
        assert_eq!(accepted(&ignored_replay[0],200),&ignored_trigger);
        let pause=reply(&owner,"nesvo_set_job_enabled",json!({"key":"external-job-pause","jobId":job_id,"expectedRevision":1,"enabled":false})).await?;
        let paused_body=generic("job-was-disabled");
        let paused_req=request(&id,&secret,"webhook","job-was-disabled","fixture.ready",&paused_body);
        let paused=http(&fixture,&address,vec![paused_req.clone()]).await?;
        let ignored_job=accepted(&paused[0],202).clone();assert_eq!(ignored_job["disposition"],"ignored");assert!(ignored_job["occurrenceId"].is_null());
        let resume=reply(&owner,"nesvo_set_job_enabled",json!({"key":"external-job-resume","jobId":job_id,"expectedRevision":2,"enabled":true})).await?;
        let paused_replay=http(&fixture,&address,vec![paused_req]).await?;
        assert_eq!(accepted(&paused_replay[0],200),&ignored_job);
        assert_eq!(file_count(&fixture,".launch-argv.json")?,0);
        phase="first real external held worker starts while owner is closed";
        owner.cancel().await?;
        let first=http(&fixture,&address,vec![request(&id,&secret,"webhook","first-held-worker","fixture.ready",&generic("first-held-worker"))]).await?;
        let first_delivery=accepted(&first[0],202).clone();
        observed_files(&fixture,".launch-argv.json",1).await?;
        let owner=client(&fixture.pairing()).await?;
        let first_id=first_delivery["occurrenceId"].as_str().context("Held external occurrence")?;
        let held=job_cancellation::occurrence(&owner,job_id,first_id,"running").await?;
        let first_session=held["data"]["occurrence"]["sessionId"].as_str().context("Held exact native worker")?;
        observed_output(&owner,first_session,"FIXTURE_HOLDING_RESPONSE").await?;
        let mut future=spec.clone();future["instruction"]="report-task".into();
        let edited=reply(&owner,"nesvo_update_job",json!({"key":"external-future-report","jobId":job_id,"expectedRevision":3,"spec":future})).await?;
        trigger_spec["jobRevision"]=4.into();
        let rebound_file=fixture.directory.join("updated-trigger.json");
        std::fs::write(&rebound_file,serde_json::to_vec(&trigger_spec)?)?;
        let rebound=budgets::owner_cli(&fixture,&["job","trigger","edit",&id,"--key","authorize-new-job-spec","--revision","2","--file",rebound_file.to_str().context("Updated trigger file")?,"--json"]).await?;
        let rebound_replay=reply(&owner,"nesvo_update_job_trigger",json!({"key":"authorize-new-job-spec","id":id,"expectedRevision":2,"spec":trigger_spec})).await?;
        assert_eq!(rebound_replay["data"],rebound["data"]);
        phase="distinct event is queued once behind a real live worker";
        let next_body=generic("queued-report-worker");
        let next_req=request(&id,&secret,"webhook","queued-report-worker","fixture.ready",&next_body);
        let next=http(&fixture,&address,vec![next_req.clone(),next_req]).await?;
        let second_delivery=concurrent_once(&next).clone();
        let second_id=second_delivery["occurrenceId"].as_str().context("Queued external occurrence")?;
        assert_ne!(first_id,second_id);
        let queued=occurrence(&owner,job_id,second_id).await?;
        assert_eq!(queued["data"]["occurrence"]["state"],"queued");
        for field in ["runId","jobAttemptId","attemptId","sessionId","launchReceiptId"] {assert!(queued["data"]["occurrence"][field].is_null());}
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        phase="job-disable fences external queue while owner cancels the first worker";
        let pause_queue=reply(&owner,"nesvo_set_job_enabled",json!({"key":"pause-accepted-external-queue","jobId":job_id,"expectedRevision":4,"enabled":false})).await?;
        let off=budgets::owner_cli(&fixture,&["job","trigger","disable",&id,"--key","disable-only-new-ingress","--revision","3","--json"]).await?;
        let off_replay=enabled(&owner,&id,"disable-only-new-ingress",3,false).await?;
        assert_eq!(off_replay["data"],off["data"]);
        let cancel=budgets::owner_cli(&fixture,&["job","cancel",job_id,first_id,"--key","cancel-held-external-worker","--json"]).await?;
        let canceled=job_cancellation::occurrence(&owner,job_id,first_id,"canceled").await?;
        let stopped=reply(&owner,"nesvo_get_session",json!({"sessionId":first_session})).await?;
        assert_eq!(stopped["data"]["session"]["running"],false);
        let control=reply(&owner,"nesvo_get_run_control",json!({"runId":held["data"]["occurrence"]["runId"],"controlId":canceled["data"]["occurrence"]["cancellation"]["controlId"]})).await?;
        assert_eq!(control["data"]["control"]["state"],"completed");
        assert_eq!(control["data"]["targets"].as_array().context("One canceled target")?.len(),1);
        assert_eq!(control["data"]["targets"][0]["sessionId"],first_session);
        assert_eq!(control["data"]["targets"][0]["phase"],"exited");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let still_queued=occurrence(&owner,job_id,second_id).await?;
        assert_eq!(still_queued["data"]["occurrence"]["state"],"queued");
        assert!(still_queued["data"]["occurrence"]["runId"].is_null());
        assert_eq!(file_count(&fixture,".launch-argv.json")?,1);
        phase="trigger-disable rejects new events but does not cancel accepted queue";
        let blocked=http(&fixture,&address,vec![request(&id,&secret,"webhook","disabled-again","fixture.ready",&generic("disabled-again"))]).await?;
        assert_eq!(accepted(&blocked[0],202)["disposition"],"ignored");
        let resume_queue=reply(&owner,"nesvo_set_job_enabled",json!({"key":"resume-accepted-external-queue","jobId":job_id,"expectedRevision":5,"enabled":true})).await?;
        owner.cancel().await?;
        observed_files(&fixture,".result.json",1).await?;
        assert_eq!(file_count(&fixture,".launch-argv.json")?,2);
        let owner=client(&fixture.pairing()).await?;
        let reported=job_cancellation::occurrence(&owner,job_id,second_id,"needsValidation").await?;
        envelopes.extend(native_report(&owner,&reported["data"]["occurrence"]).await?);
        assert_eq!(reported["data"]["occurrence"]["jobRevision"],4);
        assert_eq!(held["data"]["occurrence"]["spec"]["instruction"],"hold-response");
        assert_eq!(reported["data"]["occurrence"]["spec"]["instruction"],"report-task");
        assert_ne!(reported["data"]["occurrence"]["sessionId"],held["data"]["occurrence"]["sessionId"]);
        let deliveries=reply(&owner,"nesvo_get_job_trigger_deliveries",json!({"id":id})).await?;
        assert_eq!(deliveries["data"]["deliveries"].as_array().context("Five authenticated unique delivery records")?.len(),5);
        let history=reply(&owner,"nesvo_get_job_history",json!({"jobId":job_id})).await?;
        assert_eq!(history["data"]["occurrences"].as_array().context("Only two actual admitted occurrences")?.len(),2);
        envelopes.extend([created.clone(),on,pause,resume,held,edited,rebound,rebound_replay,queued,pause_queue,off,off_replay,cancel,canceled,stopped,control,still_queued,resume_queue,reported,deliveries,history]);
        for responses in [disabled,ignored_replay,paused,paused_replay,first,next,blocked] {envelopes.extend(responses.into_iter().map(|r|r["envelope"].clone()));}
        phase="actual lifecycle/HTTP owner JSON schema";
        run_checkpoints::schema(envelopes).await?;
        owner.cancel().await?;
        Ok::<_,anyhow::Error>(())
    })).catch_unwind().await;
    finish(&mut fixture, phase, diagnostic_job.as_deref(), outcome).await
}
