use super::*;
use budgets::owner_cli;
use std::collections::BTreeMap;

type Owner = RunningService<RoleClient, ()>;

const CHOICE: &str = "Use the release branch";
const NOTE: &str = "Keep the public API unchanged";
const GOLDEN: &str = "tests/fixtures/host-inbox-replies.json";
const GOLDEN_TIME_BASE_MS: u64 = 1_792_783_600_000;
const ANCHORED_TIMES: [&str; 3] = ["at", "createdAt", "expiresAt"];
const OBSERVED_TIMES: [(&str, u64); 2] = [("acknowledgedAt", 60_000), ("resolvedAt", 120_000)];
const GOLDEN_CURSOR: u64 = 41;
const TIMESTAMP_FLOOR_MS: u64 = 1_000_000_000_000;

pub(super) struct Question {
    pub(super) run: String,
    pub(super) worker: String,
    pub(super) attempt: String,
    pub(super) decision: String,
}

pub(super) async fn pending_question(fixture: &Fixture, owner: &Owner) -> Result<Question> {
    waits::provider(fixture, "claude")
        .await
        .context("Decision worker provider probe")?;
    let created = waits::operation(owner, "nesvo_create_session", json!({
        "key":"decision-worker","spec":{"name":"Decision worker","program":"claude","harness":true}
    })).await?;
    let worker = created["data"]["receipt"]["sessionId"]
        .as_str()
        .context("Decision worker")?
        .to_owned();
    session_ready(owner, &worker).await?;
    let run = data(call(owner, "nesvo_create_run", json!({
        "key":"decision-run","spec":{"title":"Release decision","goal":"Ask the owner once and keep one answer"}
    })).await?)?;
    let run = run["data"]["run"]["id"]
        .as_str()
        .context("Decision run")?
        .to_owned();
    let plan = data(call(owner, "nesvo_set_run_plan", json!({
        "key":"decision-plan","runId":run,"expectedRevision":1,
        "tasks":[{"key":"release","title":"Release","instruction":"Ask before choosing the branch"}]
    })).await?)?;
    data(
        call(
            owner,
            "nesvo_activate_run",
            json!({"key":"decision-active","runId":run,"expectedRevision":2}),
        )
        .await?,
    )?;
    let assigned = data(call(owner, "nesvo_assign_task", json!({
        "key":"decision-assign","runId":run,"taskId":plan["data"]["tasks"][0]["id"],"sessionId":worker,"expectedRevision":3
    })).await?)?;
    let attempt = assigned["data"]["tasks"][0]["currentAttempt"]["id"]
        .as_str()
        .context("Decision attempt")?
        .to_owned();
    let context = PathBuf::from(std::fs::read_to_string(
        fixture
            .directory
            .join("callers")
            .join(format!("{worker}.txt")),
    )?);
    let question = fixture.directory.join("decision question.txt");
    std::fs::write(&question, "Which branch should the worker use?")?;
    let asked = inbox::scoped_cli(
        &context,
        &[
            "run",
            "decision",
            "ask",
            &attempt,
            "--key",
            "decision-question",
            "--question-file",
            question.to_str().context("Question path")?,
            "--timeout-ms",
            "300000",
            "--json",
        ],
    )
    .await?;
    let decision = asked["data"]["decision"]["id"]
        .as_str()
        .context("Decision ID")?
        .to_owned();
    Ok(Question {
        run,
        worker,
        attempt,
        decision,
    })
}

async fn decision_view(owner: &Owner, question: &Question) -> Result<Value> {
    Ok(data(
        call(
            owner,
            "nesvo_get_decision",
            json!({"runId":question.run,"decisionId":question.decision}),
        )
        .await?,
    )?["data"]["decision"]
        .clone())
}

