//! Bounded process-local readers. A context is configuration, never a quota lease.
use crate::{
    launchers::Program,
    provider_quota::{Tracker, View},
    usage,
};
use std::{ffi::OsString, path::PathBuf};

const CAPACITY: usize = 16;
const PERIOD: u64 = 120_000;
const COOLDOWN: u64 = 5_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReaderSpec {
    pub command: (PathBuf, Vec<OsString>),
    pub directory: PathBuf,
    pub home: Option<PathBuf>,
}
impl ReaderSpec {
    pub(crate) fn normalized(mut self) -> Self {
        // Git and native validation use different Windows extended-path forms.
        // Match the exact display form also passed to the spawned CLI's cwd.
        self.directory = PathBuf::from(crate::process::display_path(&self.directory));
        self
    }
}
#[derive(Clone)]
pub(crate) struct Read {
    pub id: String,
    pub spec: ReaderSpec,
}
#[derive(Clone)]
pub(crate) struct LaunchContext {
    pub permit: crate::job_quota::Permit,
    pub derived_worktree: bool,
    pub receipt_id: String,
}
#[derive(PartialEq)]
struct Publication {
    revision: u64,
    eligible: bool,
    context_id: Option<String>,
    account_fingerprint: Option<String>,
    expires_elapsed_ms: Option<u64>,
}
struct Slot {
    id: String,
    source_id: String,
    spec: ReaderSpec,
    tracker: Tracker,
    queued: bool,
    in_flight: bool,
    last_started: Option<u64>,
    route: Option<usage::RouteObservation>,
    published: Option<Publication>,
    publication_revision: u64,
    pinned: bool,
}
struct DerivedReservation {
    receipt_id: String,
    reader_id: Option<String>,
}
pub(crate) struct Registry {
    salt: [u8; 32],
    slots: Vec<Slot>,
    cursor: usize,
    ambient: Option<String>,
    reservations: Vec<DerivedReservation>,
}
impl Registry {
    pub fn new(salt: [u8; 32]) -> Self {
        Self {
            salt,
            slots: Vec::new(),
            cursor: 0,
            ambient: None,
            reservations: Vec::new(),
        }
    }
    pub fn register(&mut self, spec: ReaderSpec, ambient: bool) -> anyhow::Result<String> {
        self.register_inner(spec, ambient, true)
    }
    pub fn transient(&mut self, spec: ReaderSpec) -> anyhow::Result<String> {
        self.register_inner(spec, false, false)
    }
    fn register_inner(
        &mut self,
        spec: ReaderSpec,
        ambient: bool,
        pinned: bool,
    ) -> anyhow::Result<String> {
        let spec = spec.normalized();
        if let Some(slot) = self.slots.iter_mut().find(|slot| slot.spec == spec) {
            slot.pinned |= pinned;
            return Ok(slot.id.clone());
        }
        if self.used_capacity() >= CAPACITY {
            return Err(crate::api_error::Error::new(
                "busy",
                "Quota reader context capacity is full; no bound context was evicted",
            )
            .into());
        }
        Ok(self.insert_slot(spec, ambient, pinned))
    }
    fn insert_slot(&mut self, spec: ReaderSpec, ambient: bool, pinned: bool) -> String {
        let id = hex::encode(nesvo_wire::random::<16>());
        self.slots.push(Slot {
            id: id.clone(),
            source_id: hex::encode(nesvo_wire::random::<16>()),
            spec,
            tracker: Tracker::new(&[Program::Codex], self.salt),
            queued: true,
            in_flight: false,
            last_started: None,
            route: None,
            published: None,
            publication_revision: 0,
            pinned,
        });
        if ambient {
            self.ambient = Some(id.clone());
        }
        id
    }
    fn used_capacity(&self) -> usize {
        self.slots.len()
            + self
                .reservations
                .iter()
                .filter(|reservation| reservation.reader_id.is_none())
                .count()
    }
    /// One live native receipt owns capacity before Git can create a directory.
    pub fn reserve_derived(&mut self, receipt: &str) -> anyhow::Result<()> {
        if receipt.len() != 32 || !receipt.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(crate::api_error::Error::new(
                "invalid_argument",
                "Invalid native receipt identity",
            )
            .into());
        }
        if self
            .reservations
            .iter()
            .any(|reservation| reservation.receipt_id == receipt)
        {
            return Ok(());
        }
        if self.used_capacity() >= CAPACITY || self.reservations.len() >= CAPACITY {
            return Err(crate::api_error::Error::new(
                "quota_wait",
                "Waiting for derived quota reader capacity before native workspace setup",
            )
            .into());
        }
        self.reservations.push(DerivedReservation {
            receipt_id: receipt.into(),
            reader_id: None,
        });
        Ok(())
    }
    /// Consume only this receipt's reserved capacity; an owner may already have
    /// registered the actual directory, in which case its pinned reader wins.
    pub fn consume_derived(&mut self, receipt: &str, spec: ReaderSpec) -> anyhow::Result<String> {
        let spec = spec.normalized();
        let index = self
            .reservations
            .iter()
            .position(|reservation| reservation.receipt_id == receipt)
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "quota_wait",
                    "The original launch has no reserved derived quota reader capacity",
                )
            })?;
        if let Some(reader) = &self.reservations[index].reader_id {
            return self
                .slots
                .iter()
                .find(|slot| slot.id == *reader && slot.spec == spec)
                .map(|slot| slot.id.clone())
                .ok_or_else(|| {
                    crate::api_error::Error::new(
                        "quota_binding_conflict",
                        "The original launch cannot adopt another prepared quota reader",
                    )
                    .into()
                });
        }
        let reader = match self.slots.iter().find(|slot| slot.spec == spec) {
            Some(slot) => slot.id.clone(),
            None => self.insert_slot(spec, false, false),
        };
        self.reservations[index].reader_id = Some(reader.clone());
        debug_assert!(self.used_capacity() <= CAPACITY);
        Ok(reader)
    }
    /// Releasing one continuation never removes another receipt's reader or a
    /// reader pinned by an owner query. Late in-flight completions are ignored.
    pub fn release_derived(&mut self, receipt: &str) {
        let Some(index) = self
            .reservations
            .iter()
            .position(|reservation| reservation.receipt_id == receipt)
        else {
            return;
        };
        let Some(reader) = self.reservations.swap_remove(index).reader_id else {
            return;
        };
        if self
            .reservations
            .iter()
            .any(|reservation| reservation.reader_id.as_deref() == Some(reader.as_str()))
        {
            return;
        }
        self.slots.retain(|slot| slot.pinned || slot.id != reader);
    }
    pub fn ambient(&self) -> Option<&str> {
        self.ambient.as_deref()
    }
    pub fn request(
        &mut self,
        id: &str,
        now: u64,
        elapsed: u64,
    ) -> anyhow::Result<serde_json::Value> {
        let slot = self
            .slots
            .iter_mut()
            .find(|slot| slot.id == id)
            .ok_or_else(|| {
                crate::api_error::Error::new(
                    "quota_context_not_found",
                    "Quota reader context is no longer registered",
                )
            })?;
        let revision = slot
            .tracker
            .view(now, elapsed)
            .first()
            .map_or(0, |view| view.revision);
        let (state, revision, delay) = if slot.in_flight {
            ("pending", revision.saturating_add(1), 0)
        } else if slot.queued {
            ("queued", revision.saturating_add(1), 0)
        } else if let Some(age) = slot
            .last_started
            .map(|at| elapsed.saturating_sub(at))
            .filter(|age| *age < COOLDOWN)
        {
            ("cooldown", revision, COOLDOWN - age)
        } else {
            slot.queued = true;
            ("queued", revision.saturating_add(1), 0)
        };
        Ok(
            serde_json::json!({"program":"codex","readerId":slot.id,"state":state,"revision":revision,"retryAfterMs":delay}),
        )
    }
    pub fn next(&mut self, elapsed: u64) -> Option<Read> {
        let count = self.slots.len();
        for offset in 0..count {
            let index = (self.cursor + offset) % count;
            let slot = &mut self.slots[index];
            let age = slot.last_started.map(|at| elapsed.saturating_sub(at));
            if slot.in_flight
                || age.is_some_and(|age| age < COOLDOWN)
                || (!slot.queued && age.is_some_and(|age| age < PERIOD))
            {
                continue;
            }
            slot.queued = false;
            slot.in_flight = true;
            slot.last_started = Some(elapsed);
            self.cursor = (index + 1) % count;
            return Some(Read {
                id: slot.id.clone(),
                spec: slot.spec.clone(),
            });
        }
        None
    }
    pub fn finish(&mut self, id: &str, observation: usage::CodexObservation) {
        if let Some(slot) = self
            .slots
            .iter_mut()
            .find(|slot| slot.id == id && slot.in_flight)
        {
            slot.route = observation
                .context
                .as_ref()
                .map(|context| context.route.clone());
            slot.tracker.apply_codex(observation);
            slot.in_flight = false;
        }
    }
    pub fn view(&mut self, id: &str, now: u64, elapsed: u64) -> Option<View> {
        self.slots
            .iter_mut()
            .find(|slot| slot.id == id)?
            .tracker
            .view(now, elapsed)
            .into_iter()
            .next()
    }
    pub fn matching_spec(&self, id: &str, spec: &ReaderSpec) -> Option<bool> {
        let spec = spec.clone().normalized();
        self.slots
            .iter()
            .find(|slot| slot.id == id)
            .map(|slot| slot.spec == spec)
    }
    pub fn read_proof(
        &mut self,
        id: &str,
        now: u64,
        elapsed: u64,
    ) -> Option<(
        crate::provider_quota::ReadProof,
        Option<usage::RouteObservation>,
    )> {
        let slot = self.slots.iter_mut().find(|slot| slot.id == id)?;
        Some((slot.tracker.read_proof(now, elapsed)?, slot.route.clone()))
    }
    pub fn public_view(&mut self, id: &str, now: u64, elapsed: u64) -> Option<serde_json::Value> {
        let view = self.view(id, now, elapsed)?;
        let mut view = serde_json::to_value(view).ok()?;
        view["readerId"] = id.into();
        Some(view)
    }
    pub fn observations(&mut self, now: u64, elapsed: u64) -> Vec<crate::job_quota::Observation> {
        self.slots
            .iter_mut()
            .filter(|slot| slot.pinned)
            .filter_map(|slot| {
                let view = slot.tracker.view(now, elapsed).into_iter().next()?;
                let route = slot.route.as_ref().is_some_and(|route| {
                    route.verdict == usage::RouteVerdict::ChatgptConfiguredOpenai
                });
                let eligible = view.ordinary_usage_eligible && route;
                let current = Publication {
                    revision: view.revision,
                    eligible,
                    context_id: view.context_id.clone(),
                    account_fingerprint: view.account_fingerprint.clone(),
                    expires_elapsed_ms: view.expires_elapsed_ms,
                };
                if slot.published.as_ref() == Some(&current) {
                    return None;
                }
                slot.published = Some(current);
                slot.publication_revision = slot.publication_revision.saturating_add(1);
                let binding = view.context_id.zip(view.account_fingerprint).map(
                    |(context_id, account_fingerprint)| crate::job_quota::Binding {
                        context_id,
                        account_fingerprint,
                    },
                );
                Some(crate::job_quota::Observation {
                    source_id: slot.source_id.clone(),
                    revision: slot.publication_revision,
                    binding,
                    expires_elapsed_ms: view.expires_elapsed_ms.unwrap_or(elapsed),
                    eligible,
                    reason: if route {
                        view.eligibility_reason
                    } else {
                        slot.route
                            .as_ref()
                            .map_or("route_unavailable", |route| route.reason)
                    }
                    .into(),
                })
            })
            .collect()
    }
    pub fn spec_for_context(
        &mut self,
        context: &str,
        now: u64,
        elapsed: u64,
    ) -> Option<ReaderSpec> {
        self.slots.iter_mut().find_map(|slot| {
            let view = slot.tracker.view(now, elapsed).into_iter().next()?;
            (view.context_id.as_deref() == Some(context)).then(|| slot.spec.clone())
        })
    }
    pub fn ready(&mut self, id: &str, account: &str, now: u64, elapsed: u64) -> bool {
        let Some(slot) = self.slots.iter_mut().find(|slot| slot.id == id) else {
            return false;
        };
        slot.route
            .as_ref()
            .is_some_and(|route| route.verdict == usage::RouteVerdict::ChatgptConfiguredOpenai)
            && slot.tracker.view(now, elapsed).into_iter().any(|view| {
                view.ordinary_usage_eligible && view.account_fingerprint.as_deref() == Some(account)
            })
    }
}
#[cfg(test)]
#[path = "quota_contexts_tests.rs"]
mod tests;
