//! Live process fences for an explicitly armed one-shot quota continuation.
use super::{
    Program, Session, State,
    session_quota::{LaunchBinding, Release},
};
use crate::{api_error::Error, quota_wakes::Arm};
use anyhow::Result;

fn target(session: &Session, arm: &Arm) -> Result<()> {
    if crate::event_log::monotonic_millis() > arm.proof.reset_elapsed_ms.saturating_add(300_000) {
        return Err(Error::new("quota_wake_expired", "Quota wake grace window expired").into());
    }
    if !session.info.running || session.info.program != Program::Codex {
        return Err(Error::new("process_exited", "Quota wake target is no longer running").into());
    }
    if session.human_control_epoch != arm.human_epoch
        || session.controller.is_some()
        || session.human_input_dirty
    {
        return Err(Error::new(
            "control_busy",
            "Human control superseded the armed quota wake",
        )
        .into());
    }
    if session.wake_at.is_none()
        || session
            .quota_wake
            .as_ref()
            .is_none_or(|current| current.id != arm.id)
    {
        return Err(Error::new("quota_wake_disarmed", "The quota wake has been disarmed").into());
    }
    if session.conversation_identity.as_ref().is_none_or(|id| {
        id.launch_id != arm.launch_id
            || id.generation != arm.generation
            || id.provider_session_id.is_none()
    }) || session.lifecycle_gap
    {
        return Err(Error::new(
            "conversation_changed",
            "Quota wake conversation evidence changed or is incomplete",
        )
        .into());
    }
    Ok(())
}

