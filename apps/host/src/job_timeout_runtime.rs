//! Execution-limit supervision is independent of dispatch and precheck capacity.
use crate::{
    event_log::{Service, monotonic_millis},
    job_definitions::{Reply, Work},
    job_timeouts::Claim,
    sessions::State,
};
use futures_util::FutureExt;
use std::{
    future::pending,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{task::JoinSet, time::Instant};

const CAPACITY: usize = 2;
const CONTROL_BOUND: Duration = Duration::from_secs(10);
const OBSERVATION_INTERVAL: Duration = Duration::from_secs(1);
const COALESCE: Duration = Duration::from_millis(50);

/// Only the retained result is retried after a storage error. The native effect
/// future has already ended and is never reconstructed by this finalizer.
async fn retain_result(log: &Service, claim: Claim, result: Option<serde_json::Value>) {
    let mut delay = Duration::from_secs(1);
    loop {
        match log
            .jobs(Work::TimeoutFinished {
                claim: claim.clone(),
                result: result.clone(),
            })
            .await
        {
            Ok(Reply::Done) => return,
            Err(error)
                if error
                    .downcast_ref::<crate::api_error::Error>()
                    .is_some_and(|error| error.code == "stale_job_timeout") =>
            {
                return;
            }
            _ if log.is_closed() => return,
            _ => {
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(5));
            }
        }
    }
}

async fn dispatch(state: Arc<Mutex<State>>, log: Service, claim: Claim) {
    let work = crate::workflow_control_runtime::timeout_job(state, log.clone(), claim.clone());
    // Dropping an overdue producer creates uncertainty; it never creates another
    // native dispatch claim. Even a panic retains the original timeout identity.
    let result = std::panic::AssertUnwindSafe(tokio::time::timeout(CONTROL_BOUND, work))
        .catch_unwind()
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok);
    retain_result(&log, claim, result).await;
}

fn observation_delay(next: Option<u64>, elapsed: u64, observing: bool) -> Option<Duration> {
    let deadline = next.map(|at| Duration::from_millis(at.saturating_sub(elapsed)));
    match (deadline, observing) {
        (Some(delay), true) => Some(delay.min(OBSERVATION_INTERVAL)),
        (Some(delay), false) => Some(delay),
        (None, true) => Some(OBSERVATION_INTERVAL),
        (None, false) => None,
    }
}

async fn wait_until(next: Option<Instant>) {
    match next {
        Some(at) => tokio::time::sleep_until(at).await,
        None => pending().await,
    }
}

pub async fn run(state: Arc<Mutex<State>>, log: Service) {
    let mut changed = log.subscribe();
    let mut dispatches = JoinSet::new();
    let mut next_poll = Instant::now();
    let mut backoff = Duration::from_secs(1);
    loop {
        // Coalesce journal bursts. No terminal/model heartbeat is generated.
        tokio::time::sleep_until(next_poll).await;
        if log.is_closed() {
            return;
        }
        while dispatches.try_join_next().is_some() {}
        // Consume observations BEFORE reading, so a concurrent new deadline
        // cannot disappear between the journal snapshot and our next wait.
        changed.borrow_and_update();
        let schedule = match log
            .jobs(Work::TimeoutPoll {
                slots: CAPACITY.saturating_sub(dispatches.len()) as u8,
            })
            .await
        {
            Ok(Reply::Timeouts(schedule)) => {
                backoff = Duration::from_secs(1);
                schedule
            }
            _ if log.is_closed() => return,
            _ => {
                // A failed read may itself update health. Ignore that wake until
                // bounded backoff; unavailable storage never authorizes a stop.
                next_poll = Instant::now() + backoff;
                backoff = (backoff * 2).min(Duration::from_secs(5));
                continue;
            }
        };
        let now = monotonic_millis();
        let next = observation_delay(schedule.next_deadline_monotonic_ms, now, schedule.observing)
            .map(|delay| Instant::now() + delay);
        for claim in schedule.claims {
            dispatches.spawn(dispatch(state.clone(), log.clone(), claim));
        }
        next_poll = Instant::now() + COALESCE;
        // With no armed/cleanup record this sleeps on journal changes only.
        // Native control futures remain independently polled in their JoinSet.
        tokio::select! {
            _ = wait_until(next) => {},
            result = changed.changed() => { if result.is_err() { return; } },
            _ = dispatches.join_next(), if !dispatches.is_empty() => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_supervision_has_no_poll_and_pending_exit_observation_is_bounded() {
        assert_eq!(observation_delay(None, 100, false), None);
        assert_eq!(
            observation_delay(None, 100, true),
            Some(OBSERVATION_INTERVAL)
        );
        assert_eq!(
            observation_delay(Some(150), 100, true),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            observation_delay(Some(5_000), 100, false),
            Some(Duration::from_millis(4_900))
        );
        assert_eq!(
            observation_delay(Some(50), 100, false),
            Some(Duration::ZERO)
        );
    }
}
