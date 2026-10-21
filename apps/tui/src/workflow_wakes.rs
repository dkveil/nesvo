//! Host-owned coordinator notices; CLI never constructs or injects their text.
use clap::Subcommand;
use serde::{Deserialize, Serialize};

#[derive(Subcommand)]
pub enum Command {
    /// Deliberately enable grouped notifications for the run's live coordinator.
    Enable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Disable future wake input. Does not undo bytes, stop or acknowledge work.
    Disable {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Owner-only: hold delivery; nothing is recorded until resume resynchronises.
    Pause {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Owner-only: resume a held policy from current unacknowledged messages and blockers.
    Resume {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Owner-only: choose delta-only notices or notices plus the current context digest.
    Delivery {
        id: String,
        #[arg(value_enum)]
        mode: Delivery,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        json: bool,
    },
    /// Inspect policy and eight notice references. Reading never wakes a model.
    Get {
        id: String,
        #[arg(long)]
        after: Option<u64>,
        #[arg(long)]
        json: bool,
    },
    /// Inspect one immutable batch and its native receipt pointer.
    Batch {
        id: String,
        batch: String,
        #[arg(long)]
        json: bool,
    },
}
impl Command {
    pub fn machine(&self) -> bool {
        match self {
            Self::Enable { json, .. }
            | Self::Disable { json, .. }
            | Self::Pause { json, .. }
            | Self::Resume { json, .. }
            | Self::Delivery { json, .. }
            | Self::Get { json, .. }
            | Self::Batch { json, .. } => *json,
        }
    }
    pub fn request(self) -> Request {
        match self {
            Self::Enable {
                id, key, revision, ..
            } => Request::Enable {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Disable {
                id, key, revision, ..
            } => Request::Disable {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Pause {
                id, key, revision, ..
            } => Request::Pause {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Resume {
                id, key, revision, ..
            } => Request::Resume {
                key,
                run_id: id,
                expected_revision: revision,
            },
            Self::Delivery {
                id,
                mode,
                key,
                revision,
                ..
            } => Request::SetDelivery {
                key,
                run_id: id,
                expected_revision: revision,
                delivery: mode,
            },
            Self::Get { id, after, .. } => Request::Get { run_id: id, after },
            Self::Batch { id, batch, .. } => Request::Batch {
                run_id: id,
                batch_id: batch,
            },
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, clap::ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Delta,
    Full,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Enable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Disable {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Pause {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    Resume {
        key: String,
        run_id: String,
        expected_revision: u64,
    },
    SetDelivery {
        key: String,
        run_id: String,
        expected_revision: u64,
        delivery: Delivery,
    },
    Get {
        run_id: String,

        after: Option<u64>,
    },
    Batch {
        run_id: String,
        batch_id: String,
    },
}
