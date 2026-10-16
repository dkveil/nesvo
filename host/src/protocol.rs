use serde::Deserialize;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Auth {
        client_nonce: String,
    },
    List,
    Create {
        name: String,
        cwd: Option<String>,
        group_id: Option<String>,
    },
    RenameSession {
        session_id: String,
        name: String,
    },
    Attach {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Subscribe {
        session_id: String,
    },
    Unsubscribe {
        session_id: String,
    },
    AcquireControl {
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        take_over: bool,
    },
    ReleaseControl {
        session_id: String,
        lease_id: String,
    },
    Input {
        session_id: String,
        data: String,
        lease_id: Option<String>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
        lease_id: Option<String>,
    },
    Close {
        session_id: String,
    },
    CreateGroup {
        name: String,
        parent_id: Option<String>,
        #[serde(default)]
        order: u32,
        expected_revision: u64,
    },
    UpdateGroup {
        group_id: String,
        name: String,
        parent_id: Option<String>,
        order: u32,
        expected_revision: u64,
    },
    DeleteGroup {
        group_id: String,
        expected_revision: u64,
    },
    MoveSession {
        session_id: String,
        group_id: Option<String>,
        expected_revision: u64,
    },
}
