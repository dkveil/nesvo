mod groups;
mod launchers;
mod process;
mod protocol;
mod pty;
mod replay;
mod sessions;
mod status;
mod storage;
mod transport;
use nesvo_host::wire;

use anyhow::{Context, Result, ensure};
use clap::Parser;
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc},
};

#[derive(Parser)]
#[command(
    version,
    about = "nesvo private terminal companion. Shells run only when requested in a paired client."
)]
struct Args {
    #[arg(long)]
    lan: bool,
    #[arg(long)]
    bind: Option<IpAddr>,
    #[arg(long, default_value_t = 8787, env = "POCKET_HOST_PORT")]
    port: u16,
    #[arg(long, env = "POCKET_HOST_ADDRESS")]
    advertise: Option<String>,
    #[arg(long, default_value = ".")]
    workspace: PathBuf,
    #[arg(long)]
    rotate_key: bool,
    #[arg(long)]
    pairing_dir: Option<PathBuf>,
    #[arg(long, env = "POCKET_ALLOWED_ORIGINS", value_delimiter = ',')]
    allowed_origins: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    version: u8,
    url: String,
    key: String,
}

fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

fn local_ip() -> Option<IpAddr> {
    // UDP connect selects the default route; it sends no datagram.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn repository_pairing_directory(root: &Path) -> Option<PathBuf> {
    ["apps/host/Cargo.toml", "host/Cargo.toml"]
        .iter()
        .any(|manifest| root.join(manifest).is_file())
        // Source layout changes must not move existing pairing credentials.
        .then(|| root.join("host/.local"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let workspace = fs::canonicalize(&args.workspace).context("Workspace does not exist")?;
    ensure!(workspace.is_dir(), "Workspace must be a directory");
    let bind = args.bind.unwrap_or(IpAddr::V4(if args.lan {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    }));
    let listen_address = SocketAddr::new(bind, args.port);
    let listener = TcpListener::bind(listen_address).await.map_err(|error| {
        let message = if error.kind() == ErrorKind::AddrInUse {
            format!(
                "Could not listen on {listen_address}: address already in use. If a nesvo host is running, reuse it. To start another, choose an unused --port and a separate --pairing-dir."
            )
        } else {
            format!("Could not bind the terminal host to {listen_address}")
        };
        anyhow::Error::new(error).context(message)
    })?;
    let actual_port = listener.local_addr()?.port();
    let advertised = args.advertise.unwrap_or_else(|| {
        if bind.is_unspecified() {
            local_ip()
                .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
                .to_string()
        } else {
            bind.to_string()
        }
    });
    let advertised = if advertised.contains(':') && !advertised.starts_with('[') {
        format!("[{advertised}]")
    } else {
        advertised
    };
    let url = format!("ws://{advertised}:{actual_port}");
    let parsed_url = url::Url::parse(&url).context("Invalid advertised address")?;
    ensure!(
        parsed_url.username().is_empty()
            && parsed_url.password().is_none()
            && parsed_url.path() == "/"
            && parsed_url.query().is_none()
            && parsed_url.fragment().is_none(),
        "Advertise must contain only an IP address or hostname"
    );
    let pairing_dir = args.pairing_dir.unwrap_or_else(|| {
        if let Some(directory) = repository_pairing_directory(Path::new(".")) {
            directory
        } else if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                // Preserve the existing data directory and pairing credentials.
                .join("PocketSessions")
                .join("pairing")
        } else {
            std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
                })
                .unwrap_or_else(|| PathBuf::from(".local"))
                // Preserve the existing data directory and pairing credentials.
                .join("pocket-sessions")
        }
    });
    fs::create_dir_all(&pairing_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pairing_dir, fs::Permissions::from_mode(0o700))?;
    }
    let pairing_path = pairing_dir.join("pairing.json");
    let existing = if args.rotate_key {
        None
    } else {
        fs::read(&pairing_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Pairing>(&data).ok())
            .and_then(|pairing| hex::decode(pairing.key).ok())
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
    };
    let key = existing.unwrap_or_else(wire::random::<32>);
    let pairing = Pairing {
        version: 1,
        url,
        key: hex::encode(key),
    };
    let pairing_json = serde_json::to_vec_pretty(&pairing)?;
    private_write(&pairing_path, &pairing_json)?;
    let qr = QrCode::new(serde_json::to_vec(&pairing)?)?;
    let svg = qr
        .render::<svg::Color>()
        .min_dimensions(420, 420)
        .quiet_zone(true)
        .build();
    let qr_path = pairing_dir.join("pairing.svg");
    private_write(&qr_path, svg.as_bytes())?;

    let metadata = storage::MetadataStore::open(&pairing_dir.join("metadata.sqlite3"))?;
    let launchers = launchers::Launchers::discover();
    let state = Arc::new(Mutex::new(sessions::State::new(
        workspace.clone(),
        metadata,
        launchers,
    )));
    let (event_tx, event_rx) = mpsc::channel(128);
    tokio::spawn(sessions::dispatch_output(state.clone(), event_rx));
    let permits = Arc::new(Semaphore::new(16));
    println!("nesvo Rust host listening on {bind}:{actual_port}");
    println!("Workspace: {}", workspace.display());
    println!("Private pairing file: {}", pairing_path.display());
    println!("Private pairing QR: {}", qr_path.display());
    println!("Pairing grants shell access. Keep both files private. Ctrl+C closes all sessions.");
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                let Ok(permit) = permits.clone().try_acquire_owned() else { drop(socket); continue; };
                let state = state.clone();
                let events = event_tx.clone();
                let allowed_origins = args.allowed_origins.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = transport::handle(socket, key, state, events, allowed_origins).await;
                });
            }
        }
    }
    state.lock().unwrap().shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_layout_migration_preserves_repository_pairing_directory() {
        let fixture = std::env::temp_dir().join(format!(
            "nesvo-path-test-{}",
            hex::encode(wire::random::<8>())
        ));
        fs::create_dir_all(fixture.join("host")).unwrap();
        assert_eq!(repository_pairing_directory(&fixture), None);
        fs::write(fixture.join("host/Cargo.toml"), "").unwrap();
        let expected = Some(fixture.join("host/.local"));
        assert_eq!(repository_pairing_directory(&fixture), expected);
        fs::remove_file(fixture.join("host/Cargo.toml")).unwrap();
        fs::create_dir_all(fixture.join("apps/host")).unwrap();
        fs::write(fixture.join("apps/host/Cargo.toml"), "").unwrap();
        assert_eq!(repository_pairing_directory(&fixture), expected);
        fs::remove_dir_all(fixture).unwrap();
    }
}
