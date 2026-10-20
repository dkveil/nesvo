//! Once-job dispatch reuses durable workflow admission and native receipt guards.
use crate::{
    caller::Authority,
    event_log::Service,
    job_definitions::{Claim, Reply, Work},
    orchestration::{Actor, Request, Scope},
    sessions::{PtyEvent, State},
};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

struct Runner {
    state: Arc<Mutex<State>>,
    events: mpsc::Sender<PtyEvent>,
    log: Service,
}
fn owner() -> Actor {
    Actor {
        issuer: "owner".into(),
        scope: Scope::Owner,
    }
}
impl Runner {
    async fn workflow(&self, request: Value) -> Result<Value> {
        self.log
            .workflow(owner(), serde_json::from_value::<Request>(request)?)
            .await
    }
    async fn dispatch(&self, claim: Claim) -> Result<()> {
        let mut native_requested = false;
        let prefix = format!("job:{}:{}", claim.job_id, claim.id);
        let result=async {
            let run=self.workflow(json!({"action":"create","key":format!("{prefix}:run"),"spec":{"title":claim.spec.title,"goal":claim.spec.instruction}})).await?;
            let run_id=run["run"]["id"].as_str().ok_or_else(||anyhow!("Job run identity was not confirmed"))?;
            self.log.jobs(Work::BindRun{occurrence:claim.id.clone(),run:run_id.into()}).await?;
            let plan=self.workflow(json!({"action":"setPlan","key":format!("{prefix}:plan"),"runId":run_id,"expectedRevision":run["run"]["revision"],"tasks":[{"key":"job","title":claim.spec.title,"instruction":claim.spec.instruction}]})).await?;
            let limits=self.workflow(json!({"action":"runBudget","request":{"action":"set","key":format!("{prefix}:budget"),"runId":run_id,"expectedRevision":plan["run"]["revision"],"limits":{"maxParallel":1,"maxAttemptsPerTask":1,"maxElapsedMs":claim.spec.max_elapsed_ms}}})).await?;
            let active=self.workflow(json!({"action":"activate","key":format!("{prefix}:activate"),"runId":run_id,"expectedRevision":limits["run"]["revision"]})).await?;
            let request=serde_json::from_value(json!({"action":"start","key":format!("{prefix}:executor"),"runId":run_id,"expectedRevision":active["run"]["revision"],"spec":{"tasks":[{"taskId":plan["tasks"][0]["id"],"profile":claim.spec.profile}],"retryFailed":false}}))?;
            native_requested=true;
            crate::workflow_executor_runtime::execute(self.state.clone(),self.events.clone(),self.log.clone(),owner(),Authority::Owner,request).await?;
            self.log.jobs(Work::Started{occurrence:claim.id.clone()}).await?;
            Ok::<_,anyhow::Error>(())
        }.await;
        if result.is_err() {
            // Never retry an unknown native effect or guess a replacement run.
            // The occurrence prefix recovers each immutable metadata acceptance.
            self.log
                .jobs(Work::Refused {
                    occurrence: claim.id,
                    uncertain: native_requested,
                })
                .await?;
        }
        result
    }
}
pub async fn run(state: Arc<Mutex<State>>, events: mpsc::Sender<PtyEvent>, log: Service) {
    let runner = Runner { state, events, log };
    let mut delay = 1;
    loop {
        let checking = match runner.state.lock() {
            Ok(state) => state.provider_probes_pending(),
            Err(_) => return,
        };
        if checking {
            // Bounded host version probes precede admission. A persisted due
            // job must not interpret transient discovery as unsupported CLI.
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        match runner.log.jobs(Work::Tick).await {
            Ok(Reply::Claims(claims)) => {
                delay = 1;
                for claim in claims {
                    // At most four durable claims per tick. The executor owns
                    // bounded provider readiness/input; no model heartbeat.
                    let _ = runner.dispatch(claim).await;
                }
            }
            _ => {
                delay = (delay * 2).min(30);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
    }
}
