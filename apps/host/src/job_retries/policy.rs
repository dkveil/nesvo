use crate::api_error::Error;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum On {
    LaunchNoEffect,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub on: On,
    pub max_attempts: u8,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        if !(1..=8).contains(&self.max_attempts)
            || !(1_000..=3_600_000).contains(&self.initial_delay_ms)
            || self.max_delay_ms < self.initial_delay_ms
            || self.max_delay_ms > 86_400_000
        {
            return Err(Error::new(
                "invalid_argument",
                "Job retries require 1–8 total attempts, a 1 second–1 hour initial delay and a maximum delay between the initial delay and 24 hours",
            )
            .into());
        }
        Ok(())
    }

    pub fn delay_ms(&self, source_ordinal: u16) -> Result<u64> {
        self.validate()?;
        if !(1..=8).contains(&source_ordinal) {
            return Err(Error::new("invalid_argument", "Invalid retry source generation").into());
        }
        Ok((1..source_ordinal).fold(self.initial_delay_ms, |delay, _| {
            delay
                .checked_mul(2)
                .unwrap_or(self.max_delay_ms)
                .min(self.max_delay_ms)
        }))
    }
}
