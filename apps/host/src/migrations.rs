use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, params};

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "workflow_launch_profile",
        sql: include_str!("../migrations/0002_workflow_launch_profile.sql"),
    },
    Migration {
        version: 3,
        name: "workflow_launch_preparation",
        sql: include_str!("../migrations/0003_workflow_launch_preparation.sql"),
    },
    Migration {
        version: 4,
        name: "job_calendar_error",
        sql: include_str!("../migrations/0004_job_calendar_error.sql"),
    },
    Migration {
        version: 5,
        name: "job_occurrence_coalescing",
        sql: include_str!("../migrations/0005_job_occurrence_coalescing.sql"),
    },
    Migration {
        version: 6,
        name: "job_cancellation_precheck_attempt",
        sql: include_str!("../migrations/0006_job_cancellation_precheck_attempt.sql"),
    },
    Migration {
        version: 7,
        name: "job_occurrence_current_attempt",
        sql: include_str!("../migrations/0007_job_occurrence_current_attempt.sql"),
    },
    Migration {
        version: 8,
        name: "attention_receipts",
        sql: include_str!("../migrations/0008_attention_receipts.sql"),
    },
    Migration {
        version: 9,
        name: "projects",
        sql: include_str!("../migrations/0009_projects.sql"),
    },
    Migration {
        version: 10,
        name: "workflow_session_reuse",
        sql: include_str!("../migrations/0010_workflow_session_reuse.sql"),
    },
    Migration {
        version: 11,
        name: "workflow_digests",
        sql: include_str!("../migrations/0011_workflow_digests.sql"),
    },
    Migration {
        version: 12,
        name: "job_retry_classes",
        sql: include_str!("../migrations/0012_job_retry_classes.sql"),
    },
    Migration {
        version: 13,
        name: "wake_delivery",
        sql: include_str!("../migrations/0013_wake_delivery.sql"),
    },
    Migration {
        version: 14,
        name: "session_hibernation",
        sql: include_str!("../migrations/0014_session_hibernation.sql"),
    },
];

const LEGACY_SCHEMA_VERSION: u32 = 7;

const LEDGER: &str = "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at_ms INTEGER NOT NULL);";

pub fn apply_pending(connection: &Connection) -> Result<Vec<u32>> {
    apply_through(connection, latest_version())
}

fn apply_through(connection: &Connection, target: u32) -> Result<Vec<u32>> {
    ensure!(
        !connection.is_autocommit(),
        "Schema migrations must run inside the caller's immediate transaction"
    );
    let adopting = !has_ledger(connection)? && predates_ledger(connection)?;
    connection.execute_batch(LEDGER)?;
    let applied_at = i64::try_from(crate::status::now_millis())?;
    if adopting {
        crate::orchestration::initialize(connection)
            .context("Could not bring the pre-migration journal schema to its last legacy shape")?;
        for migration in MIGRATIONS
            .iter()
            .filter(|migration| migration.version <= LEGACY_SCHEMA_VERSION)
        {
            record(connection, migration, applied_at)?;
        }
    }
    let recorded = recorded(connection)?;
    verify(&recorded)?;
    let mut applied = Vec::new();
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version <= target)
    {
        if recorded
            .iter()
            .any(|(version, _)| *version == i64::from(migration.version))
        {
            continue;
        }
        connection
            .execute_batch(migration.sql)
            .with_context(|| format!("Schema migration {} failed", file_name(migration)))?;
        record(connection, migration, applied_at)?;
        applied.push(migration.version);
    }
    Ok(applied)
}

fn latest_version() -> u32 {
    MIGRATIONS.last().map_or(0, |migration| migration.version)
}

fn file_name(migration: &Migration) -> String {
    format!("{:04}_{}.sql", migration.version, migration.name)
}

fn has_ledger(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations')",
        [],
        |row| row.get(0),
    )?)
}

fn baseline_tables() -> Vec<&'static str> {
    MIGRATIONS[0]
        .sql
        .split("CREATE TABLE IF NOT EXISTS ")
        .skip(1)
        .filter_map(|statement| {
            statement
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .next()
        })
        .collect()
}

fn predates_ledger(connection: &Connection) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name IN (SELECT value FROM json_each(?1)))",
        [serde_json::to_string(&baseline_tables())?],
        |row| row.get(0),
    )?)
}

