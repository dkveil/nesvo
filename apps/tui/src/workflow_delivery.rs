//! Strict task-instruction intent DTOs; no caller-supplied prompt or authority.
use clap::Args;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Deliver {
    pub id: String,
    #[arg(long)]
    task: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    revision: u64,
    #[arg(long, value_parser=clap::value_parser!(u64).range(1..=300_000))]
    timeout_ms: Option<u64>,
    #[arg(
        long,
        help = "Reuse this task's own settled idle worker session for a new attempt"
    )]
    session: Option<String>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Args)]
pub struct Cancel {
    pub id: String,
    pub delivery: String,
    #[arg(long)]
    key: String,
    #[arg(long)]
    revision: u64,
    #[arg(long)]
    pub json: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Queue {
        key: String,
        run_id: String,
        task_id: String,
        expected_revision: u64,
        timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    Cancel {
        key: String,
        run_id: String,
        delivery_id: String,
        expected_revision: u64,
    },
}
impl Deliver {
    pub fn request(self) -> Request {
        Request::Queue {
            key: self.key,
            run_id: self.id,
            task_id: self.task,
            expected_revision: self.revision,
            timeout_ms: self.timeout_ms,
            session_id: self.session,
        }
    }
}
impl Cancel {
    pub fn request(self) -> Request {
        Request::Cancel {
            key: self.key,
            run_id: self.id,
            delivery_id: self.delivery,
            expected_revision: self.revision,
        }
    }
}
