pub mod link;
pub mod local_host;
pub mod pairing;
pub mod store;
pub mod supervisor;

use local_host::LocalHostConfig;
use pairing::{DEFAULT_PORT, Pairing};
use serde::Serialize;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use store::ConfigStore;
use supervisor::{
    CommandSlot, ConnectionState, Outbound, Sink, Status, supervise, supervise_local,
};
use tauri::{AppHandle, Emitter, Manager, State, async_runtime};

const STATE_EVENT: &str = "host://state";
const SESSIONS_EVENT: &str = "host://sessions";

struct AppState {
    store: ConfigStore,
    task: Mutex<Option<async_runtime::JoinHandle<()>>>,
    slot: CommandSlot,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Local,
    Remote,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    mode: Mode,
    has_remote_pairing: bool,
    host_url: Option<String>,
    port: u16,
    default_port: u16,
    host_binary: Option<String>,
}

fn host_config(store: &ConfigStore) -> HostConfig {
    let settings = store.load_settings();
    let pairing = store.load_pairing();
    let remote = settings.remote && pairing.is_some();
    HostConfig {
        mode: if remote { Mode::Remote } else { Mode::Local },
        has_remote_pairing: pairing.is_some(),
        host_url: pairing
            .as_ref()
            .and_then(|pairing| pairing.host_url(settings.port).ok()),
        port: match (&pairing, remote) {
            (Some(pairing), true) => pairing.effective_port(settings.port),
            _ => settings.port.unwrap_or(DEFAULT_PORT),
        },
        default_port: DEFAULT_PORT,
        host_binary: settings.host_binary,
    }
}

fn stop(state: &AppState) {
    if let Some(task) = state.task.lock().expect("task lock poisoned").take() {
        task.abort();
    }
    *state.slot.lock().expect("command slot poisoned") = None;
}

fn emit_sink(app: AppHandle) -> Sink {
    Arc::new(move |outbound| {
        let _ = match outbound {
            Outbound::State(state) => app.emit(STATE_EVENT, state),
            Outbound::Sessions(snapshot) => app.emit(SESSIONS_EVENT, snapshot),
        };
    })
}

fn emit_idle(app: &AppHandle) {
    let _ = app.emit(STATE_EVENT, ConnectionState::new(Status::Idle, None, 0));
}

fn update_settings(
    state: &AppState,
    change: impl FnOnce(&mut store::Settings),
) -> Result<(), String> {
    let mut settings = state.store.load_settings();
    change(&mut settings);
    state
        .store
        .save_settings(&settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_config(state: State<'_, AppState>) -> HostConfig {
    host_config(&state.store)
}

#[tauri::command]
fn save_pairing(pairing: String, state: State<'_, AppState>) -> Result<HostConfig, String> {
    let parsed = Pairing::parse(&pairing).map_err(|error| error.to_string())?;
    state
        .store
        .save_pairing(&parsed)
        .map_err(|error| error.to_string())?;
    update_settings(&state, |settings| settings.remote = true)?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn use_local_host(state: State<'_, AppState>) -> Result<HostConfig, String> {
    update_settings(&state, |settings| settings.remote = false)?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn forget_pairing(state: State<'_, AppState>) -> Result<HostConfig, String> {
    state
        .store
        .clear_pairing()
        .map_err(|error| error.to_string())?;
    update_settings(&state, |settings| settings.remote = false)?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn save_port(port: u16, state: State<'_, AppState>) -> Result<HostConfig, String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }
    update_settings(&state, |settings| settings.port = Some(port))?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn save_host_binary(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<HostConfig, String> {
    let path = path
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty());
    update_settings(&state, |settings| settings.host_binary = path)?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    stop(&state);
    let settings = state.store.load_settings();
    let sink = emit_sink(app);
    let slot = Arc::clone(&state.slot);
    let task = match state.store.load_pairing().filter(|_| settings.remote) {
        Some(pairing) => {
            let url = pairing
                .host_url(settings.port)
                .map_err(|error| error.to_string())?;
            let key = pairing.key_bytes().map_err(|error| error.to_string())?;
            async_runtime::spawn(supervise(url, key, sink, slot))
        }
        None => {
            let config = LocalHostConfig {
                state_dir: state.store.directory().to_path_buf(),
                port: settings.port.unwrap_or(DEFAULT_PORT),
                binary_override: settings.host_binary.map(PathBuf::from),
            };
            async_runtime::spawn(supervise_local(config, sink, slot))
        }
    };
    *state.task.lock().expect("task lock poisoned") = Some(task);
    Ok(())
}

#[tauri::command]
fn disconnect(app: AppHandle, state: State<'_, AppState>) {
    stop(&state);
    emit_idle(&app);
}

#[tauri::command]
fn stop_local_host(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    stop(&state);
    emit_idle(&app);
    local_host::stop(state.store.directory()).map_err(|error| error.to_string())
}

#[tauri::command]
fn refresh(state: State<'_, AppState>) -> Result<(), String> {
    let slot = state.slot.lock().expect("command slot poisoned");
    let commands = slot.as_ref().ok_or("Not connected to a host")?;
    commands
        .try_send(json!({"type": "list"}))
        .map_err(|_| "Connection is busy".to_owned())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            app.manage(AppState {
                store: ConfigStore::new(directory),
                task: Mutex::new(None),
                slot: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_pairing,
            use_local_host,
            forget_pairing,
            save_port,
            save_host_binary,
            connect,
            disconnect,
            stop_local_host,
            refresh
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the nesvo desktop application");
}