fn record(connection: &Connection, migration: &Migration, applied_at: i64) -> Result<()> {
    connection.execute(
        "INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?1,?2,?3)",
        params![migration.version, migration.name, applied_at],
    )?;
    Ok(())
}

fn recorded(connection: &Connection) -> Result<Vec<(i64, String)>> {
    let mut statement =
        connection.prepare("SELECT version,name FROM schema_migrations ORDER BY version")?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn verify(recorded: &[(i64, String)]) -> Result<()> {
    let latest = latest_version();
    for (version, name) in recorded {
        if *version > i64::from(latest) {
            bail!(
                "Database schema version {version} is newer than this nesvo-host supports (latest {latest}); run a newer nesvo-host"
            );
        }
        match MIGRATIONS
            .iter()
            .find(|migration| i64::from(migration.version) == *version)
        {
            Some(migration) if migration.name == name => {}
            Some(migration) => bail!(
                "Database schema migration {version} is recorded as `{name}`, but this nesvo-host defines `{}`",
                migration.name
            ),
            None => bail!("Database records unknown schema migration {version} `{name}`"),
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn schema_snapshot(connection: &Connection) -> Vec<(String, String, Option<String>)> {
    let mut statement = connection
        .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, Option<String>>(2)?.map(|sql| normalize(&sql)),
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[cfg(test)]
fn normalize(sql: &str) -> String {
    let collapsed = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut normalized = String::with_capacity(collapsed.len());
    let mut characters = collapsed.chars().peekable();
    while let Some(character) = characters.next() {
        if character == ' '
            && (normalized.ends_with(['(', ')', ','])
                || characters.peek().is_some_and(|next| "(),".contains(*next)))
        {
            continue;
        }
        normalized.push(character);
    }
    normalized
}

#[cfg(test)]
fn migrate(connection: &mut Connection, target: u32) -> Result<Vec<u32>> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let applied = apply_through(&transaction, target)?;
    transaction.commit()?;
    Ok(applied)
}

#[cfg(test)]
fn booted(mut connection: Connection) -> Connection {
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    crate::receipts::initialize(&mut connection).unwrap();
    crate::quota_wakes::initialize(&connection).unwrap();
    connection
}

#[cfg(test)]
fn migrated_through(mut connection: Connection, version: u32) -> Connection {
    assert_eq!(
        migrate(&mut connection, version).unwrap(),
        (1..=version).collect::<Vec<_>>()
    );
    connection
}

#[cfg(test)]
pub(crate) fn startup_connection() -> Connection {
    booted(Connection::open_in_memory().unwrap())
}

#[cfg(test)]
pub(crate) fn database_at(version: u32) -> Connection {
    migrated_through(startup_connection(), version)
}

#[cfg(test)]
pub(crate) fn migrated_database() -> Connection {
    database_at(latest_version())
}

#[cfg(test)]
pub(crate) fn migrated_database_at(path: &std::path::Path) -> Connection {
    migrated_through(booted(Connection::open(path).unwrap()), latest_version())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;

    fn ledger(connection: &Connection) -> Vec<(i64, String)> {
        recorded(connection).unwrap()
    }

    fn without_ledger(
        snapshot: Vec<(String, String, Option<String>)>,
    ) -> Vec<(String, String, Option<String>)> {
        snapshot
            .into_iter()
            .filter(|(_, name, _)| name != "schema_migrations")
            .collect()
    }

    fn legacy_schema() -> Connection {
        let mut connection = startup_connection();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        crate::orchestration::initialize(&transaction).unwrap();
        transaction.commit().unwrap();
        connection
    }

    #[test]
    fn migrations_through_the_legacy_version_reproduce_the_legacy_initializer_schema() {
        let legacy = legacy_schema();
        let mut migrated = startup_connection();
        migrate(&mut migrated, LEGACY_SCHEMA_VERSION).unwrap();
        assert_eq!(
            without_ledger(schema_snapshot(&migrated)),
            schema_snapshot(&legacy),
            "migrations 0001 through the legacy version hold exactly the schema the pre-migration initializer creates"
        );
    }

    #[test]
    fn migrations_are_numbered_contiguously_and_match_one_file_each() {
        let versions: Vec<u32> = MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(versions, (1..=latest_version()).collect::<Vec<_>>());
        assert!(LEGACY_SCHEMA_VERSION <= latest_version());
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut files: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(
            files,
            MIGRATIONS.iter().map(file_name).collect::<Vec<_>>(),
            "every migration file is registered once, in order, under its numbered name"
        );
        for migration in MIGRATIONS {
            assert!(
                !migration.sql.contains("--") && !migration.sql.contains("/*"),
                "{} carries no SQL comments",
                file_name(migration)
            );
        }
    }

    #[test]
    fn migrations_apply_in_order_on_a_fresh_database_and_reopen_idempotently() {
        let mut connection = startup_connection();
        assert_eq!(
            migrate(&mut connection, latest_version()).unwrap(),
            (1..=latest_version()).collect::<Vec<_>>()
        );
        let first = schema_snapshot(&connection);
        let ledger_rows = ledger(&connection);
        assert_eq!(
            ledger_rows,
            MIGRATIONS
                .iter()
                .map(|migration| (i64::from(migration.version), migration.name.to_owned()))
                .collect::<Vec<_>>()
        );
        assert!(
            migrate(&mut connection, latest_version())
                .unwrap()
                .is_empty()
        );
        assert_eq!(schema_snapshot(&connection), first);
        assert_eq!(ledger(&connection), ledger_rows);
        assert!(connection.is_autocommit());
    }

    #[test]
    fn migrations_upgrade_a_version_one_database_through_each_additive_file() {
        let mut fresh = startup_connection();
        migrate(&mut fresh, latest_version()).unwrap();
        let mut upgraded = startup_connection();
        assert_eq!(migrate(&mut upgraded, 1).unwrap(), vec![1]);
        assert_eq!(
            migrate(&mut upgraded, latest_version()).unwrap(),
            (2..=latest_version()).collect::<Vec<_>>()
        );
        assert_eq!(schema_snapshot(&upgraded), schema_snapshot(&fresh));
    }

    #[test]
    fn migrations_adopt_a_pre_ledger_database_without_replaying_additive_files() {
        let mut fresh = startup_connection();
        migrate(&mut fresh, latest_version()).unwrap();
        let mut legacy = legacy_schema();
        assert!(!has_ledger(&legacy).unwrap());
        assert_eq!(
            migrate(&mut legacy, latest_version()).unwrap(),
            ((LEGACY_SCHEMA_VERSION + 1)..=latest_version()).collect::<Vec<_>>()
        );
        assert_eq!(
            ledger(&legacy).len(),
            MIGRATIONS.len(),
            "a pre-ledger database is recorded at every migration it already holds"
        );
        assert_eq!(schema_snapshot(&legacy), schema_snapshot(&fresh));
    }

    #[test]
    fn migrations_refuse_a_database_recorded_by_a_newer_host() {
        let mut connection = startup_connection();
        migrate(&mut connection, latest_version()).unwrap();
        let newer = latest_version() + 1;
        connection
            .execute(
                "INSERT INTO schema_migrations VALUES(?1,'future_change',0)",
                [newer],
            )
            .unwrap();
        let before = schema_snapshot(&connection);
        let error = migrate(&mut connection, latest_version())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("schema version {newer} is newer")),
            "{error}"
        );
        assert_eq!(schema_snapshot(&connection), before);
        assert!(connection.is_autocommit());
    }

    #[test]
    fn migrations_refuse_a_renamed_or_renumbered_record_and_require_a_transaction() {
        let mut connection = startup_connection();
        migrate(&mut connection, 1).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations VALUES(2,'conflicting_change',0)",
                [],
            )
            .unwrap();
        let error = migrate(&mut connection, latest_version())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("recorded as `conflicting_change`"),
            "{error}"
        );
        assert!(
            apply_pending(&Connection::open_in_memory().unwrap())
                .unwrap_err()
                .to_string()
                .contains("immediate transaction")
        );
    }

    #[test]
    fn migrations_insert_the_default_host_budget_the_budget_model_defines() {
        let mut connection = startup_connection();
        migrate(&mut connection, latest_version()).unwrap();
        let (revision, data): (i64, String) = connection
            .query_row(
                "SELECT revision,data FROM host_budget WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(revision, 1);
        assert_eq!(
            data,
            serde_json::to_string(&crate::budgets::Limits::default()).unwrap()
        );
    }

    #[test]
    fn migrations_normalize_only_insignificant_whitespace() {
        assert_eq!(
            normalize("CREATE TABLE t (\n  a TEXT,\n  b TEXT\n, c INTEGER)"),
            normalize("CREATE TABLE t(a TEXT,b TEXT, c INTEGER)")
        );
        assert_ne!(
            normalize("CREATE TABLE t(a TEXT NOT NULL)"),
            normalize("CREATE TABLE t(a TEXT)")
        );
    }

    fn table_sql(connection: &Connection, name: &str) -> String {
        normalize(
            &connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE name=?1",
                    [name],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
    }

    fn count(connection: &Connection, query: &str) -> i64 {
        connection.query_row(query, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migrations_session_reuse_rebuilds_attempt_tables_and_keeps_rows_under_foreign_keys() {
        let mut connection = database_at(9);
        connection.execute_batch("INSERT INTO workflow_runs VALUES('run','Run','Goal',NULL,1,'active',1);
            INSERT INTO workflow_tasks VALUES('task','run','task','{}');
            INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state,result) VALUES('first','task',1,'worker','failed','{\"outcome\":\"failed\"}');
            INSERT INTO workflow_process_exits VALUES('worker',5);
            INSERT INTO operation_receipts(id,issuer,key,digest,operation,phase,session_id,result) VALUES('launch','owner','launch','digest','create','created','worker','{}');
            INSERT INTO workflow_deliveries(id,run_id,attempt_id,issuer,phase,created_at,deadline_at) VALUES('delivery','run','first','owner','sent',1,2);
            INSERT INTO workflow_controls VALUES('control','run','stop','owner','completed',NULL,1);
            INSERT INTO harness_jobs(id,spec,revision,enabled,created_at) VALUES('job','{}',1,1,1);
            INSERT INTO harness_job_occurrences(id,job_id,job_revision,spec,trigger_key,trigger_kind,due_at,created_at,state) VALUES('occurrence','job',1,'{}','trigger','once',1,1,'running');
            INSERT INTO harness_job_attempts(id,occurrence_id,ordinal,run_id,created_at,state) VALUES('job-attempt','occurrence',1,'run',1,'running');
            INSERT INTO harness_job_timeouts(job_attempt_id,job_id,occurrence_id,run_id,attempt_id,session_id,launch_receipt_id,issuer,timeout_ms,armed_at,deadline_at,armed_monotonic_ms,deadline_monotonic_ms,state,observed_at,control_key,control_id) VALUES('job-attempt','job','occurrence','run','first','worker','launch','owner',1000,1,2,1,2,'armed',1,'timeout-key','control');").unwrap();
        assert!(
            table_sql(&connection, "workflow_attempts").contains("session_id TEXT NOT NULL UNIQUE")
        );
        assert_eq!(migrate(&mut connection, 10).unwrap(), vec![10]);
        assert!(!table_sql(&connection, "workflow_attempts").contains("UNIQUE,"));
        for table in ["workflow_process_exits", "harness_job_timeouts"] {
            assert!(!table_sql(&connection, table).contains("workflow_attempts(session_id)"));
        }
        assert!(
            table_sql(&connection, "harness_job_timeouts")
                .contains("session_id TEXT NOT NULL UNIQUE")
        );
        assert!(
            table_sql(&connection, "workflow_attempts_open_session").contains("WHERE state IN")
        );
        for index in [
            "workflow_attempts_session",
            "harness_job_timeouts_due",
            "harness_job_timeouts_control",
        ] {
            assert_eq!(
                count(
                    &connection,
                    &format!(
                        "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='{index}'"
                    )
                ),
                1
            );
        }
        assert_eq!(
            count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM workflow_attempts WHERE id='first' AND session_id='worker' AND state='failed' AND json_extract(result,'$.outcome')='failed'"
            ),
            1
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM workflow_process_exits WHERE session_id='worker' AND observed_at=5"
            ),
            1
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM workflow_deliveries WHERE attempt_id='first'"
            ),
            1
        );
        assert_eq!(
            count(
                &connection,
                "SELECT count(*) FROM harness_job_timeouts WHERE attempt_id='first' AND session_id='worker' AND control_id='control'"
            ),
            1
        );
        for table in ["workflow_session_reuses", "workflow_delivery_identities"] {
            assert_eq!(
                count(&connection, &format!("SELECT count(*) FROM {table}")),
                0
            );
        }
        connection.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('second','task',2,'worker','assigned')", []).unwrap();
        assert!(
            connection.execute("INSERT INTO workflow_attempts(id,task_id,ordinal,session_id,state) VALUES('third','task',3,'worker','reported')", []).is_err(),
            "one session owns at most one open attempt"
        );
        assert_eq!(
            count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );
    }
}
