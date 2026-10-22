use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "subscribe", rename_all = "camelCase")]
pub struct Subscribe<'a> {
    pub session_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "unsubscribe", rename_all = "camelCase")]
pub struct Unsubscribe<'a> {
    pub session_id: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "releaseControl", rename_all = "camelCase")]
pub struct ReleaseControl<'a> {
    pub session_id: &'a str,
    pub lease_id: &'a str,
}
