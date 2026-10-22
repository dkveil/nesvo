use super::{Program, PtyEvent, State};
use crate::{
    api_error::Error,
    event_log::model::HibernationTrigger,
    hibernation::{IdlePolicy, Outcome, Record, Work, refuse},
    restore,
    resume::{Target, Verification},
    status::{StatusState, now_millis},
};
use anyhow::{Result, anyhow};
use std::collections::HashSet;
use tokio::sync::mpsc;

const PROBE: &str = "Hibernation readiness probe";
const FAILURE_CHARS: usize = 256;
const IDLE_BATCH: usize = 4;

impl State {
    pub(crate) fn hibernation_idle_policy(&self) -> IdlePolicy {
        self.hibernated.idle
    }

    pub(crate) fn set_hibernation_idle_policy(&mut self, policy: IdlePolicy) {
        self.hibernated.idle = policy;
    }

    fn shutdown_quiescence(&self, id: &str) -> Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        if !session.info.running {
            return Err(Error::new("process_exited", "Process has exited").into());
        }
        if session.hibernating.is_some() {
            return Err(Error::new(
                "session_hibernating",
                "The session is being hibernated; no prompt was queued",
            )
            .into());
        }
        if session.pending_input.is_some() {
            return Err(Error::new(
                "submission_pending",
                "A previous submission still needs correlation or reconciliation",
            )
            .into());
        }
        if !matches!(
            session.status.status().state,
            StatusState::Idle | StatusState::Done
        ) || session.readiness.snapshot().phase != crate::readiness::Phase::Ready
        {
            return Err(Error::new(
                "agent_not_ready",
                "Agent must be ready and observably idle before hibernation",
            )
            .into());
        }
        Ok(())
    }

    fn hibernation_refusal(&self, id: &str, trigger: HibernationTrigger) -> Result<Target> {
        let Some(session) = self.sessions.get(id) else {
            return Err(if self.hibernated.contains(id) {
                refuse("session_hibernated", "Session is already hibernated")
            } else {
                Error::new("session_not_found", "Session no longer exists").into()
            });
        };
        let program = session.info.program;
        if crate::resume::unsupported_reason(program).is_some() {
            return Err(refuse(
                "hibernate_unsupported",
                "This program has no verified exact conversation resume, so it cannot be hibernated",
            ));
        }
        if !self.lifecycle_hooks_available(program) {
            return Err(refuse(
                "resume_unverifiable",
                "Lifecycle hooks for this provider are unavailable, so a later resume could not be verified",
            ));
        }
        if let Some(gate) = &session.resume {
            if gate.pending() {
                return Err(refuse(
                    "resume_pending",
                    "The session's own resume is not verified yet",
                ));
            }
            if !gate.verified() {
                return Err(refuse(
                    "resume_unverifiable",
                    "The session's current conversation was never verified",
                ));
            }
        }
        let target =
            Target::observed(program, session.conversation_identity.as_ref()).ok_or_else(|| {
                refuse(
                    "resume_unavailable",
                    "No provider conversation ID has been observed for this session",
                )
            })?;
        if trigger == HibernationTrigger::Shutdown {
            self.shutdown_quiescence(id)?;
        } else {
            self.check_submission(id, PROBE, &crate::caller::Authority::Owner)?;
        }
        let children = self
            .sessions
            .values()
            .any(|other| other.info.running && other.info.parent_session_id.as_deref() == Some(id));
        if children || session.program_status.blocked_children() > 0 {
            return Err(refuse(
                "children_active",
                "Child sessions or programs of this session are still active",
            ));
        }
        if session.quota_wake.is_some() || session.wake_at.is_some() {
            return Err(refuse(
                "wake_armed",
                "A wake is armed for this session; disable it first",
            ));
        }
        if session.caller_context.as_ref().is_some_and(|context| {
            context.configuration(session.harness_enabled)["nativePermissions"]["source"]
                == "ownerChildPolicy"
        }) {
            return Err(refuse(
                "permission_unrestorable",
                "This session's native tool grant was delegated by a coordinator and could not be restored on resume",
            ));
        }
        Ok(target)
    }

    fn hibernation_record(
        &self,
        id: &str,
        target: Target,
        trigger: HibernationTrigger,
    ) -> Result<Record> {
        let session = &self.sessions[id];
        self.persist_session(session)?;
        let saved = self
            .metadata
            .recoveries()?
            .into_iter()
            .find(|record| record["id"] == id)
            .ok_or_else(|| anyhow!("The saved launch description is missing"))?;
        let mut spec: crate::jobs::LaunchSpec = serde_json::from_value(saved["spec"].clone())?;
        spec.resume = Some(target);
        if let Some(context) = &session.caller_context {
            let configuration = context.configuration(session.harness_enabled);
            let tools = |value: &serde_json::Value| -> Vec<String> {
                value
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            if configuration["nativePermissions"]["source"] == "ownerLaunch" {
                spec.allowed_nesvo_tools =
                    Some(tools(&configuration["nativePermissions"]["allow"]));
            }
            let children = tools(&configuration["childToolPolicy"]["allow"]);
            if !children.is_empty() {
                spec.child_allowed_nesvo_tools = Some(children);
            }
        }
        let snapshot = self.baseline_with_candidate(None, None)["sessions"]
            .as_array()
            .and_then(|sessions| sessions.iter().find(|view| view["id"] == id))
            .cloned()
            .ok_or_else(|| anyhow!("The session snapshot is unavailable"))?;
        Ok(Record {
            session_id: id.to_owned(),
            spec,
            snapshot,
            hibernated_at: now_millis(),
            trigger,
            last_resume_failure: None,
            attention_revision: session.attention.revision(),
        })
    }

    pub(crate) fn prepare_hibernation(
        &mut self,
        id: &str,
        key: &str,
        trigger: HibernationTrigger,
    ) -> Result<Record> {
        let target = self.hibernation_refusal(id, trigger)?;
        let record = self.hibernation_record(id, target, trigger)?;
        if let Some(session) = self.sessions.get_mut(id) {
            session.hibernating = Some(key.to_owned());
        }
        Ok(record)
    }

    pub(crate) fn release_hibernation(&mut self, id: &str, key: &str) {
        if let Some(session) = self.sessions.get_mut(id)
            && session.hibernating.as_deref() == Some(key)
        {
            session.hibernating = None;
        }
    }

    pub(crate) fn complete_hibernation(
        &mut self,
        id: &str,
        key: &str,
        trigger: HibernationTrigger,
    ) -> Result<Record> {
        let Some(session) = self.sessions.get_mut(id) else {
            return Err(Error::new("session_not_found", "Session no longer exists").into());
        };
        if session.hibernating.as_deref() != Some(key) {
            return Err(refuse(
                "busy",
                "Another hibernation operation owns this session",
            ));
        }
        session.hibernating = None;
        let target = self.hibernation_refusal(id, trigger)?;
        let record = self.hibernation_record(id, target, trigger)?;
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("Session disappeared during hibernation"))?;
        if session.info.running && session.kill().is_err() {
            return Err(refuse(
                "hibernate_failed",
                "The provider process could not be stopped; the session keeps running",
            ));
        }
        let removed = self.sessions.remove(id);
        self.repository.remove(id);
        self.repository_notify();
        self.cleanup_workers.retain(|worker| !worker.is_finished());
        self.cleanup_workers
            .push(std::thread::spawn(move || drop(removed)));
        self.hibernated.insert(record.clone());
        self.broadcast_list();
        Ok(record)
    }

    pub(crate) fn check_resumable(&self, id: &str) -> Result<()> {
        if self.shutting_down {
            return Err(Error::new("host_stopping", "Host is shutting down").into());
        }
        if self.hibernated.resuming(id) {
            return Err(refuse("busy", "This session is already resuming"));
        }
        let Some(record) = self.hibernated.get(id) else {
            return Err(if self.sessions.contains_key(id) {
                refuse("session_not_hibernated", "Session is not hibernated")
            } else {
                Error::new("session_not_found", "Session no longer exists").into()
            });
        };
        let program = record.program();
        if crate::resume::unsupported_reason(program).is_some() {
            return Err(refuse(
                "hibernate_unsupported",
                "This provider has no verified exact conversation resume",
            ));
        }
        let target = record.spec.resume.as_ref().ok_or_else(|| {
            refuse(
                "resume_unverifiable",
                "The hibernated session has no recorded conversation",
            )
        })?;
        if crate::resume::check_target(program, target).is_err()
            || !self.lifecycle_hooks_available(program)
        {
            return Err(refuse(
                "resume_unverifiable",
                "The provider cannot prove the recorded conversation here; the session stays hibernated and can be relaunched fresh",
            ));
        }
        Ok(())
    }

    pub(crate) fn relaunch_hibernated(
        &mut self,
        id: &str,
        events: &mpsc::Sender<PtyEvent>,
    ) -> Result<()> {
        self.check_resumable(id)?;
        let record = self
            .hibernated
            .begin_resume(id)
            .ok_or_else(|| anyhow!("Session is not hibernated"))?;
        let mut spec = record.spec.clone();
        spec.prompt.clear();
        spec.worktree = false;
        spec.resume_picker = false;
        if spec
            .group_id
            .as_ref()
            .is_some_and(|group| !self.metadata.contains(group))
        {
            spec.group_id = None;
        }
        match self.resume_reserved(&spec, events, id) {
            Ok(_) => {
                let acknowledged =
                    crate::attention_inbox::session_receipt(&self.metadata.connection, id);
                if let Some(session) = self.sessions.get_mut(id) {
                    session.attention.restore(
                        &record.snapshot,
                        record.attention_revision,
                        acknowledged,
                    );
                }
                if let Err(error) = self.metadata.finish_recovery(id, false) {
                    eprintln!("Could not keep the saved launch description: {error}");
                }
                self.broadcast_list();
                Ok(())
            }
            Err(error) => {
                self.hibernated.cancel_resume(id);
                self.broadcast_list();
                Err(error)
            }
        }
    }

    pub(crate) fn resume_outcome(&self, id: &str) -> Outcome {
        let Some(session) = self.sessions.get(id) else {
            return Outcome::Closed;
        };
        match session.resume.as_ref().map(|gate| gate.verification()) {
            Some(Verification::Pending { .. }) => Outcome::Pending,
            Some(Verification::Verified { .. }) => Outcome::Verified,
            Some(Verification::ResumeFailed { reason, .. }) => Outcome::Failed(reason.clone()),
            None => Outcome::Failed("The relaunched process has no resume verification".into()),
        }
    }

    pub(crate) fn finish_resume(&mut self, id: &str) -> Result<Record> {
        let record = self
            .hibernated
            .take_resuming(id)
            .ok_or_else(|| anyhow!("Session is not resuming"))?;
        self.broadcast_list();
        Ok(record)
    }

    pub(crate) fn rehibernate(&mut self, id: &str, reason: &str) -> Result<Record> {
        let mut record = self
            .hibernated
            .take_resuming(id)
            .ok_or_else(|| anyhow!("Session is not resuming"))?;
        record.last_resume_failure = Some(reason.chars().take(FAILURE_CHARS).collect());
        if let Some(mut session) = self.sessions.remove(id) {
            if session.info.running {
                let _ = session.kill();
            }
            if let Some(pending) = session.pending_input.take() {
                pending.canceled.send_replace(true);
            }
            self.repository.remove(id);
            self.repository_notify();
            self.cleanup_workers.retain(|worker| !worker.is_finished());
            self.cleanup_workers
                .push(std::thread::spawn(move || drop(session)));
            self.hibernated.insert(record.clone());
        }
        self.broadcast_list();
        Ok(record)
    }

    pub(crate) fn install_hibernated(&mut self, records: Vec<Record>) -> Vec<String> {
        let saved: Option<HashSet<String>> = self.metadata.recoveries().ok().map(|records| {
            records
                .iter()
                .filter_map(|record| record["id"].as_str().map(str::to_owned))
                .collect()
        });
        let mut discarded = Vec::new();
        for record in records {
            let kept = saved
                .as_ref()
                .is_none_or(|saved| saved.contains(&record.session_id))
                && !self.sessions.contains_key(&record.session_id);
            if kept {
                self.hibernated.insert(record);
            } else {
                discarded.push(record.session_id);
            }
        }
        self.broadcast_list();
        discarded
    }

    pub(crate) fn discard_hibernated(&mut self, id: &str) {
        if self.hibernated.remove(id).is_none() {
            return;
        }
        if let (Some(log), Ok(runtime)) = (
            self.event_log.clone(),
            tokio::runtime::Handle::try_current(),
        ) {
            let ids = vec![id.to_owned()];
            runtime.spawn(async move {
                let _ = log.hibernation(Work::Discard(ids)).await;
            });
        }
        self.broadcast_list();
    }

    pub(crate) fn close_hibernated(&mut self, id: &str) -> Result<()> {
        self.metadata.finish_recovery(id, true)?;
        self.discard_hibernated(id);
        self.emit(
            Some(id),
            crate::event_log::DomainEvent::SessionClosed(crate::event_log::model::SessionClosed {}),
        );
        self.broadcast_list();
        Ok(())
    }

    pub(crate) fn idle_hibernation_candidates(&self, now: u64) -> Vec<(String, u64)> {
        let policy = self.hibernated.idle;
        if !policy.enabled() || self.shutting_down {
            return Vec::new();
        }
        let mut due: Vec<(String, u64)> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.subscribers.is_empty()
                    && session.info.program != Program::Shell
                    && matches!(
                        session.status.status().state,
                        StatusState::Idle | StatusState::Done
                    )
                    && policy.due(session.status.status().updated_at, now)
            })
            .filter(|(id, _)| {
                self.hibernation_refusal(id, HibernationTrigger::IdlePolicy)
                    .is_ok()
            })
            .map(|(id, session)| (id.clone(), session.status.status().updated_at))
            .collect();
        due.sort();
        due.truncate(IDLE_BATCH);
        due
    }

    fn lineage_depth(&self, id: &str) -> usize {
        let mut depth = 0;
        let mut current = id;
        while let Some(parent) = self
            .sessions
            .get(current)
            .and_then(|session| session.info.parent_session_id.as_deref())
            .filter(|parent| self.sessions.contains_key(*parent))
        {
            depth += 1;
            if depth > self.sessions.len() {
                break;
            }
            current = parent;
        }
        depth
    }

    pub(crate) fn shutdown_plan(&self, at: u64) -> (Vec<String>, Vec<restore::Entry>) {
        let mut order: Vec<(usize, String)> = self
            .sessions
            .keys()
            .filter(|id| !self.hibernated.resuming(id))
            .map(|id| (self.lineage_depth(id), id.clone()))
            .collect();
        order.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        let mut kept: Vec<restore::Entry> = self
            .hibernated
            .records()
            .map(|record| {
                let code = match record.trigger {
                    HibernationTrigger::Owner => "owner_hibernated",
                    HibernationTrigger::IdlePolicy => "idle_hibernated",
                    HibernationTrigger::Shutdown => "shutdown_hibernated",
                };
                restore::Entry::new(
                    record.session_id.clone(),
                    restore::Outcome::Hibernated,
                    Some(code),
                    record.last_resume_failure.as_deref(),
                    at,
                )
            })
            .collect();
        kept.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        (order.into_iter().map(|(_, id)| id).collect(), kept)
    }

    pub(crate) fn hibernated_program(&self, id: &str) -> Option<Program> {
        self.hibernated.get(id).map(Record::program)
    }

    pub(crate) fn is_hibernated(&self, id: &str) -> bool {
        self.hibernated.contains(id) || self.hibernated.resuming(id)
    }

    pub(crate) fn restore_outcome(&self, id: &str) -> restore::Outcome {
        if self.is_hibernated(id) {
            restore::Outcome::Hibernated
        } else if self.sessions.contains_key(id) {
            restore::Outcome::Restored
        } else {
            restore::Outcome::Reaped
        }
    }

    pub(crate) fn set_restore_policy(&mut self, policy: restore::Policy) {
        self.hibernated.restore_policy = policy;
    }

    pub(crate) fn install_restore_report(
        &mut self,
        entries: Vec<restore::Entry>,
    ) -> restore::Policy {
        self.hibernated.restore.replace(entries);
        self.hibernated.restore_policy
    }

    pub(crate) fn settle_restore(&mut self, entry: restore::Entry) {
        self.hibernated.restore.settle(entry);
    }

    pub(crate) fn restore_report(&self) -> serde_json::Value {
        self.hibernated.restore.view(self.hibernated.restore_policy)
    }
}

#[cfg(test)]
#[path = "hibernation_tests.rs"]
mod tests;