fn blocked(session: &Session) -> bool {
    session.status.quota_resume_editor(false)
        && session.status.status().state == crate::status::StatusState::Blocked
}
impl State {
    pub(crate) fn prepare_quota_wake(&mut self, client: u64, id: &str) -> Result<Arm> {
        if self.shutting_down {
            return Err(Error::new("host_stopping", "Host is shutting down").into());
        }
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        if !session.info.running || session.info.program != Program::Codex {
            return Err(Error::new(
                "unsupported",
                "Configured quota wake currently requires a running native Codex session",
            )
            .into());
        }
        if session
            .controller
            .as_ref()
            .is_some_and(|lease| lease.client_id != client)
            || session.human_input_dirty
        {
            return Err(Error::new(
                "control_busy",
                "Reconcile human input before arming quota wake",
            )
            .into());
        }
        if let Some(arm) = &session.quota_wake
            && session.wake_at.is_some()
        {
            return Ok(arm.clone());
        }
        let identity = session
            .conversation_identity
            .as_ref()
            .filter(|id| id.provider_session_id.is_some() && id.prompt_correlation)
            .ok_or_else(|| {
                Error::new(
                    "unsupported",
                    "Quota wake requires bound lifecycle and prompt correlation",
                )
            })?;
        let binding = session.quota_binding.as_ref().ok_or_else(|| {
            Error::new("unsupported", "Native launch quota context is unavailable")
        })?;
        let reader = self.quota_contexts.register(binding.reader_spec(), false)?;
        let now = crate::status::now_millis();
        let elapsed = crate::event_log::monotonic_millis();
        let proof = match binding.arm(&mut self.quota_contexts, &reader, now, elapsed) {
            Ok(proof) => proof,
            Err(error) => {
                let _ = self.quota_contexts.request(&reader, now, elapsed);
                if let Some(wake) = &self.quota_wakeup {
                    let _ = wake.try_send(());
                }
                return Err(error);
            }
        };
        let arm = Arm {
            id: hex::encode(crate::wire::random::<16>()),
            session_id: id.into(),
            launch_id: identity.launch_id.clone(),
            generation: identity.generation,
            human_epoch: session.human_control_epoch,
            predecessor_id: session
                .pending_input
                .as_ref()
                .map(|pending| pending.claim.id.clone()),
            proof,
        };
        let session = self
            .sessions
            .get_mut(id)
            .expect("Validated session retained under State lock");
        session.wake_at = Some(arm.proof.reset_at);
        session.quota_wake = Some(arm.clone());
        Ok(arm)
    }
    pub(crate) fn disarm_quota_wake(&mut self, id: &str) {
        if let Some(session) = self.sessions.get_mut(id) {
            session.wake_at = None;
        }
        self.broadcast_list();
    }
    pub(crate) fn disarm_exact_quota_wake(&mut self, arm: &Arm) {
        if self
            .sessions
            .get(&arm.session_id)
            .and_then(|s| s.quota_wake.as_ref())
            .is_some_and(|current| current.id == arm.id)
        {
            self.disarm_quota_wake(&arm.session_id);
        }
    }
    pub(crate) fn quota_wake_ready(&mut self, arm: &Arm) -> Result<bool> {
        if self.shutting_down {
            return Err(Error::new("host_stopping", "Host is shutting down").into());
        }
        let session = self
            .sessions
            .get_mut(&arm.session_id)
            .ok_or_else(|| Error::new("session_not_found", "Session no longer exists"))?;
        target(session, arm)?;
        session.status_projection_dirty |= session.status.refresh(crate::status::now_millis());
        let now = crate::status::now_millis();
        let elapsed = crate::event_log::monotonic_millis();
        if elapsed > arm.proof.reset_elapsed_ms.saturating_add(300_000) {
            return Err(Error::new(
                "quota_wake_expired",
                "Quota wake grace window expired; rearm deliberately",
            )
            .into());
        }
        let binding = session
            .quota_binding
            .as_ref()
            .ok_or_else(|| Error::new("unsupported", "Native quota context is unavailable"))?;
        match binding.release(&mut self.quota_contexts, &arm.proof, now, elapsed) {
            Release::Ready { .. } => {}
            Release::Hold(_) => return Ok(false),
            Release::Disarm(reason) => {
                return Err(Error::new("quota_context_changed", reason).into());
            }
        }
        if !blocked(session) {
            return Ok(false);
        }
        if session.pending_input.is_none() && arm.predecessor_id.is_some() {
            return Err(Error::new(
                "original_submission_closed",
                "The armed original submission has already ended",
            )
            .into());
        }
        if let Some(pending) = &session.pending_input
            && (Some(&pending.claim.id) != arm.predecessor_id.as_ref()
                || pending.correlation.as_ref().is_none_or(|correlation| {
                    !correlation.can_resume_after_quota(
                        session
                            .conversation_identity
                            .as_ref()
                            .expect("Bound identity checked"),
                    )
                }))
        {
            return Err(Error::new(
                "submission_pending",
                "Original input requires reconciliation before quota continuation",
            )
            .into());
        }
        Ok(true)
    }
    pub(crate) fn begin_quota_submission(
        &mut self,
        arm: &Arm,
        claim: crate::submission::Claim,
        prompt: &str,
    ) -> Result<(
        Option<std::path::PathBuf>,
        tokio::sync::watch::Receiver<bool>,
    )> {
        if !self.quota_wake_ready(arm)? {
            return Err(Error::new(
                "quota_wait",
                "Fresh matching post-reset quota evidence is required",
            )
            .into());
        }
        let session = self
            .sessions
            .get_mut(&arm.session_id)
            .expect("Validated quota target");
        if let Some(predecessor) = session.pending_input.take() {
            let _ = predecessor.canceled.send(true);
            // Keep original correlation until the provider confirms pickup of
            // the new prompt. Never invent a lifecycle source sequence.
            session.quota_predecessor = Some(predecessor);
        }
        let digest = crate::submission::digest(prompt)
            .ok_or_else(|| Error::new("invalid_argument", "Invalid quota continuation prompt"))?;
        let (canceled, receiver) = tokio::sync::watch::channel(false);
        session.pending_input = Some(crate::submission::Pending {
            authority: crate::caller::Authority::Owner,
            claim,
            canceled,
            correlation: None,
            digest,
            source: None,
            queued: false,
            reconciliation_queued: false,
            quota_sequence: None,
            quota_semantic_revision: Some(session.status.semantic_revision()),
            quota_resume: Some(arm.clone()),
        });
        session
            .pending_input
            .as_mut()
            .expect("Quota input installed")
            .quota_sequence = Some(session.lifecycle_cursor);
        Ok((
            session
                .agent_context
                .as_ref()
                .map(|tracker| tracker.report()),
            receiver,
        ))
    }
    // Called immediately before both native queue writes; ordinary send readiness is unchanged.
    pub(crate) fn guard_quota_submission(&mut self, id: &str, operation: &str) -> Result<bool> {
        let Some(arm) = self
            .sessions
            .get(id)
            .and_then(|s| s.pending_input.as_ref())
            .filter(|p| p.claim.id == operation)
            .and_then(|p| p.quota_resume.clone())
        else {
            return Ok(false);
        };
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| Error::new("session_not_found", "Quota target is unavailable"))?;
        target(session, &arm)?;
        session.status_projection_dirty |= session.status.refresh(crate::status::now_millis());
        let pending = session
            .pending_input
            .as_ref()
            .expect("Quota submission retained");
        // A paste can change I/O activity, but never authorizes a semantic change of state.
        let after_paste = pending.queued;
        if pending.quota_sequence != Some(session.lifecycle_cursor)
            || pending.quota_semantic_revision != Some(session.status.semantic_revision())
            || !session.status.quota_resume_editor(after_paste)
        {
            return Err(Error::new(
                "agent_not_ready",
                "Quota block changed before continuation input",
            )
            .into());
        }
        let binding: &LaunchBinding = session
            .quota_binding
            .as_ref()
            .ok_or_else(|| Error::new("unsupported", "Quota context is unavailable"))?;
        match binding.release(
            &mut self.quota_contexts,
            &arm.proof,
            crate::status::now_millis(),
            crate::event_log::monotonic_millis(),
        ) {
            Release::Ready { .. } => Ok(true),
            _ => {
                Err(Error::new("quota_wait", "Quota permission changed before native input").into())
            }
        }
    }
}

#[cfg(test)]
#[path = "quota_wake_session_tests.rs"]
mod tests;
