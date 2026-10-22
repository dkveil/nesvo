use clap::Args;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Start {
    pub id: String,
    #[arg(long)]
    pub key: String,
    #[arg(long)]
    pub revision: u64,
    #[arg(long)]
    pub json: bool,
}
impl Start {
    pub fn request(self, kind: Kind) -> Request {
        Request::Start {
            key: self.key,
            run_id: self.id,
            expected_revision: self.revision,
            kind,
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Stop,
    Cancel,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Start {
        key: String,
        run_id: String,
        expected_revision: u64,
        kind: Kind,
    },
    Get {
        run_id: String,
        control_id: String,
        offset: Option<u16>,
    },
}
