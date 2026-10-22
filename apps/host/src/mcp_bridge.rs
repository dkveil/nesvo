use crate::{command_scope, mcp_pool};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

pub(crate) const FLAG: &str = "--mcp-bridge";
pub(crate) const VERSION: u32 = 1;
const LEASE_BYTES: u64 = 64 * 1024;
const CONNECT_DEADLINE: Duration = Duration::from_secs(2);
const LAUNCH_FAILED: i32 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Endpoint {
    pub(crate) endpoint: String,
    pub(crate) token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Launch {
    pub(crate) command: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Lease {
    pub(crate) version: u32,
    pub(crate) server: String,
    pub(crate) lease: Option<Endpoint>,
    pub(crate) spawn: Launch,
}

pub(crate) fn read(path: &Path) -> Option<Lease> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(LEASE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > LEASE_BYTES {
        return None;
    }
    let lease: Lease = serde_json::from_slice(&bytes).ok()?;
    (lease.version == VERSION && lease.spawn.command.is_absolute() && lease.spawn.cwd.is_absolute())
        .then_some(lease)
}

pub(crate) fn run(path: &Path) -> i32 {
    let Some(lease) = read(path) else {
        return LAUNCH_FAILED;
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
    else {
        return LAUNCH_FAILED;
    };
    let code = runtime.block_on(bridge(lease));
    runtime.shutdown_background();
    code
}

async fn bridge(lease: Lease) -> i32 {
    if let Some(endpoint) = &lease.lease
        && valid_token(&endpoint.token)
        && let Ok(Some(mut stream)) =
            tokio::time::timeout(CONNECT_DEADLINE, connect(&endpoint.endpoint)).await
        && stream
            .write_all(format!("{}\n", endpoint.token).as_bytes())
            .await
            .is_ok()
    {
        relay(stream).await;
        return 0;
    }
    dedicated(&lease.spawn).await
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(windows)]
async fn connect(address: &str) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
    if !address.starts_with(r"\\.\pipe\nesvo-mcp-") {
        return None;
    }
    tokio::net::windows::named_pipe::ClientOptions::new()
        .open(address)
        .ok()
}

#[cfg(unix)]
async fn connect(address: &str) -> Option<tokio::net::UnixStream> {
    let path = Path::new(address);
    let inside = path
        .parent()
        .and_then(Path::parent)
        .is_some_and(|parent| parent == std::env::temp_dir());
    if !inside {
        return None;
    }
    tokio::net::UnixStream::connect(path).await.ok()
}

async fn relay(stream: impl AsyncRead + AsyncWrite) {
    let (mut read, mut write) = tokio::io::split(stream);
    let upstream = async {
        let _ = tokio::io::copy(&mut tokio::io::stdin(), &mut write).await;
        let _ = write.shutdown().await;
    };
    let downstream = async {
        let mut stdout = tokio::io::stdout();
        let _ = tokio::io::copy(&mut read, &mut stdout).await;
        let _ = stdout.flush().await;
    };
    tokio::select! {
        () = upstream => {}
        () = downstream => {}
    }
}

async fn dedicated(launch: &Launch) -> i32 {
    let Some(temp) = mcp_pool::private_temp() else {
        return LAUNCH_FAILED;
    };
    let mut command = tokio::process::Command::new(&launch.command);
    command.args(&launch.args).current_dir(&launch.cwd);
    mcp_pool::isolate(&mut command, &launch.env, &temp);
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command_scope::configure(&mut command);
    let code = match command.spawn() {
        Err(_) => LAUNCH_FAILED,
        Ok(mut child) => match command_scope::Scope::enroll(&child) {
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                LAUNCH_FAILED
            }
            Ok(scope) => {
                let status = child.wait().await;
                let _ = scope.terminate();
                status.ok().and_then(|status| status.code()).unwrap_or(1)
            }
        },
    };
    mcp_pool::remove_temp(&temp);
    code
}
