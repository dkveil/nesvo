use crate::{
    link::open,
    local_host::{LocalHostConfig, ensure},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, time::sleep};

const MAX_BACKOFF_SECONDS: u64 = 15;
const COMMAND_QUEUE: usize = 16;
const LOCAL_FAILURE_LIMIT: u32 = 3;
const MESSAGE_QUEUE: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConnectionState {
    pub status: Status,
    pub message: Option<String>,
    pub attempt: u32,
}

impl ConnectionState {
    pub fn new(status: Status, message: Option<String>, attempt: u32) -> Self {
        Self {
            status,
            message,
            attempt,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outbound {
    State(ConnectionState),
    Sessions(Value),
}

pub type Sink = Arc<dyn Fn(Outbound) + Send + Sync>;
pub type CommandSlot = Arc<Mutex<Option<mpsc::Sender<Value>>>>;

pub fn backoff(attempt: u32) -> Duration {
    let seconds = 1u64 << attempt.saturating_sub(1).min(4);
    Duration::from_secs(seconds.min(MAX_BACKOFF_SECONDS))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopEnd {
    PermanentFailure,
    TooManyFailures,
}

pub async fn run_link_loop(
    url: &str,
    key: [u8; 32],
    sink: &Sink,
    slot: &CommandSlot,
    max_failures: Option<u32>,
) -> LoopEnd {
    let mut attempt = 0u32;
    loop {
        let failure = match open(url, key).await {
            Ok(link) => {
                attempt = 0;
                let (commands, command_rx) = mpsc::channel(COMMAND_QUEUE);
                let (message_tx, mut messages) = mpsc::channel(MESSAGE_QUEUE);
                *slot.lock().expect("command slot poisoned") = Some(commands);
                sink(Outbound::State(ConnectionState::new(
                    Status::Connected,
                    None,
                    0,
                )));
                let serving = tokio::spawn(link.serve(command_rx, message_tx));
                while let Some(message) = messages.recv().await {
                    if message["type"] == "sessions" {
                        sink(Outbound::Sessions(message));
                    }
                }
                *slot.lock().expect("command slot poisoned") = None;
                match serving.await {
                    Ok(Err(error)) => error.to_string(),
                    Ok(Ok(())) => "Connection closed".to_owned(),
                    Err(error) => error.to_string(),
                }
            }
            Err(error) if error.permanent => {
                sink(Outbound::State(ConnectionState::new(
                    Status::Failed,
                    Some(error.message),
                    attempt,
                )));
                return LoopEnd::PermanentFailure;
            }
            Err(error) => error.message,
        };
        attempt += 1;
        sink(Outbound::State(ConnectionState::new(
            Status::Reconnecting,
            Some(failure),
            attempt,
        )));
        if max_failures.is_some_and(|limit| attempt >= limit) {
            return LoopEnd::TooManyFailures;
        }
        sleep(backoff(attempt)).await;
    }
}

pub async fn supervise(url: String, key: [u8; 32], sink: Sink, slot: CommandSlot) {
    sink(Outbound::State(ConnectionState::new(
        Status::Connecting,
        None,
        0,
    )));
    run_link_loop(&url, key, &sink, &slot, None).await;
}

pub async fn supervise_local(config: LocalHostConfig, sink: Sink, slot: CommandSlot) {
    let mut permanent_failures = 0u32;
    loop {
        sink(Outbound::State(ConnectionState::new(
            Status::Connecting,
            Some("Starting the local host".to_owned()),
            0,
        )));
        let target = match ensure(&config).await {
            Ok(target) => target,
            Err(error) => {
                sink(Outbound::State(ConnectionState::new(
                    Status::Failed,
                    Some(error.to_string()),
                    0,
                )));
                return;
            }
        };
        match run_link_loop(
            &target.url,
            target.key,
            &sink,
            &slot,
            Some(LOCAL_FAILURE_LIMIT),
        )
        .await
        {
            LoopEnd::TooManyFailures => sleep(backoff(1)).await,
            LoopEnd::PermanentFailure => {
                permanent_failures += 1;
                if permanent_failures > 1 {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_at_fifteen_seconds() {
        let seconds: Vec<u64> = (1..=7).map(|attempt| backoff(attempt).as_secs()).collect();
        assert_eq!(seconds, [1, 2, 4, 8, 15, 15, 15]);
    }

    #[test]
    fn connection_state_serializes_for_the_webview() {
        let state = ConnectionState::new(Status::Reconnecting, Some("x".into()), 2);
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            serde_json::json!({"status": "reconnecting", "message": "x", "attempt": 2})
        );
    }
}
