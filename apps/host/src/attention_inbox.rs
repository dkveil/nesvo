use crate::{
    api_error::Error,
    event_log::{Event, Service},
    launchers::Program,
    orchestration::{Actor, Request as Workflow, Scope},
    protocol::Command,
    sessions::State,
    workflow_decisions, workflow_inbox,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::OwnedSemaphorePermit;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const DEFAULT_LIMIT: u16 = 16;
const MAX_LIMIT: u16 = 32;
const MAX_PAGE: u16 = 1024;
const MAX_MARKS: usize = 32;
const CANDIDATES: i64 = 256;
pub const PAGE_BYTES: usize = 60 * 1024;
const TITLE_BYTES: usize = 160;
const SUMMARY_BYTES: usize = 480;
const RECEIPT_RETENTION: i64 = 1024;
const RECEIPT_CAPACITY: i64 = 4096;
const JOURNAL_REVISION: u64 = 2;
const PUSHED_ITEMS: usize = 256;
const PREFIXES: [&str; 4] = ["session:", "decision:", "run:", "result:"];
pub const PUSH_DECISION: &str = "decisionPending";
pub const PUSH_RESULT: &str = "resultReady";
pub const PUSH_KINDS: [&str; 2] = [PUSH_DECISION, PUSH_RESULT];

#[derive(Clone)]
pub struct SessionItem {
    pub session_id: String,
    pub name: String,
    pub program: Program,
    pub priority: u8,
    pub reason: &'static str,
    pub revision: u64,
    pub at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mark {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Copy)]
pub struct Window {
    page: u16,
    limit: u16,
}
impl Window {
    pub fn new(page: Option<u16>, limit: Option<u16>) -> Result<Self> {
        let page = page.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        if page > MAX_PAGE || !(1..=MAX_LIMIT).contains(&limit) {
            return Err(invalid("Inbox page must be 0–1024 and limit 1–32"));
        }
        Ok(Self { page, limit })
    }
}

struct Item {
    id: String,
    revision: u64,
    priority: u8,
    at: u64,
    view: Value,
}

fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}

fn owner_only(actor: &Actor) -> Result<()> {
    if matches!(actor.scope, Scope::Owner) {
        Ok(())
    } else {
        Err(Error::new("forbidden", "Only the owner can read the attention inbox").into())
    }
}

pub(crate) fn clip(text: &str, max_encoded: usize) -> String {
    let mut out = String::new();
    let mut used = 2;
    for character in text.chars() {
        let cost = serde_json::to_string(&character.to_string()).map_or(6, |s| s.len() - 2);
        if used + cost > max_encoded {
            break;
        }
        used += cost;
        out.push(character);
    }
    out
}

fn item(id: String, revision: u64, priority: u8, at: u64, mut view: Value) -> Item {
    view["id"] = id.clone().into();
    view["revision"] = revision.into();
    view["priority"] = priority.into();
    view["at"] = at.into();
    Item {
        id,
        revision,
        priority,
        at,
        view,
    }
}

fn session_items(sessions: Vec<SessionItem>) -> Vec<Item> {
    sessions
        .into_iter()
        .map(|session| {
            item(
                format!("session:{}", session.session_id),
                session.revision,
                session.priority,
                session.at,
                json!({"kind":"session","reason":session.reason,"title":clip(&session.name,TITLE_BYTES),"sessionId":session.session_id,"program":session.program}),
            )
        })
        .collect()
}

fn decision_items(connection: &Connection) -> Result<Vec<Item>> {
    let mut statement = connection.prepare("SELECT d.id,d.run_id,d.revision,d.data,r.title FROM workflow_decisions d JOIN workflow_runs r ON r.id=d.run_id WHERE d.state='pending' ORDER BY d.sequence DESC LIMIT ?1")?;
    let rows = statement
        .query_map([CANDIDATES], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, run_id, revision, data, title)| {
            let data: Value = serde_json::from_str(&data)?;
            Ok(item(
                workflow_decisions::inbox_id(&run_id, &id),
                u64::try_from(revision)?,
                3,
                data["createdAt"].as_u64().unwrap_or(0),
                json!({"kind":"decision","reason":"decision","title":clip(&title,TITLE_BYTES),"summary":clip(data["question"].as_str().unwrap_or(""),SUMMARY_BYTES),"runId":run_id,"decisionId":id,"attemptId":data["attemptId"],"audience":data["audience"],"expiresAt":data["expiresAt"]}),
            ))
        })
        .collect()
}