async fn decide_and_lose_the_reply(
    fixture: &Fixture,
    owner: &Owner,
    question: &Question,
) -> Result<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nesvo"));
    command
        .arg("--pairing")
        .arg(fixture.pairing())
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut adapter = command.spawn()?;
    let mut input = adapter.stdin.take().context("Lost-reply adapter input")?;
    let frames = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":ProtocolVersion::LATEST,"capabilities":{},
            "clientInfo":{"name":"lost-reply","version":"1.0.0"}
        }}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
            "name":"nesvo_decide","arguments":{"decisionId":question.decision,"choice":CHOICE,"note":NOTE}
        }}),
    ];
    for frame in frames {
        input.write_all(&serde_json::to_vec(&frame)?).await?;
        input.write_all(b"\n").await?;
    }
    input.flush().await?;
    let answered = waits::until(async || {
        let current = decision_view(owner, question).await?;
        if current["state"] == "answered" {
            return Ok(Some(current));
        }
        ensure!(
            current["state"] == "pending",
            "Decision settled without the answer: {current}"
        );
        ensure!(
            adapter.try_wait()?.is_none(),
            "The lost-reply adapter exited before the decision was answered"
        );
        Ok(None)
    })
    .await
    .context("The decide request reached the host")?;
    adapter.start_kill()?;
    adapter.wait().await?;
    drop(input);
    Ok(answered)
}

async fn answered_events(owner: &Owner, decision: &str) -> Result<usize> {
    let mut count = 0;
    let mut cursor = 0;
    loop {
        let page = data(call(owner, "nesvo_read_events", json!({"after":cursor})).await?)?;
        ensure!(
            page["data"]["gap"] == false,
            "Decision journal must be complete: {page}"
        );
        count += page["data"]["events"]
            .as_array()
            .context("Decision journal events")?
            .iter()
            .filter(|event| {
                event["kind"] == "run.decision_answered"
                    && event["payload"].to_string().contains(decision)
            })
            .count();
        if page["data"]["more"] != true {
            return Ok(count);
        }
        cursor = page["data"]["nextCursor"]
            .as_u64()
            .context("Decision journal cursor")?;
    }
}

async fn fixture_cleanup(
    fixture: &mut Fixture,
    outcome: std::thread::Result<Result<()>>,
) -> Result<()> {
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

#[tokio::test]
#[ignore = "requires native binaries and Node; a decide whose reply is lost replays the same outcome without a second answer"]
async fn lost_decide_reply_replays_the_original_outcome_without_a_second_answer() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let question = pending_question(&fixture, &owner).await?;
        let inbox_id = format!("decision:{}:{}", question.run, question.decision);
        let pending = data(call(&owner, "nesvo_list_pending_decisions", json!({})).await?)?;
        assert_eq!(pending["data"]["total"], 1);
        assert_eq!(
            pending["data"]["decisions"][0]["inboxId"],
            inbox_id.as_str()
        );
        let inbox = data(call(&owner, "nesvo_list_attention_inbox", json!({})).await?)?;
        assert_eq!(inbox["data"]["total"], 1);
        assert_eq!(inbox["data"]["items"][0]["id"], inbox_id.as_str());

        let answered = decide_and_lose_the_reply(&fixture, &owner, &question).await?;
        assert_eq!(answered["answer"], format!("{CHOICE}\n\n{NOTE}"));
        assert_eq!(answered["resolvedBy"]["role"], "owner");
        let replay = data(
            call(
                &owner,
                "nesvo_decide",
                json!({"decisionId":question.decision,"choice":CHOICE,"note":NOTE}),
            )
            .await?,
        )?;
        assert_eq!(replay["data"]["type"], "decided");
        assert_eq!(replay["data"]["inboxId"], inbox_id.as_str());
        assert_eq!(
            replay["data"]["decision"], answered,
            "The replay returns the outcome the lost reply carried"
        );
        let original = data(
            call(
                &owner,
                "nesvo_get_run_mutation",
                json!({"key":format!("decide:{}:1", question.decision)}),
            )
            .await?,
        )?;
        assert_eq!(original["data"]["decision"], replay["data"]["decision"]);
        assert_eq!(original["data"]["cursor"], replay["data"]["cursor"]);
        let cli = owner_cli(
            &fixture,
            &[
                "decision",
                "decide",
                &question.decision,
                "--choice",
                CHOICE,
                "--note",
                NOTE,
                "--json",
            ],
        )
        .await?;
        assert_eq!(
            cli["data"], replay["data"],
            "CLI and MCP share the one recorded answer"
        );
        let other = call(
            &owner,
            "nesvo_decide",
            json!({"decisionId":question.decision,"choice":"Use main"}),
        )
        .await?;
        ensure!(
            other.is_error == Some(true),
            "A different answer must be refused: {other:?}"
        );
        assert_eq!(
            other.structured_content.context("Second answer refusal")?["error"]["code"],
            "decision_resolved"
        );

        assert_eq!(
            decision_view(&owner, &question).await?,
            answered,
            "No replay changed the decision"
        );
        assert_eq!(
            answered_events(&owner, &question.decision).await?,
            1,
            "One answer was journaled"
        );
        let mail = data(
            call(
                &owner,
                "nesvo_read_inbox",
                json!({"runId":question.run,"attemptId":question.attempt}),
            )
            .await?,
        )?;
        let notices: Vec<&Value> = mail["data"]["messages"]
            .as_array()
            .context("Worker mailbox")?
            .iter()
            .filter(|message| message["kind"] == "decision")
            .collect();
        assert_eq!(
            notices.len(),
            1,
            "The worker received one decision notice: {mail}"
        );
        assert_eq!(
            notices[0]["payload"]["decisionId"],
            question.decision.as_str()
        );
        assert_eq!(notices[0]["body"], answered["answer"]);
        let worker = data(
            call(
                &owner,
                "nesvo_get_session",
                json!({"sessionId":question.worker}),
            )
            .await?,
        )?;
        assert_eq!(worker["data"]["session"]["running"], true);
        let pending_after = data(call(&owner, "nesvo_list_pending_decisions", json!({})).await?)?;
        assert_eq!(pending_after["data"]["total"], 0);
        let inbox_after = data(call(&owner, "nesvo_list_attention_inbox", json!({})).await?)?;
        assert_eq!(
            inbox_after["data"]["total"], 0,
            "The answered decision left the needs-you inbox"
        );
        run_checkpoints::schema(vec![
            inbox,
            pending,
            replay,
            cli,
            pending_after,
            inbox_after,
            mail,
        ])
        .await?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    fixture_cleanup(&mut fixture, outcome).await
}

