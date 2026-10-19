//! Durable workflow plans. DAG readiness is independent from process/task success.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    status::now_millis,
};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
pub struct Actor {
    pub issuer: String,
    pub coordinator: Option<String>, // None is an already authenticated human owner.
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSpec {
    pub title: String,
    pub goal: String,
    pub coordinator_session_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpec {
    pub key: String,
    pub title: String,
    pub instruction: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Create {
        key: String,
        spec: RunSpec,
    },
    List {
        offset: Option<usize>,
    },
    Get {
        run_id: String,
    },
    Mutation {
        key: String,
    },
    SetPlan {
        key: String,
        run_id: String,
        expected_revision: u64,
        tasks: Vec<TaskSpec>,
    },
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,coordinator_id TEXT,revision INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_runs_coordinator ON workflow_runs(coordinator_id,created_at);
      CREATE TABLE IF NOT EXISTS workflow_tasks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(id),task_key TEXT NOT NULL,spec TEXT NOT NULL,UNIQUE(run_id,task_key));
      CREATE TABLE IF NOT EXISTS workflow_mutations(issuer TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,view TEXT NOT NULL,PRIMARY KEY(issuer,key));")?;
    Ok(())
}
fn invalid(message: &'static str) -> anyhow::Error {
    Error::new("invalid_argument", message).into()
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
pub fn validate_plan(tasks: &[TaskSpec]) -> Result<()> {
    if tasks.len() > 64 || serde_json::to_vec(tasks)?.len() > 24 * 1024 {
        return Err(invalid("Plan exceeds 64 tasks or 24 KiB"));
    }
    let mut indices = HashMap::new();
    for (index, task) in tasks.iter().enumerate() {
        if task.key.is_empty()
            || task.key.len() > 64
            || !task
                .key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || indices.insert(task.key.as_str(), index).is_some()
            || !text(&task.title, 80)
            || task.title.chars().any(char::is_control)
            || !text(&task.instruction, 8192)
            || task.dependencies.len() > 64
        {
            return Err(invalid(
                "Tasks require unique stable keys, bounded titles/instructions and dependencies",
            ));
        }
    }
    let mut edges = 0;
    for task in tasks {
        let mut seen = HashSet::new();
        for dependency in &task.dependencies {
            if dependency == &task.key
                || !indices.contains_key(dependency.as_str())
                || !seen.insert(dependency)
            {
                return Err(invalid(
                    "Dependency is missing, duplicated or self-referential",
                ));
            }
            edges += 1;
        }
    }
    if edges > 256 {
        return Err(invalid("Plan exceeds 256 dependency edges"));
    }
    fn visit(
        index: usize,
        tasks: &[TaskSpec],
        indices: &HashMap<&str, usize>,
        marks: &mut [u8],
    ) -> bool {
        if marks[index] == 1 {
            return false;
        }
        if marks[index] == 2 {
            return true;
        }
        marks[index] = 1;
        for key in &tasks[index].dependencies {
            if !visit(indices[key.as_str()], tasks, indices, marks) {
                return false;
            }
        }
        marks[index] = 2;
        true
    }
    let mut marks = vec![0; tasks.len()];
    if (0..tasks.len()).any(|index| !visit(index, tasks, &indices, &mut marks)) {
        return Err(invalid("Task dependencies contain a cycle"));
    }
    Ok(())
}
fn run(connection: &Connection, actor: &Actor, id: &str) -> Result<Value> {
    type Record = (String, String, String, Option<String>, i64, String, i64);
    let row:Option<Record>=connection.query_row("SELECT id,title,goal,coordinator_id,revision,state,created_at FROM workflow_runs WHERE id=?1 AND (?2 IS NULL OR coordinator_id=?2)",params![id,actor.coordinator],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    let Some((id, title, goal, coordinator, revision, state, created_at)) = row else {
        return Err(Error::new("run_not_found", "Run is unavailable to this caller").into());
    };
    ensure!(
        revision >= 1 && created_at >= 0,
        "Invalid stored workflow metadata"
    );
    Ok(
        json!({"id":id,"title":title,"goal":goal,"coordinatorSessionId":coordinator,"revision":revision,"state":state,"createdAt":created_at,"taskResult":null}),
    )
}
fn view(connection: &Connection, actor: &Actor, id: &str) -> Result<Value> {
    let run = run(connection, actor, id)?;
    let mut statement =
        connection.prepare("SELECT id,spec FROM workflow_tasks WHERE run_id=?1 ORDER BY rowid")?;
    let tasks = statement
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .map(|row| -> Result<_> {
            let (id, source) = row?;
            Ok((id, serde_json::from_str::<TaskSpec>(&source)?))
        })
        .collect::<Result<Vec<_>>>()?;
    let ids: HashMap<_, _> = tasks
        .iter()
        .map(|(id, spec)| (spec.key.as_str(), id))
        .collect();
    let records:Vec<_>=tasks.iter().map(|(id,spec)|json!({"id":id,"key":spec.key,"title":spec.title,"instruction":spec.instruction,"dependencies":spec.dependencies.iter().filter_map(|key|ids.get(key.as_str())).collect::<Vec<_>>(),"state":"planned","dependencyState":if spec.dependencies.is_empty(){"ready"}else{"waiting"},"attempts":0,"taskResult":null})).collect();
    let result = json!({"run":run,"tasks":records});
    if serde_json::to_vec(&result)?.len() > 40 * 1024 {
        return Err(invalid("Workflow view exceeds 40 KiB; reduce the plan"));
    }
    Ok(result)
}
fn random_id() -> String {
    hex::encode(crate::wire::random::<16>())
}
pub fn execute(connection: &mut Connection, actor: Actor, request: Request) -> Result<Value> {
    if let Request::Mutation { key } = &request {
        let result: Option<String> = connection
            .query_row(
                "SELECT view FROM workflow_mutations WHERE issuer=?1 AND key=?2",
                params![actor.issuer, key],
                |r| r.get(0),
            )
            .optional()?;
        let Some(result) = result else {
            return Err(Error::new(
                "mutation_not_found",
                "Workflow mutation is unavailable to this caller",
            )
            .into());
        };
        let result: Value = serde_json::from_str(&result)?;
        run(
            connection,
            &actor,
            result["run"]["id"]
                .as_str()
                .ok_or_else(|| invalid("Stored workflow mutation has no run identity"))?,
        )?;
        return Ok(result);
    }
    if let Request::Get { run_id } = &request {
        return view(connection, &actor, run_id);
    }
    if let Request::List { offset } = &request {
        let offset = offset.unwrap_or(0);
        if offset > 1024 {
            return Err(invalid("Run offset exceeds 1024"));
        }
        let mut statement=connection.prepare("SELECT id,title,coordinator_id,revision,state,created_at FROM workflow_runs WHERE (?1 IS NULL OR coordinator_id=?1) ORDER BY created_at DESC,id LIMIT 17 OFFSET ?2")?;
        let mut runs=statement.query_map(params![actor.coordinator,offset as i64],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"coordinatorSessionId":r.get::<_,Option<String>>(2)?,"revision":r.get::<_,i64>(3)?,"state":r.get::<_,String>(4)?,"createdAt":r.get::<_,i64>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let more = runs.len() > 16;
        runs.truncate(16);
        return Ok(json!({"runs":runs,"nextOffset":more.then_some(offset+16)}));
    }
    let key = match &request {
        Request::Create { key, .. } | Request::SetPlan { key, .. } => key,
        _ => unreachable!(),
    };
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
        return Err(invalid(
            "Mutation key must be 1–128 bytes without control characters",
        ));
    }
    let digest = hex::encode(
        ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&request)?).as_ref(),
    );
    let transaction = connection.transaction()?;
    // Recheck the run boundary even when recovering a historical mutation.
    if let Request::SetPlan { run_id, .. } = &request {
        run(&transaction, &actor, run_id)?;
    }
    let previous: Option<(String, String)> = transaction
        .query_row(
            "SELECT digest,view FROM workflow_mutations WHERE issuer=?1 AND key=?2",
            params![actor.issuer, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((old, result)) = previous {
        if old != digest {
            return Err(Error::new(
                "idempotency_conflict",
                "Mutation key already identifies another workflow request",
            )
            .into());
        }
        let result: Value = serde_json::from_str(&result)?;
        run(
            &transaction,
            &actor,
            result["run"]["id"]
                .as_str()
                .ok_or_else(|| invalid("Stored mutation has no run identity"))?,
        )?;
        return Ok(result);
    }
    let count: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_mutations", [], |r| r.get(0))?;
    if count >= 4096 {
        return Err(Error::new(
            "busy",
            "Workflow mutation retention capacity exhausted; existing keys remain recoverable",
        )
        .into());
    }
    let (id, kind) = match &request {
        Request::Create { spec, .. } => {
            if !text(&spec.title, 80)
                || spec.title.chars().any(char::is_control)
                || !text(&spec.goal, 8192)
                || actor
                    .coordinator
                    .as_ref()
                    .is_some_and(|id| spec.coordinator_session_id.as_ref() != Some(id))
            {
                return Err(invalid(
                    "Run needs bounded title/goal and its authenticated coordinator",
                ));
            }
            let count: i64 =
                transaction.query_row("SELECT count(*) FROM workflow_runs", [], |r| r.get(0))?;
            if count >= 1024 {
                return Err(Error::new(
                    "busy",
                    "Workflow storage capacity exhausted; retain/export existing history",
                )
                .into());
            }
            let id = random_id();
            transaction.execute("INSERT INTO workflow_runs(id,title,goal,coordinator_id,revision,state,created_at) VALUES(?1,?2,?3,?4,1,'draft',?5)",params![id,spec.title,spec.goal,spec.coordinator_session_id,now_millis() as i64])?;
            (id, "run.created")
        }
        Request::SetPlan {
            run_id,
            expected_revision,
            tasks,
            ..
        } => {
            validate_plan(tasks)?;
            let current = run(&transaction, &actor, run_id)?;
            if current["revision"].as_u64() != Some(*expected_revision) {
                return Err(Error::new(
                    "revision_conflict",
                    "Run changed; inspect its current revision before editing the plan",
                )
                .into());
            }
            if current["state"] != "draft" {
                return Err(
                    Error::new("run_state_conflict", "Only a draft plan can be replaced").into(),
                );
            }
            let mut statement =
                transaction.prepare("SELECT task_key,id FROM workflow_tasks WHERE run_id=?1")?;
            let existing = statement
                .query_map([run_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            drop(statement);
            transaction.execute("DELETE FROM workflow_tasks WHERE run_id=?1", [run_id])?;
            for task in tasks {
                let id = existing.get(&task.key).cloned().unwrap_or_else(random_id);
                transaction.execute(
                    "INSERT INTO workflow_tasks(id,run_id,task_key,spec) VALUES(?1,?2,?3,?4)",
                    params![id, run_id, task.key, serde_json::to_string(task)?],
                )?;
            }
            transaction.execute(
                "UPDATE workflow_runs SET revision=revision+1 WHERE id=?1",
                [run_id],
            )?;
            (run_id.clone(), "run.plan_changed")
        }
        _ => unreachable!(),
    };
    let result = view(&transaction, &actor, &id)?;
    let subject = result["run"]["coordinatorSessionId"]
        .as_str()
        .map(str::to_owned);
    let cursor = append_transaction(
        &transaction,
        vec![Observation {
            session_id: subject,
            kind,
            at: now_millis(),
            payload: json!({"runId":id,"revision":result["run"]["revision"]}),
        }],
    )?;
    let mut result = result;
    result["cursor"] = cursor.into();
    transaction.execute(
        "INSERT INTO workflow_mutations(issuer,key,digest,view) VALUES(?1,?2,?3,?4)",
        params![actor.issuer, key, digest, serde_json::to_string(&result)?],
    )?;
    transaction.commit()?;
    Ok(result)
}
