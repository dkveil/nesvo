pub mod files;
pub mod jobs;
pub mod layouts;
pub mod notes;
pub mod review;
pub mod runs;

use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub fn decode<T: DeserializeOwned>(reply: &Value) -> Option<T> {
    T::deserialize(reply).ok()
}

pub fn encode<T: Serialize>(request: &T) -> Value {
    serde_json::to_value(request).unwrap_or_default()
}

pub fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(T::deserialize(&value).unwrap_or_default())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tolerant<T>(pub Option<T>);

impl<T> Default for Tolerant<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Tolerant<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(Self(T::deserialize(&value).ok()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyHeader {
    #[serde(default, rename = "type", deserialize_with = "lenient")]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub request_id: Option<String>,
}

impl ReplyHeader {
    pub fn of(reply: &Value) -> Self {
        decode(reply).unwrap_or_default()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    #[serde(default, deserialize_with = "lenient")]
    pub request_id: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub code: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub message: Option<String>,
}

impl HostError {
    pub fn of(reply: &Value) -> Self {
        decode(reply).unwrap_or_default()
    }

    pub fn code(&self) -> &str {
        self.code.as_deref().unwrap_or_default()
    }

    pub fn message_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        self.message.as_deref().unwrap_or(fallback)
    }
}
