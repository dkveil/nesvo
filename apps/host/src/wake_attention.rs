use crate::event_log::{DomainEvent, Observation, Service, model::AgentAttention};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Publisher {
    published: Option<AgentAttention>,
    pending: Option<(AgentAttention, oneshot::Receiver<anyhow::Result<u64>>)>,
    retry_at: Option<Instant>,
}

impl Publisher {
    pub fn offer(
        &mut self,
        log: &Service,
        session: &str,
        payload: AgentAttention,
        at: u64,
        now: Instant,
    ) {
        if let Some((fingerprint, ack)) = &mut self.pending {
            match ack.try_recv() {
                Ok(Ok(_)) => self.published = Some(fingerprint.clone()),
                Ok(Err(_)) | Err(oneshot::error::TryRecvError::Closed) => {
                    self.retry_at = Some(now + Duration::from_secs(1))
                }
                Err(oneshot::error::TryRecvError::Empty) => return,
            }
            self.pending = None;
        }
        if self.published.as_ref() == Some(&payload) || self.retry_at.is_some_and(|at| now < at) {
            return;
        }
        match log.observe_confirmed(Observation {
            session_id: Some(session.into()),
            at,
            event: DomainEvent::AgentAttention(payload.clone()),
        }) {
            Some(ack) => {
                self.pending = Some((payload, ack));
                self.retry_at = None;
            }
            None => self.retry_at = Some(now + Duration::from_secs(1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_log::model::HostStarted;
    fn attention(priority: u8, reason: Option<&str>) -> AgentAttention {
        AgentAttention {
            priority,
            reason: reason.map(str::to_owned),
            blocked_children: 0,
            process_exited: false,
            exit_code: None,
        }
    }
    async fn barrier(log: &Service) {
        log.append(vec![Observation {
            session_id: None,
            at: 1,
            event: DomainEvent::HostStarted(HostStarted {
                build_id: "barrier".into(),
            }),
        }])
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn unchanged_attention_is_quiet_and_new_state_waits_for_commit_ack() {
        let log = Service::open(":memory:".into()).await.unwrap();
        let now = Instant::now();
        let mut publisher = Publisher::default();
        let idle = attention(0, None);
        publisher.offer(&log, "worker", idle.clone(), 1, now);
        barrier(&log).await;
        for _ in 0..20 {
            publisher.offer(&log, "worker", idle.clone(), 2, now);
        }
        assert_eq!(
            log.read(0, 32, None)
                .await
                .unwrap()
                .events
                .iter()
                .filter(|e| e.kind == "agent.attention")
                .count(),
            1
        );
        let blocked = attention(2, Some("permission"));
        publisher.offer(&log, "worker", blocked.clone(), 3, now);
        barrier(&log).await;
        publisher.offer(&log, "worker", blocked, 4, now);
        assert_eq!(
            log.read(0, 32, None)
                .await
                .unwrap()
                .events
                .iter()
                .filter(|e| e.kind == "agent.attention")
                .count(),
            2
        );
        log.shutdown().await;
    }
    #[tokio::test]
    async fn failed_durable_ack_retries_latest_state_with_backoff_instead_of_marking_it_published()
    {
        let log = Service::open(":memory:".into()).await.unwrap();
        let now = Instant::now();
        let blocked = attention(2, Some("permission"));
        let (sender, receiver) = oneshot::channel();
        sender
            .send(Err(anyhow::anyhow!("injected commit failure")))
            .unwrap();
        let mut publisher = Publisher {
            pending: Some((blocked.clone(), receiver)),
            ..Default::default()
        };
        publisher.offer(&log, "worker", blocked.clone(), 1, now);
        publisher.offer(
            &log,
            "worker",
            blocked.clone(),
            2,
            now + Duration::from_millis(999),
        );
        assert!(log.read(0, 32, None).await.unwrap().events.is_empty());
        publisher.offer(
            &log,
            "worker",
            blocked,
            3,
            now + Duration::from_millis(1001),
        );
        barrier(&log).await;
        assert_eq!(
            log.read(0, 32, None)
                .await
                .unwrap()
                .events
                .iter()
                .filter(|e| e.kind == "agent.attention")
                .count(),
            1
        );
        log.shutdown().await;
    }
}