fn hex_ids(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    let mut found = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        if !hex(bytes[start]) {
            start += 1;
            continue;
        }
        let end = (start..bytes.len())
            .find(|&index| !hex(bytes[index]))
            .unwrap_or(bytes.len());
        if end - start == 32 {
            found.push(text[start..end].to_owned());
        }
        start = end;
    }
    found
}

fn collect(value: &Value, ids: &mut Vec<String>, anchor: &mut Option<u64>) {
    match value {
        Value::String(text) => {
            for id in hex_ids(text) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect(item, ids, anchor)),
        Value::Object(map) => {
            for (key, item) in map {
                if key == "createdAt"
                    && let Some(time) = item.as_u64()
                {
                    *anchor = Some(anchor.map_or(time, |earliest| earliest.min(time)));
                }
                collect(item, ids, anchor);
            }
        }
        _ => {}
    }
}

fn golden_time(key: &str, time: u64, anchor: u64) -> Result<u64> {
    if ANCHORED_TIMES.contains(&key) {
        return Ok(GOLDEN_TIME_BASE_MS
            + time
                .checked_sub(anchor)
                .with_context(|| format!("{key} precedes the earliest createdAt"))?);
    }
    OBSERVED_TIMES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, offset)| GOLDEN_TIME_BASE_MS + offset)
        .with_context(|| format!("Unknown timestamp field {key}; teach the golden normalizer"))
}

fn rewrite(value: &Value, ids: &BTreeMap<String, String>, anchor: u64) -> Result<Value> {
    Ok(match value {
        Value::String(text) => {
            Value::String(ids.iter().fold(text.clone(), |text, (id, placeholder)| {
                text.replace(id, placeholder)
            }))
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| rewrite(item, ids, anchor))
                .collect::<Result<_>>()?,
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let item = match item.as_u64() {
                        Some(_) if key == "cursor" => json!(GOLDEN_CURSOR),
                        Some(time) if time >= TIMESTAMP_FLOOR_MS => {
                            json!(golden_time(key, time, anchor)?)
                        }
                        _ => rewrite(item, ids, anchor)?,
                    };
                    Ok((key.clone(), item))
                })
                .collect::<Result<_>>()?,
        ),
        _ => value.clone(),
    })
}

