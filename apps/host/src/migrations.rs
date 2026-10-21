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
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;

    fn migrate(connection: &mut Connection, target: u32) -> Result<Vec<u32>> {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let applied = apply_through(&transaction, target)?;
        transaction.commit()?;
        Ok(applied)
    }

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
        let mut connection = Connection::open_in_memory().unwrap();
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
        let mut migrated = Connection::open_in_memory().unwrap();
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
        let mut connection = Connection::open_in_memory().unwrap();
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
        let mut fresh = Connection::open_in_memory().unwrap();
        migrate(&mut fresh, latest_version()).unwrap();
        let mut upgraded = Connection::open_in_memory().unwrap();
        assert_eq!(migrate(&mut upgraded, 1).unwrap(), vec![1]);
        assert_eq!(
            migrate(&mut upgraded, latest_version()).unwrap(),
            (2..=latest_version()).collect::<Vec<_>>()
        );
        assert_eq!(schema_snapshot(&upgraded), schema_snapshot(&fresh));
    }

    #[test]
    fn migrations_adopt_a_pre_ledger_database_without_replaying_additive_files() {
        let mut fresh = Connection::open_in_memory().unwrap();
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
        let mut connection = Connection::open_in_memory().unwrap();
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
        let mut connection = Connection::open_in_memory().unwrap();
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
        let mut connection = Connection::open_in_memory().unwrap();
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
}