fn run_items(connection: &Connection) -> Result<Vec<Item>> {
    let mut statement = connection.prepare("SELECT a.id,a.state,t.run_id,t.id,r.title,r.created_at FROM workflow_attempts a JOIN workflow_tasks t ON t.id=a.task_id JOIN workflow_runs r ON r.id=t.run_id WHERE a.state IN ('reported','launchUnknown') AND NOT EXISTS(SELECT 1 FROM harness_job_occurrences o WHERE o.run_id=t.run_id) ORDER BY a.rowid DESC LIMIT ?1")?;
    let rows = statement
        .query_map([CANDIDATES], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(attempt, state, run_id, task, title, created)| {
            let (revision, reason) = if state == "reported" {
                (2, "validation")
            } else {
                (1, "launchUnknown")
            };
            Ok(item(
                format!("run:{run_id}:{attempt}"),
                revision,
                2,
                u64::try_from(created)?,
                json!({"kind":"run","reason":reason,"title":clip(&title,TITLE_BYTES),"runId":run_id,"taskId":task,"attemptId":attempt}),
            ))
        })
        .collect()
}

fn result_items(connection: &Connection) -> Result<Vec<Item>> {
    let mut statement = connection.prepare("SELECT o.id,o.job_id,o.state,o.reason,o.run_id,COALESCE(o.finished_at,o.started_at,o.created_at),json_extract(j.spec,'$.title') FROM harness_job_occurrences o JOIN harness_jobs j ON j.id=o.job_id WHERE o.state IN ('needsValidation','succeeded','failed') ORDER BY 6 DESC,o.rowid DESC LIMIT ?1")?;
    let rows = statement
        .query_map([CANDIDATES], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(occurrence, job, state, reason, run, at, title)| {
            let (revision, priority) = match state.as_str() {
                "needsValidation" => (1, 2),
                "failed" => (2, 2),
                _ => (2, 1),
            };
            let mut view = json!({"kind":"result","reason":state,"title":clip(title.as_deref().unwrap_or(""),TITLE_BYTES),"jobId":job,"occurrenceId":occurrence,"runId":run});
            if let Some(reason) = reason {
                view["summary"] = clip(&reason, SUMMARY_BYTES).into();
            }
            Ok(item(
                format!("result:{occurrence}"),
                revision,
                priority,
                u64::try_from(at)?,
                view,
            ))
        })
        .collect()
}

fn candidates(connection: &Connection, sessions: Vec<SessionItem>) -> Result<Vec<Item>> {
    let mut items = session_items(sessions);
    items.extend(decision_items(connection)?);
    items.extend(run_items(connection)?);
    items.extend(result_items(connection)?);
    Ok(items)
}

pub fn recover(connection: &Connection) -> Result<()> {
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_receipts')",
        [],
        |r| r.get(0),
    )?;
    if present {
        connection.execute(
            "DELETE FROM attention_receipts WHERE item_id LIKE 'session:%'",
            [],
        )?;
    }
    Ok(())
}

fn receipts(connection: &Connection) -> Result<HashMap<String, u64>> {
    let mut statement = connection.prepare("SELECT item_id,revision FROM attention_receipts")?;
    let rows = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, revision)| Ok((id, u64::try_from(revision)?)))
        .collect()
}

pub fn read(
    connection: &mut Connection,
    actor: &Actor,
    window: Window,
    sessions: Vec<SessionItem>,
    now: u64,
) -> Result<Value> {
    owner_only(actor)?;
    workflow_decisions::expire_due(connection, now)?;
    let seen = receipts(connection)?;
    let mut items: Vec<Item> = candidates(connection, sessions)?
        .into_iter()
        .filter(|item| {
            seen.get(&item.id)
                .is_none_or(|revision| *revision < item.revision)
        })
        .collect();
    items.sort_by_key(|item| (Reverse(item.priority), Reverse(item.at), item.id.clone()));
    let total = items.len();
    let start = usize::from(window.page) * usize::from(window.limit);
    let page: Vec<Value> = items
        .into_iter()
        .skip(start)
        .take(usize::from(window.limit))
        .map(|item| item.view)
        .collect();
    let next = (start + page.len() < total).then_some(window.page + 1);
    let reply =
        json!({"items":page,"page":window.page,"limit":window.limit,"nextPage":next,"total":total});
    if serde_json::to_vec(&reply)?.len() > PAGE_BYTES {
        return Err(Error::new(
            "page_too_large",
            "Inbox page exceeds the frame budget; request a smaller limit",
        )
        .into());
    }
    Ok(reply)
}

fn session_mark(id: &str) -> bool {
    id.starts_with("session:")
}

