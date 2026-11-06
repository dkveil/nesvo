use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use url::Url;

pub const DEFAULT_PORT: u16 = 8791;
const MAX_PAIRING_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pairing {
    pub version: u8,
    pub url: String,
    pub key: String,
}

impl Pairing {
    pub fn parse(text: &str) -> Result<Self> {
        ensure!(text.len() <= MAX_PAIRING_BYTES, "Pairing is too large");
        let pairing: Self = serde_json::from_str(text).context("Invalid pairing JSON")?;
        pairing.validate()?;
        Ok(pairing)
    }

    fn validate(&self) -> Result<()> {
        ensure!(self.version == 1, "Unsupported pairing format");
        self.parsed_url()?;
        self.key_bytes()?;
        Ok(())
    }

    fn parsed_url(&self) -> Result<Url> {
        let url = Url::parse(&self.url).context("Invalid host URL")?;
        ensure!(
            matches!(url.scheme(), "ws" | "wss")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Host URL must be ws:// or wss:// with no credentials, query or path"
        );
        Ok(url)
    }

    pub fn key_bytes(&self) -> Result<[u8; 32]> {
        hex::decode(&self.key)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .context("Invalid pairing key")
    }

    pub fn embedded_port(&self) -> Option<u16> {
        self.parsed_url().ok().and_then(|url| url.port())
    }

    pub fn effective_port(&self, override_port: Option<u16>) -> u16 {
        override_port
            .or_else(|| self.embedded_port())
            .unwrap_or(DEFAULT_PORT)
    }

    pub fn host_url(&self, override_port: Option<u16>) -> Result<String> {
        let mut url = self.parsed_url()?;
        url.set_port(Some(self.effective_port(override_port)))
            .map_err(|()| anyhow::anyhow!("Cannot set the host port"))?;
        Ok(url.as_str().trim_end_matches('/').to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing(url: &str) -> String {
        format!(
            r#"{{"version":1,"url":"{url}","key":"{}"}}"#,
            "ab".repeat(32)
        )
    }

    #[test]
    fn accepts_a_valid_pairing_and_exposes_the_embedded_port() {
        let parsed = Pairing::parse(&pairing("ws://192.168.1.5:9000")).unwrap();
        assert_eq!(parsed.embedded_port(), Some(9000));
        assert_eq!(parsed.key_bytes().unwrap(), [0xab; 32]);
    }

    #[test]
    fn rejects_bad_versions_keys_and_urls() {
        assert!(Pairing::parse("not json").is_err());
        assert!(Pairing::parse(&pairing("http://host:1")).is_err());
        assert!(Pairing::parse(&pairing("ws://user:pass@host:1")).is_err());
        assert!(Pairing::parse(&pairing("ws://host:1/path")).is_err());
        assert!(Pairing::parse(&pairing("ws://host:1?x=1")).is_err());
        let short_key = r#"{"version":1,"url":"ws://host:1","key":"abcd"}"#;
        assert!(Pairing::parse(short_key).is_err());
        let wrong_version = pairing("ws://host:1").replace("\"version\":1", "\"version\":2");
        assert!(Pairing::parse(&wrong_version).is_err());
    }

    #[test]
    fn the_settings_port_overrides_the_embedded_one() {
        let parsed = Pairing::parse(&pairing("ws://192.168.1.5:9000")).unwrap();
        assert_eq!(parsed.host_url(None).unwrap(), "ws://192.168.1.5:9000");
        assert_eq!(
            parsed.host_url(Some(8791)).unwrap(),
            "ws://192.168.1.5:8791"
        );
    }

    #[test]
    fn falls_back_to_the_default_port_when_none_is_given() {
        let parsed = Pairing::parse(&pairing("ws://host")).unwrap();
        assert_eq!(parsed.effective_port(None), DEFAULT_PORT);
    }
}
