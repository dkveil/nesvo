use super::{Tolerant, lenient};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAttachment {
    #[serde(default, deserialize_with = "lenient")]
    pub session_id: String,
    #[serde(default, deserialize_with = "lenient")]
    pub server: String,
    #[serde(default, deserialize_with = "lenient")]
    pub mode: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ServerListing {
    #[serde(default, deserialize_with = "lenient")]
    pub repository: String,
    #[serde(default, deserialize_with = "lenient")]
    pub attached: Vec<Tolerant<ServerAttachment>>,
}

impl ServerListing {
    pub fn attachments(&self) -> impl Iterator<Item = &ServerAttachment> {
        self.attached
            .iter()
            .filter_map(|attachment| attachment.0.as_ref())
            .filter(|attachment| !attachment.session_id.is_empty() && !attachment.server.is_empty())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename = "listMcpServers")]
pub struct ListMcpServers<'a> {
    pub directory: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::views::{decode, encode};
    use serde_json::json;

    #[test]
    fn listings_keep_readable_attachments_and_requests_encode_the_wire_shape() {
        let listing: ServerListing = decode(&json!({
            "type":"mcpServers","repository":"C:/repo",
            "attached":[
                {"sessionId":"s1","server":"docs","mode":"pooled","reason":null,"entryId":"e","program":"claude","repository":"C:/repo"},
                {"sessionId":"s2","server":7},
                "garbage",
                {"sessionId":"","server":"docs"}
            ]
        }))
        .unwrap();
        assert_eq!(listing.repository, "C:/repo");
        let kept: Vec<_> = listing
            .attachments()
            .map(|a| (a.session_id.as_str(), a.server.as_str()))
            .collect();
        assert_eq!(kept, [("s1", "docs")]);
        let empty: ServerListing = decode(&json!({"type":"mcpServers","attached":"x"})).unwrap();
        assert_eq!(empty.attachments().count(), 0);
        assert_eq!(
            encode(&ListMcpServers {
                directory: "C:/repo"
            }),
            json!({"type":"listMcpServers","directory":"C:/repo"})
        );
    }
}
