//! Bounded host-owned quota wake dispatch, independent of connected clients.
use crate::{
    api_error::Error,
    event_log::Service,
    quota_wakes::{Reply, Work},
    sessions::State,
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

pub(crate) async fn configure(
    state: Arc<Mutex<State>>,
    log: Service,
    client: u64,
    session: String,
    enabled: bool,
) -> Result<Value> {
    let authority = state.lock().unwrap().operation_authority(client)?;
    if !matches!(authority, crate::caller::Authority::Owner) {
        return Err(Error::new(
            "forbidden",
            "Only the owner may configure quota continuation",
        )
        .into());
    }
    let view = if enabled {
        let arm = state.lock().unwrap().prepare_quota_wake(client, &session)?;
        let result = log.quota_wakes(Work::Arm(arm.clone())).await;
        match result {
            Ok(Reply::Armed(view)) => view,
            Err(error) => {
                state.lock().unwrap().disarm_quota_wake(&session);
                return Err(error);
            }
            _ => return Err(anyhow!("Unexpected quota wake arm reply")),
        }
    } else {
        // Fence native input before waiting for the writer, including an in-flight paste.
        state.lock().unwrap().disarm_quota_wake(&session);
        log.quota_wakes(Work::Disable(session.clone())).await?;
        let retained = match log.quota_wakes(Work::Current(session.clone())).await? {
            Reply::Current(view) => view.map(|view| view.public()),
            _ => return Err(anyhow!("Unexpected quota wake history reply")),
        };
        return Ok(
            json!({"type":"wakeConfigured","sessionId":session,"wakeAt":null,"quotaWake":retained}),
        );
    };
    state.lock().unwrap().broadcast_list();
    Ok(
        json!({"type":"wakeConfigured","sessionId":session,"wakeAt":view.arm.proof.reset_at,"quotaWake":view.public()}),
    )
}

pub(crate) struct Runtime {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
impl Runtime {
    pub fn start(state: Arc<Mutex<State>>, log: Service) -> Self {
        let (stop, mut stopping) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased; _ = stopping.changed() => break, _ = timer.tick() => {} }
                let views = match log.quota_wakes(Work::List).await {
                    Ok(Reply::List(views)) => views,
                    _ => continue,
                };
                for view in views {
                    if *stopping.borrow() {
                        break;
                    }
                    let ready = state.lock().unwrap().quota_wake_ready(&view.arm);
                    match ready {
                        Ok(false) => continue,
                        Err(error) => {
                            state.lock().unwrap().disarm_exact_quota_wake(&view.arm);
                            let _ = log
                                .quota_wakes(Work::Pause {
                                    id: view.arm.id.clone(),
                                    reason: error
                                        .downcast_ref::<Error>()
                                        .map(|error| error.code)
                                        .unwrap_or("quota_wake_refused"),
                                })
                                .await;
                            continue;
                        }
                        Ok(true) => {}
                    }
                    let dispatch = match log
                        .quota_wakes(Work::Claim {
                            id: view.arm.id.clone(),
                            expected: view.arm,
                        })
                        .await
                    {
                        Ok(Reply::Claimed(Some(dispatch))) => dispatch,
                        _ => continue,
                    };
                    let target = dispatch.arm.clone();
                    // One serial continuation uses the normal durable send/flush/fence path.
                    // A lost response never causes another native attempt.
                    let _ = crate::operations::dispatch_quota_resume(
                        state.clone(),
                        log.clone(),
                        dispatch,
                    )
                    .await;
                    state.lock().unwrap().disarm_exact_quota_wake(&target);
                }
            }
        });
        Self { stop, task }
    }
    pub fn request_shutdown(&self) {
        let _ = self.stop.send(true);
    }
    pub async fn shutdown(mut self) -> bool {
        self.request_shutdown();
        match tokio::time::timeout(Duration::from_secs(10), &mut self.task).await {
            Ok(result) => result.is_ok(),
            Err(_) => {
                self.task.abort();
                false
            }
        }
    }
}
