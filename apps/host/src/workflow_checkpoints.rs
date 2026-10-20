//! Immutable checkpoints and current context reads never restore native effects.
use crate::{
    api_error::Error,
    event_log::{Observation, append_transaction},
    orchestration::{self, Actor},
    workflow_checkpoint_parts as parts,
};
use anyhow::{Result, anyhow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
type MetadataRow = (i64, String, i64, i64, i64, String, Option<String>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Save {
        key: String,
        run_id: String,
        expected_revision: u64,
        summary: Option<String>,
    },
    List {
        run_id: String,
        offset: Option<u16>,
    },
    Get {
        run_id: String,
        checkpoint_id: String,
        offset: Option<u16>,
    },
    Context {
        run_id: String,
        checkpoint_id: Option<String>,
        offset: Option<u16>,
        expected_digest: Option<String>,
    },
}
pub fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS workflow_checkpoints(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(id),ordinal INTEGER NOT NULL,issuer TEXT NOT NULL,created_at INTEGER NOT NULL,source_revision INTEGER NOT NULL,source_cursor INTEGER NOT NULL,digest TEXT NOT NULL,summary TEXT,part_count INTEGER NOT NULL,UNIQUE(run_id,ordinal));
      CREATE TABLE IF NOT EXISTS workflow_checkpoint_parts(checkpoint_id TEXT NOT NULL REFERENCES workflow_checkpoints(id),ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(checkpoint_id,ordinal));")?;
    Ok(())
}
fn metadata(connection: &Connection, run: &str, id: &str) -> Result<Value> {
    let row:Option<MetadataRow>=connection.query_row("SELECT ordinal,issuer,created_at,source_revision,source_cursor,digest,summary FROM workflow_checkpoints WHERE id=?1 AND run_id=?2",params![id,run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    let (ordinal, issuer, at, revision, cursor, digest, summary) = row.ok_or_else(|| {
        Error::new(
            "checkpoint_not_found",
            "Checkpoint is unavailable in this run",
        )
    })?;
    Ok(
        json!({"id":id,"ordinal":ordinal,"issuer":issuer,"createdAt":at,"sourceRunRevision":revision,"sourceCursor":cursor,"digest":digest,"summary":summary}),
    )
}
fn current_cursor(connection: &Connection) -> Result<i64> {
    Ok(
        connection.query_row("SELECT head FROM domain_event_cursor WHERE id=1", [], |r| {
            r.get(0)
        })?,
    )
}
fn stored_page(
    connection: &Connection,
    id: &str,
    offset: usize,
) -> Result<(Vec<Value>, Option<usize>, usize)> {
    let total: i64 = connection.query_row(
        "SELECT part_count FROM workflow_checkpoints WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let total = usize::try_from(total)?;
    if offset > total {
        return Err(Error::new(
            "invalid_cursor",
            "Context offset is ahead of this checkpoint",
        )
        .into());
    }
    let mut query=connection.prepare("SELECT data FROM workflow_checkpoint_parts WHERE checkpoint_id=?1 AND ordinal>=?2 ORDER BY ordinal LIMIT 8")?;
    let rows = query.query_map(params![id, offset as i64], |r| r.get::<_, String>(0))?;
    let records = rows
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    let (page, _) = parts::page(&records, 0)?;
    let end = offset + page.len();
    if end < total && page.is_empty() {
        return Err(anyhow!("Stored checkpoint is missing part records"));
    }
    Ok((page, (end < total).then_some(end), total))
}
fn read(
    connection: &Connection,
    actor: &Actor,
    run: &str,
    id: Option<&str>,
    offset: usize,
    current: bool,
    expected: Option<&str>,
) -> Result<Value> {
    let run_view = orchestration::run(connection, actor, run)?;
    let checkpoint = id.map(|id| metadata(connection, run, id)).transpose()?;
    let manifest = current
        .then(|| parts::build(connection, actor, run))
        .transpose()?;
    let digest = if let Some(parts) = &manifest {
        parts::digest(parts)?
    } else {
        checkpoint
            .as_ref()
            .and_then(|c| c["digest"].as_str())
            .ok_or_else(|| anyhow!("Missing checkpoint digest"))?
            .to_owned()
    };
    if current
        && ((offset > 0 && expected.is_none())
            || expected.is_some_and(|expected| expected != digest))
    {
        return Err(Error::new(
            "context_changed",
            "Current context changed or its digest was omitted; restart pagination from zero",
        )
        .into());
    }
    let (page, next, total) = if let Some(manifest) = &manifest {
        let (page, next) = parts::page(manifest, offset)?;
        (page, next, manifest.len())
    } else {
        stored_page(
            connection,
            id.ok_or_else(|| anyhow!("Missing checkpoint identity"))?,
            offset,
        )?
    };
    let source_revision = if current {
        run_view["revision"].clone()
    } else {
        checkpoint
            .as_ref()
            .ok_or_else(|| anyhow!("Missing checkpoint metadata"))?["sourceRunRevision"]
            .clone()
    };
    let source_cursor = if current {
        json!(current_cursor(connection)?)
    } else {
        checkpoint
            .as_ref()
            .ok_or_else(|| anyhow!("Missing checkpoint metadata"))?["sourceCursor"]
            .clone()
    };
    let differs = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint["digest"] != digest);
    Ok(
        json!({"run":run_view,"checkpoint":checkpoint,"context":{"schemaVersion":1,"kind":if current {"current"}else{"historical"},"sourceRunRevision":source_revision,"sourceCursor":source_cursor,"digest":digest,"partCount":total,"baselineDiffers":differs,"nativeEffectsRestored":false},"parts":page,"nextOffset":next,"currentConstraints":crate::workflow_context::summary(connection,run)?}),
    )
}
pub fn execute(
    connection: &mut Connection,
    actor: Actor,
    request: Request,
    now: u64,
) -> Result<Value> {
    match &request {
        Request::Get {
            run_id,
            checkpoint_id,
            offset,
        } => {
            return read(
                connection,
                &actor,
                run_id,
                Some(checkpoint_id),
                offset.unwrap_or(0) as usize,
                false,
                None,
            );
        }
        Request::Context {
            run_id,
            checkpoint_id,
            offset,
            expected_digest,
        } => {
            return read(
                connection,
                &actor,
                run_id,
                checkpoint_id.as_deref(),
                offset.unwrap_or(0) as usize,
                true,
                expected_digest.as_deref(),
            );
        }
        Request::List { run_id, offset } => {
            let run = orchestration::run(connection, &actor, run_id)?;
            let offset = offset.unwrap_or(0);
            if offset > 32 {
                return Err(Error::new(
                    "invalid_cursor",
                    "Checkpoint offset exceeds per-run retention",
                )
                .into());
            }
            let ids = {
                let mut query=connection.prepare("SELECT id FROM workflow_checkpoints WHERE run_id=?1 ORDER BY ordinal DESC LIMIT 9 OFFSET ?2")?;
                query
                    .query_map(params![run_id, offset], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let more = ids.len() > 8;
            let checkpoints = ids
                .iter()
                .take(8)
                .map(|id| metadata(connection, run_id, id))
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"run":run,"checkpoints":checkpoints,"nextOffset":more.then_some(offset+8)}),
            );
        }
        _ => {}
    }
    let Request::Save {
        key,
        run_id,
        expected_revision,
        summary,
    } = request
    else {
        return Err(anyhow!("Unexpected checkpoint mutation"));
    };
    orchestration::run(connection, &actor, &run_id)?;
    orchestration::validate_key(&key)?;
    if summary.as_ref().is_some_and(|text| {
        text.trim().is_empty()
            || text.len() > 2048
            || text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }) {
        return Err(Error::new(
            "invalid_argument",
            "Checkpoint note must be literal nonempty UTF-8 within 2048 bytes",
        )
        .into());
    }
    let fingerprint=hex::encode(ring::digest::digest(&ring::digest::SHA256,&serde_json::to_vec(&json!({"action":"checkpoints","request":{"action":"save","key":key,"runId":run_id,"expectedRevision":expected_revision,"summary":summary}}))?).as_ref());
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let run = orchestration::run(&transaction, &actor, &run_id)?;
    if let Some(result) = orchestration::replay(&transaction, &actor, &key, &fingerprint)? {
        return Ok(result);
    }
    orchestration::mutation_capacity(&transaction)?;
    if run["revision"] != expected_revision {
        return Err(Error::new(
            "revision_conflict",
            "Run changed; re-read before capturing its checkpoint",
        )
        .into());
    }
    let global: i64 =
        transaction.query_row("SELECT count(*) FROM workflow_checkpoints", [], |r| {
            r.get(0)
        })?;
    let count: i64 = transaction.query_row(
        "SELECT count(*) FROM workflow_checkpoints WHERE run_id=?1",
        [&run_id],
        |r| r.get(0),
    )?;
    if global >= 256 || count >= 32 {
        return Err(Error::new(
            "busy",
            "Checkpoint retention is full; no snapshot or user context was discarded",
        )
        .into());
    }
    let manifest = parts::build(&transaction, &actor, &run_id)?;
    let digest = parts::digest(&manifest)?;
    let id = hex::encode(crate::wire::random::<16>());
    let source_cursor = current_cursor(&transaction)?;
    transaction.execute("INSERT INTO workflow_checkpoints(id,run_id,ordinal,issuer,created_at,source_revision,source_cursor,digest,summary,part_count) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,run_id,count+1,actor.issuer,now as i64,expected_revision as i64,source_cursor,digest,summary,manifest.len() as i64])?;
    for (ordinal, part) in manifest.iter().enumerate() {
        transaction.execute(
            "INSERT INTO workflow_checkpoint_parts(checkpoint_id,ordinal,data) VALUES(?1,?2,?3)",
            params![id, ordinal as i64, serde_json::to_string(part)?],
        )?;
    }
    let cursor = append_transaction(
        &transaction,
        vec![Observation {
            session_id: run["coordinatorSessionId"].as_str().map(str::to_owned),
            kind: "run.checkpoint_saved",
            at: now,
            payload: json!({"runId":run_id,"checkpointId":id,"sourceRunRevision":expected_revision}),
        }],
    )?;
    // Capturing history does not alter the plan/run revision or refresh native
    // grants. The immutable source revision remains useful for comparison.
    let mut result = read(&transaction, &actor, &run_id, Some(&id), 0, false, None)?;
    result["cursor"] = cursor.into();
    orchestration::remember(&transaction, &actor, &key, &fingerprint, &result)?;
    transaction.commit()?;
    Ok(result)
}