fn validate(marks: &[Mark]) -> Result<()> {
    let distinct: HashSet<&str> = marks.iter().map(|mark| mark.id.as_str()).collect();
    if marks.is_empty() || marks.len() > MAX_MARKS || distinct.len() != marks.len() {
        return Err(invalid("Acknowledge 1–32 distinct inbox items"));
    }
    for mark in marks {
        if mark.id.len() > 200
            || mark.id.chars().any(char::is_control)
            || !PREFIXES
                .iter()
                .any(|prefix| mark.id.len() > prefix.len() && mark.id.starts_with(prefix))
            || mark.revision > MAX_SAFE
        {
            return Err(invalid(
                "Inbox item IDs come from attentionInbox with their revision",
            ));
        }
    }
    Ok(())
}

pub fn acknowledge(
    connection: &mut Connection,
    actor: &Actor,
    marks: Vec<Mark>,
    sessions: Vec<SessionItem>,
    now: u64,
) -> Result<Value> {
    owner_only(actor)?;
    validate(&marks)?;
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current: HashMap<String, u64> = candidates(&transaction, sessions)?
        .into_iter()
        .map(|item| (item.id, item.revision))
        .collect();
    if marks.iter().any(|mark| match current.get(&mark.id) {
        Some(revision) => mark.revision > *revision,
        None => !session_mark(&mark.id) && mark.revision > JOURNAL_REVISION,
    }) {
        return Err(invalid("Inbox item revision is ahead of the host"));
    }
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM attention_receipts", [], |r| r.get(0))?;
    if count >= RECEIPT_RETENTION {
        let keep: HashSet<&str> = current
            .keys()
            .map(String::as_str)
            .chain(marks.iter().map(|mark| mark.id.as_str()))
            .collect();
        let stale: Vec<String> = receipts(&transaction)?
            .into_keys()
            .filter(|id| !keep.contains(id.as_str()))
            .collect();
        for id in stale {
            transaction.execute("DELETE FROM attention_receipts WHERE item_id=?1", [id])?;
        }
        let count: i64 =
            transaction.query_row("SELECT count(*) FROM attention_receipts", [], |r| r.get(0))?;
        if count + marks.len() as i64 > RECEIPT_CAPACITY {
            return Err(Error::new("busy", "Inbox receipt capacity is exhausted").into());
        }
    }
    let mut acknowledged = Vec::new();
    for mark in &marks {
        if session_mark(&mark.id) && !current.contains_key(&mark.id) {
            let existing: Option<(i64, i64)> = transaction
                .query_row(
                    "SELECT revision,acknowledged_at FROM attention_receipts WHERE item_id=?1",
                    [&mark.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            acknowledged.push(match existing {
                Some((revision, at)) => {
                    json!({"id":mark.id,"revision":revision,"acknowledgedAt":at})
                }
                None => json!({"id":mark.id,"revision":mark.revision,"acknowledgedAt":now}),
            });
            continue;
        }
        transaction.execute("INSERT INTO attention_receipts(item_id,revision,acknowledged_at) VALUES(?1,?2,?3) ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,acknowledged_at=excluded.acknowledged_at WHERE excluded.revision>attention_receipts.revision",params![mark.id,mark.revision as i64,now as i64])?;
        let (revision, at): (i64, i64) = transaction.query_row(
            "SELECT revision,acknowledged_at FROM attention_receipts WHERE item_id=?1",
            [&mark.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        acknowledged.push(json!({"id":mark.id,"revision":revision,"acknowledgedAt":at}));
    }
    transaction.commit()?;
    Ok(json!({ "acknowledged": acknowledged }))
}

pub fn handles(command: &Command) -> bool {
    matches!(
        command,
        Command::AttentionInbox { .. }
            | Command::AcknowledgeInbox { .. }
            | Command::Decisions { .. }
            | Command::Decide { .. }
    )
}

fn journal_request(command: Command, sessions: Vec<SessionItem>) -> (Workflow, &'static str) {
    match command {
        Command::AttentionInbox { page, limit } => (
            Workflow::Inbox {
                request: workflow_inbox::Request::Attention {
                    page,
                    limit,
                    sessions,
                },
            },
            "attentionInbox",
        ),
        Command::AcknowledgeInbox { items } => (
            Workflow::Inbox {
                request: workflow_inbox::Request::AcknowledgeAttention { items, sessions },
            },
            "inboxAcknowledged",
        ),
        Command::Decisions { page } => (
            Workflow::Decision {
                request: workflow_decisions::Request::Pending { page },
            },
            "decisions",
        ),
        Command::Decide {
            decision_id,
            choice,
            note,
        } => (
            Workflow::Decision {
                request: workflow_decisions::Request::Decide {
                    decision_id,
                    choice,
                    note,
                },
            },
            "decided",
        ),
        _ => unreachable!(),
    }
}

async fn respond(
    state: &Arc<Mutex<State>>,
    client: u64,
    command: Command,
    permit: Option<OwnedSemaphorePermit>,
) -> Result<Value> {
    let _permit = permit.ok_or_else(|| Error::new("busy", "Attention service is busy"))?;
    let watches = matches!(
        command,
        Command::AttentionInbox { .. } | Command::Decisions { .. }
    );
    let (log, actor, request, kind) = {
        let mut state = state
            .lock()
            .map_err(|_| Error::new("busy", "Host state is unavailable"))?;
        let log = state.event_log()?;
        let (mut request, kind) = journal_request(command, state.attention_sessions());
        let actor = state.workflow_actor(client, &mut request)?;
        owner_only(&actor)?;
        if watches {
            state.watch_attention(client);
        }
        (log, actor, request, kind)
    };
    let mut data = log.workflow(actor, request).await?;
    if let Ok(mut state) = state.lock() {
        match kind {
            "inboxAcknowledged" => {
                for receipt in data["acknowledged"].as_array().into_iter().flatten() {
                    if let (Some(session), Some(revision)) = (
                        receipt["id"]
                            .as_str()
                            .and_then(|id| id.strip_prefix("session:")),
                        receipt["revision"].as_u64(),
                    ) {
                        state.acknowledge_session_attention(session, revision);
                    }
                }
                state.notify_attention("acknowledged", None);
            }
            "decided" => {
                state.notify_attention("decision", data["inboxId"].as_str());
            }
            _ => {}
        }
    }
    data["type"] = kind.into();
    Ok(data)
}

pub async fn serve(
    state: Arc<Mutex<State>>,
    client: u64,
    command: Command,
    request_id: Option<String>,
    permit: Option<OwnedSemaphorePermit>,
) {
    let mut event = match respond(&state, client, command, permit).await {
        Ok(event) => event,
        Err(error) => json!({
            "type":"error",
            "code":error.downcast_ref::<Error>().map_or("attention_unavailable", |e| e.code),
            "message":error.to_string(),
        }),
    };
    if let Some(request_id) = request_id {
        event["requestId"] = request_id.into();
    }
    if let Ok(state) = state.lock() {
        state.send(client, event);
    }
}

pub(crate) struct Signal {
    pub reason: &'static str,
    pub item: Option<String>,
    pub push: Option<&'static str>,
}

pub(crate) fn signal(event: &Event) -> Option<Signal> {
    let payload = &event.payload;
    let decision = || {
        Some(workflow_decisions::inbox_id(
            payload["runId"].as_str()?,
            payload["decisionId"].as_str()?,
        ))
    };
    match event.kind.as_str() {
        "run.decision_asked" => Some(Signal {
            reason: "decision",
            item: decision(),
            push: Some(PUSH_DECISION),
        }),
        "run.decision_answered" | "run.decision_canceled" => Some(Signal {
            reason: "decision",
            item: decision(),
            push: None,
        }),
        "run.decisions_expired" => Some(Signal {
            reason: "decision",
            item: None,
            push: None,
        }),
        "run.result_reported" | "run.result_validated" | "run.launch_observed" => Some(Signal {
            reason: "run",
            item: None,
            push: None,
        }),
        "job.changed"
            if matches!(
                payload["phase"].as_str(),
                Some("needsValidation" | "succeeded" | "failed")
            ) =>
        {
            Some(Signal {
                reason: "result",
                item: payload["occurrenceId"]
                    .as_str()
                    .map(|id| format!("result:{id}")),
                push: Some(PUSH_RESULT),
            })
        }
        _ => None,
    }
}

#[derive(Default)]
pub(crate) struct Pushed {
    order: VecDeque<String>,
    items: HashSet<String>,
}

impl Pushed {
    pub(crate) fn admit(&mut self, mut signal: Signal) -> Signal {
        if signal.push == Some(PUSH_RESULT)
            && let Some(item) = &signal.item
        {
            if self.items.contains(item) {
                signal.push = None;
            } else {
                self.items.insert(item.clone());
                self.order.push_back(item.clone());
                if self.order.len() > PUSHED_ITEMS
                    && let Some(oldest) = self.order.pop_front()
                {
                    self.items.remove(&oldest);
                }
            }
        }
        signal
    }
}

pub async fn watch(state: Arc<Mutex<State>>, log: Service) {
    let mut changed = log.subscribe();
    let mut cursor = *changed.borrow_and_update();
    let mut pushed = Pushed::default();
    while changed.changed().await.is_ok() {
        loop {
            let Ok(page) = log.read(cursor, 32, None).await else {
                break;
            };
            cursor = page.next_cursor;
            let signals: Vec<Signal> = page
                .events
                .iter()
                .filter_map(signal)
                .map(|signal| pushed.admit(signal))
                .collect();
            if !signals.is_empty()
                && let Ok(mut state) = state.lock()
            {
                for signal in signals {
                    state.attention_signal(signal);
                }
            }
            if !page.more {
                break;
            }
        }
    }
}
