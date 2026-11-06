pub mod link;
pub mod pairing;
pub mod store;
pub mod supervisor;

use pairing::{DEFAULT_PORT, Pairing};
use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use store::{ConfigStore, Settings};
use supervisor::{CommandSlot, ConnectionState, Outbound, Sink, Status, supervise};
use tauri::{AppHandle, Emitter, Manager, State, async_runtime};

const STATE_EVENT: &str = "host://state";
const SESSIONS_EVENT: &str = "host://sessions";

struct AppState {
    store: ConfigStore,
    task: Mutex<Option<async_runtime::JoinHandle<()>>>,
    slot: CommandSlot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    has_pairing: bool,
    host_url: Option<String>,
    port: u16,
    default_port: u16,
}

fn host_config(store: &ConfigStore) -> HostConfig {
    let settings = store.load_settings();
    let pairing = store.load_pairing();
    HostConfig {
        has_pairing: pairing.is_some(),
        host_url: pairing
            .as_ref()
            .and_then(|pairing| pairing.host_url(settings.port).ok()),
        port: pairing
            .as_ref()
            .map_or(settings.port.unwrap_or(DEFAULT_PORT), |pairing| {
                pairing.effective_port(settings.port)
            }),
        default_port: DEFAULT_PORT,
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
    Ok(host_config(&state.store))
}

#[tauri::command]
fn forget_pairing(app: AppHandle, state: State<'_, AppState>) -> Result<HostConfig, String> {
    stop(&state);
    state
        .store
        .clear_pairing()
        .map_err(|error| error.to_string())?;
    let _ = app.emit(STATE_EVENT, ConnectionState::new(Status::Idle, None, 0));
    Ok(host_config(&state.store))
}

#[tauri::command]
fn save_port(port: u16, state: State<'_, AppState>) -> Result<HostConfig, String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }
    state
        .store
        .save_settings(&Settings { port: Some(port) })
        .map_err(|error| error.to_string())?;
    Ok(host_config(&state.store))
}

#[tauri::command]
fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    stop(&state);
    let pairing = state.store.load_pairing().ok_or("No host is paired yet")?;
    let url = pairing
        .host_url(state.store.load_settings().port)
        .map_err(|error| error.to_string())?;
    let key = pairing.key_bytes().map_err(|error| error.to_string())?;
    let task = async_runtime::spawn(supervise(url, key, emit_sink(app), Arc::clone(&state.slot)));
    *state.task.lock().expect("task lock poisoned") = Some(task);
    Ok(())
}

#[tauri::command]
fn disconnect(app: AppHandle, state: State<'_, AppState>) {
    stop(&state);
    let _ = app.emit(STATE_EVENT, ConnectionState::new(Status::Idle, None, 0));
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
            forget_pairing,
            save_port,
            connect,
            disconnect,
            refresh
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the nesvo desktop application");
}
