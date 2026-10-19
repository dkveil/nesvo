//! Bounded host receipt → snapshot enqueue latency. Provider emission is excluded.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const RETENTION: usize = 256;
#[derive(Default)]
pub struct Tracker {
    pending: Option<(Instant, u64)>,
    samples: VecDeque<Sample>,
}
struct Sample {
    micros: u64,
    events: u64,
    recipients: usize,
}
impl Tracker {
    pub fn received(&mut self, now: Instant) {
        let (_, events) = self.pending.get_or_insert((now, 0));
        *events = events.saturating_add(1);
    }
    pub fn published(&mut self, now: Instant, recipients: usize) {
        let Some((at, events)) = self.pending.take() else {
            return;
        };
        self.record(now.saturating_duration_since(at), events, recipients);
    }
    fn record(&mut self, elapsed: Duration, events: u64, recipients: usize) {
        if self.samples.len() == RETENTION {
            self.samples.pop_front();
        }
        self.samples.push_back(Sample {
            micros: elapsed.as_micros().min(u128::from(u64::MAX)) as u64,
            events,
            recipients,
        });
    }
    pub fn snapshot(&self) -> Value {
        let mut connected: Vec<_> = self
            .samples
            .iter()
            .filter(|s| s.recipients > 0)
            .map(|s| s.micros)
            .collect();
        connected.sort_unstable();
        let percentile = connected.get((connected.len() * 95).div_ceil(100).saturating_sub(1));
        json!({"scope":"hostReceiptToSnapshotEnqueue","retention":RETENTION,"batches":self.samples.len(),"events":self.samples.iter().map(|s|s.events).sum::<u64>(),"connectedBatches":connected.len(),"p95Ms":percentile.map(|v| *v as f64/1000.0),"maxMs":connected.last().map(|v| *v as f64/1000.0),"pending":self.pending.is_some()})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalescing_keeps_oldest_receipt_and_does_not_count_replay_or_reads() {
        let now = Instant::now();
        let mut tracker = Tracker::default();
        tracker.published(now, 1);
        assert_eq!(tracker.snapshot()["batches"], 0);
        tracker.received(now);
        tracker.received(now + Duration::from_millis(50));
        tracker.published(now + Duration::from_millis(250), 1);
        assert_eq!(tracker.snapshot()["p95Ms"], 250.0);
        assert_eq!(tracker.snapshot()["events"], 2);
        tracker.received(now);
        tracker.published(now + Duration::from_secs(50), 0);
        assert_eq!(
            tracker.snapshot()["p95Ms"],
            250.0,
            "no-client samples do not masquerade as delivery"
        );
        for i in 1..=300 {
            tracker.record(Duration::from_millis(i), 1, 1);
        }
        let snapshot = tracker.snapshot();
        assert_eq!(snapshot["batches"], 256);
        assert_eq!(snapshot["p95Ms"], 288.0);
        assert_eq!(snapshot["events"], 256);
    }
}
