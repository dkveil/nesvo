use crate::{
    api_error::Error,
    quota_contexts::{ReaderSpec, Registry},
    usage::RouteVerdict,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LaunchBinding {
    spec: ReaderSpec,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WakeProof {
    pub reader_id: String,
    pub context_id: String,
    pub account_fingerprint: String,
    pub revision: u64,
    pub read_started_elapsed_ms: u64,
    pub reset_at: i64,
    pub reset_elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Release {
    Ready {
        revision: u64,
        read_started_elapsed_ms: u64,
    },
    Hold(&'static str),
    Disarm(&'static str),
}

impl LaunchBinding {
    pub fn capture(
        command: (PathBuf, Vec<OsString>),
        directory: PathBuf,
        home: PathBuf,
    ) -> Result<Self> {
        if !command.0.is_absolute()
            || !directory.is_absolute()
            || !home.is_absolute()
            || [&command.0, &directory, &home]
                .iter()
                .any(|path| path.to_str().is_none())
        {
            return Err(Error::new("quota_binding_unavailable", "Quota wake requires the exact resolved command, directory and explicit absolute Codex home").into());
        }
        Ok(Self {
            spec: ReaderSpec {
                command,
                directory,
                home: Some(home),
            }
            .normalized(),
        })
    }

    pub fn reader_spec(&self) -> ReaderSpec {
        self.spec.clone()
    }

    pub fn arm(
        &self,
        registry: &mut Registry,
        reader_id: &str,
        now_ms: u64,
        elapsed_ms: u64,
    ) -> Result<WakeProof> {
        match registry.matching_spec(reader_id, &self.spec) {
            None => {
                return Err(
                    Error::new("quota_wait", "Waiting for the exact session quota reader").into(),
                );
            }
            Some(false) => {
                return Err(Error::new(
                    "quota_binding_conflict",
                    "Quota reader does not match this session's captured launch configuration",
                )
                .into());
            }
            Some(true) => {}
        }
        let (evidence, route) = registry
            .read_proof(reader_id, now_ms, elapsed_ms)
            .ok_or_else(|| {
                Error::new("quota_wait", "Waiting for the exact session quota reader")
            })?;
        let view = &evidence.view;
        if view.freshness != "fresh"
            || !view.complete
            || route
                .as_ref()
                .is_none_or(|route| route.verdict != RouteVerdict::ChatgptConfiguredOpenai)
        {
            return Err(Error::new(
                "quota_wait",
                "Quota wake needs a fresh complete supported configured-account snapshot",
            )
            .into());
        }
        let (
            Some(context_id),
            Some(account_fingerprint),
            Some(read_started_elapsed_ms),
            Some(wall),
        ) = (
            view.context_id.as_ref(),
            view.account_fingerprint.as_ref(),
            evidence.started_elapsed_ms,
            evidence.effective_now_ms,
        )
        else {
            return Err(Error::new(
                "quota_wait",
                "Quota wake needs known configured context and account evidence",
            )
            .into());
        };
        let mut windows = view
            .windows
            .iter()
            .filter(|window| window.duration_mins == 300);
        let window = windows
            .next()
            .filter(|_| windows.next().is_none())
            .filter(|window| window.used_percent >= 90)
            .ok_or_else(|| {
                Error::new(
                    "quota_wake_unavailable",
                    "Wake is offered at 90% of one known five-hour window with a future reset",
                )
            })?;
        let reset_at = window.resets_at.ok_or_else(|| {
            Error::new(
                "quota_wake_unavailable",
                "The five-hour reset is unavailable",
            )
        })?;
        let reset_ms = u64::try_from(reset_at)
            .ok()
            .and_then(|reset| reset.checked_mul(1000))
            .filter(|reset| *reset > wall)
            .ok_or_else(|| {
                Error::new(
                    "quota_wake_unavailable",
                    "The five-hour reset must be in the future",
                )
            })?;
        let reset_elapsed_ms = elapsed_ms.checked_add(reset_ms - wall).ok_or_else(|| {
            Error::new(
                "quota_wake_unavailable",
                "The reset deadline is unavailable",
            )
        })?;
        Ok(WakeProof {
            reader_id: reader_id.into(),
            context_id: context_id.clone(),
            account_fingerprint: account_fingerprint.clone(),
            revision: view.revision,
            read_started_elapsed_ms,
            reset_at,
            reset_elapsed_ms,
        })
    }

    pub fn release(
        &self,
        registry: &mut Registry,
        proof: &WakeProof,
        now_ms: u64,
        elapsed_ms: u64,
    ) -> Release {
        if !proof.valid() {
            return Release::Disarm("invalid_wake_proof");
        }
        match registry.matching_spec(&proof.reader_id, &self.spec) {
            None => return Release::Hold("reader_unavailable"),
            Some(false) => return Release::Disarm("launch_configuration_changed"),
            Some(true) => {}
        }
        let Some((evidence, route)) = registry.read_proof(&proof.reader_id, now_ms, elapsed_ms)
        else {
            return Release::Hold("reader_unavailable");
        };
        if evidence.identity_changed_revision > proof.revision {
            return Release::Disarm("quota_identity_changed");
        }
        if evidence
            .known_context_id
            .as_ref()
            .is_some_and(|context| context != &proof.context_id)
        {
            return Release::Disarm("quota_context_changed");
        }
        if evidence
            .known_account_fingerprint
            .as_ref()
            .is_some_and(|account| account != &proof.account_fingerprint)
        {
            return Release::Disarm("quota_account_changed");
        }
        if route.as_ref().is_some_and(|route| {
            !matches!(
                route.verdict,
                RouteVerdict::Unknown | RouteVerdict::ChatgptConfiguredOpenai
            )
        }) {
            return Release::Disarm("quota_route_changed");
        }
        let view = &evidence.view;
        if view.freshness != "fresh"
            || !view.complete
            || route
                .as_ref()
                .is_none_or(|route| route.verdict != RouteVerdict::ChatgptConfiguredOpenai)
        {
            return Release::Hold("quota_source_unavailable");
        }
        if view.context_id.as_deref() != Some(proof.context_id.as_str())
            || view.account_fingerprint.as_deref() != Some(proof.account_fingerprint.as_str())
        {
            return Release::Hold("quota_identity_unavailable");
        }
        let Some(started) = evidence.started_elapsed_ms else {
            return Release::Hold("quota_source_unavailable");
        };
        if elapsed_ms < proof.reset_elapsed_ms
            || view.revision <= proof.revision
            || started <= proof.reset_elapsed_ms
        {
            return Release::Hold("post_reset_read_required");
        }
        if !view.ordinary_usage_eligible
            || view.windows.iter().any(|window| window.used_percent >= 100)
        {
            return Release::Hold("quota_permission_unavailable");
        }
        let mut windows = view
            .windows
            .iter()
            .filter(|window| window.duration_mins == 300);
        if !windows
            .next()
            .is_some_and(|window| window.used_percent < 90)
            || windows.next().is_some()
        {
            return Release::Hold("five_hour_quota_not_released");
        }
        Release::Ready {
            revision: view.revision,
            read_started_elapsed_ms: started,
        }
    }
}

impl WakeProof {
    fn valid(&self) -> bool {
        fn hex(value: &str, len: usize) -> bool {
            value.len() == len
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }
        hex(&self.reader_id, 32)
            && hex(&self.context_id, 64)
            && hex(&self.account_fingerprint, 64)
            && self.revision > 0
            && self.reset_at > 0
            && self.reset_elapsed_ms > self.read_started_elapsed_ms
    }
}

#[cfg(test)]
#[path = "session_quota_tests.rs"]
mod tests;
