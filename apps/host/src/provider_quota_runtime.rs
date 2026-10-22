use crate::{launchers::Program, sessions::State};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(crate) type Reader = (
    (std::path::PathBuf, Vec<std::ffi::OsString>),
    std::path::PathBuf,
    mpsc::Receiver<()>,
);

pub(crate) struct RefreshControl {
    pub program: Program,
    pub sender: mpsc::Sender<()>,
    pub in_flight: bool,
    pub last_started: Option<u64>,
}

pub(crate) struct Runtime {
    state: Arc<Mutex<State>>,
    stop: watch::Sender<bool>,
    tasks: tokio::task::JoinSet<()>,
}
impl Runtime {
    pub fn start(state: Arc<Mutex<State>>) -> Self {
        let (stop, _) = watch::channel(false);
        let mut tasks = tokio::task::JoinSet::new();
        let claude = state.lock().unwrap().quota_reader(Program::Claude);
        if let Some((_command, _cwd, mut refresh)) = claude {
            state.lock().unwrap().quota_gate.register(
                Program::Claude,
                "claudeStatusline",
                crate::event_log::monotonic_millis(),
            );
            let mut stopped = stop.subscribe();
            let state = state.clone();
            tasks.spawn(async move {
                let mut timer = tokio::time::interval(Duration::from_millis(
                    crate::quota_gate::CLAUDE_READ_INTERVAL_MS,
                ));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let account_paths = crate::quota_gate::claude_account_paths();
                let mut revision = 0u64;
                loop {
                    tokio::select! {
                        biased;
                        _ = stopped.changed() => break,
                        _ = timer.tick() => {},
                        requested = refresh.recv() => if requested.is_none() { break; },
                    }
                    let started = {
                        let mut state = state.lock().unwrap();
                        let started = state.quota_read_started(Program::Claude);
                        if started {
                            let _ = refresh.try_recv();
                        }
                        started
                    };
                    if !started {
                        if *stopped.borrow() {
                            break;
                        }
                        continue;
                    }
                    let start = crate::event_log::monotonic_millis();
                    let observation = crate::usage::read_claude_observation().await;
                    let account = crate::quota_gate::read_claude_account(&account_paths).await;
                    let finish = crate::event_log::monotonic_millis();
                    revision += 1;
                    let log = {
                        let mut state = state.lock().unwrap();
                        let fingerprint = account.map(|(id, organization)| {
                            state.quota_gate.fingerprint(&[&id, &organization])
                        });
                        let admission = crate::quota_gate::claude_admission(
                            &observation,
                            fingerprint,
                            revision,
                            start,
                        );
                        state.quota_gate.observe(Program::Claude, admission, finish);
                        state.observe_claude_quota(observation, start, finish);
                        state.event_log().ok()
                    };
                    if let Some(log) = log {
                        let _ = publish(&state, &log).await;
                    }
                }
            });
        }
        let codex = state.lock().unwrap().codex_readers();
        if let Some(mut refresh) = codex {
            state.lock().unwrap().quota_gate.register(
                Program::Codex,
                "codexAppServer",
                crate::event_log::monotonic_millis(),
            );
            let mut stopped = stop.subscribe();
            let state = state.clone();
            tasks.spawn(async move {
                let mut timer=tokio::time::interval(Duration::from_secs(1));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {biased; _=stopped.changed()=>break, _=timer.tick()=>{}, request=refresh.recv()=>if request.is_none(){break;}}
                    let read=state.lock().unwrap().next_quota_context();
                    if let Some(read)=read {
                        let observation=crate::usage::read_codex_in_context(&read.spec.command,&read.spec.directory,read.spec.home.as_deref()).await;
                        state.lock().unwrap().finish_quota_context(&read.id,observation);
                    }
                    let log=state.lock().unwrap().event_log().ok();
                    if let Some(log)=log {let _=publish(&state,&log).await;}
                }
            });
        }
        Self { state, stop, tasks }
    }
    pub fn request_shutdown(&self) {
        let _ = self.stop.send(true);
        if let Ok(mut state) = self.state.lock() {
            state.quota_gate.close();
        }
    }
    pub async fn shutdown(mut self) -> bool {
        self.request_shutdown();
        let drained = tokio::time::timeout(Duration::from_secs(11), async {
            let mut healthy = true;
            while let Some(task) = self.tasks.join_next().await {
                healthy &= task.is_ok();
            }
            healthy
        })
        .await;
        match drained {
            Ok(healthy) => healthy,
            Err(_) => {
                self.tasks.abort_all();
                false
            }
        }
    }
}

pub(crate) async fn publish(state: &Arc<Mutex<State>>, log: &crate::event_log::Service) -> bool {
    let observations = state.lock().unwrap().take_quota_observations();
    let mut complete = true;
    for observation in observations {
        if log
            .jobs(crate::job_definitions::Work::QuotaObserved {
                observation: observation.clone(),
            })
            .await
            .is_err()
        {
            state.lock().unwrap().retain_quota_observation(observation);
            complete = false;
        }
    }
    complete
}