fn normalized(replies: Value) -> Result<Value> {
    let mut ids = Vec::new();
    let mut anchor = None;
    collect(&replies, &mut ids, &mut anchor);
    let ids = ids
        .into_iter()
        .enumerate()
        .map(|(index, id)| (id, format!("{:032x}", index + 1)))
        .collect();
    rewrite(
        &replies,
        &ids,
        anchor.context("Replies carry no createdAt anchor")?,
    )
}

fn compare_or_update_golden(replies: &Value) -> Result<()> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(GOLDEN);
    let rendered = nesvo_wire::contract::render_json(replies);
    if std::env::var_os("NESVO_UPDATE_CONTRACTS").is_some_and(|value| value == "1") {
        std::fs::write(&path, rendered)?;
        return Ok(());
    }
    let current: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| {
            format!("{GOLDEN} is missing; regenerate it with NESVO_UPDATE_CONTRACTS=1")
        })?)?;
    ensure!(
        current == *replies,
        "{GOLDEN} drifted from the real host replies; regenerate it with NESVO_UPDATE_CONTRACTS=1 and review the diff:\n{rendered}"
    );
    Ok(())
}

#[test]
fn golden_normalization_keeps_order_and_replaces_every_identity() {
    let first = "a".repeat(32);
    let second = "b".repeat(32);
    let replies = json!({
        "item":{"id":format!("decision:{first}:{second}"),"at":1_900_000_000_500u64,"expiresAt":1_900_000_300_500u64,"cursor":7},
        "decision":{"id":second,"createdAt":1_900_000_000_500u64,"resolvedAt":1_900_000_000_900u64,"revision":2}
    });
    let golden = normalized(replies).unwrap();
    let one = format!("{:032x}", 1);
    let two = format!("{:032x}", 2);
    assert_eq!(golden["item"]["id"], format!("decision:{two}:{one}"));
    assert_eq!(golden["decision"]["id"], one);
    assert_eq!(golden["item"]["at"], GOLDEN_TIME_BASE_MS);
    assert_eq!(golden["decision"]["createdAt"], GOLDEN_TIME_BASE_MS);
    assert_eq!(
        golden["decision"]["resolvedAt"],
        GOLDEN_TIME_BASE_MS + OBSERVED_TIMES[1].1
    );
    assert_eq!(golden["item"]["expiresAt"], GOLDEN_TIME_BASE_MS + 300_000);
    assert_eq!(golden["item"]["cursor"], GOLDEN_CURSOR);
    assert_eq!(golden["decision"]["revision"], 2);
    let unknown = json!({"createdAt":1_900_000_000_500u64,"startedAt":1_900_000_000_600u64});
    assert!(normalized(unknown).is_err());
}

#[tokio::test]
#[ignore = "requires native binaries and Node; real inbox and decision replies are the client contract goldens (NESVO_UPDATE_CONTRACTS=1 rewrites them)"]
async fn real_inbox_and_decision_replies_match_the_client_contract_goldens() -> Result<()> {
    let mut fixture = Fixture::start_variant(true).await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let owner = client(&fixture.pairing()).await?;
        let question = pending_question(&fixture, &owner).await?;
        let inbox = data(call(&owner, "nesvo_list_attention_inbox", json!({})).await?)?;
        let decisions = data(call(&owner, "nesvo_list_pending_decisions", json!({})).await?)?;
        let item = &inbox["data"]["items"][0];
        let acknowledged = data(
            call(
                &owner,
                "nesvo_ack_attention_inbox",
                json!({"items":[{"id":item["id"],"revision":item["revision"]}]}),
            )
            .await?,
        )?;
        let decided = data(
            call(
                &owner,
                "nesvo_decide",
                json!({"decisionId":question.decision,"choice":CHOICE,"note":NOTE}),
            )
            .await?,
        )?;
        run_checkpoints::schema(vec![
            inbox.clone(),
            decisions.clone(),
            acknowledged.clone(),
            decided.clone(),
        ])
        .await?;
        let replies = normalized(json!({
            "attentionInbox":inbox["data"],
            "decisions":decisions["data"],
            "inboxAcknowledged":acknowledged["data"],
            "decided":decided["data"],
        }))?;
        compare_or_update_golden(&replies)?;
        owner.cancel().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    fixture_cleanup(&mut fixture, outcome).await
}
