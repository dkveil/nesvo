#[derive(Default)]
pub struct Titles {
    pending: Vec<u8>,
    state: u8,
    pub title: Option<String>,
}
impl Titles {
    pub fn feed(&mut self, output: &str) {
        for byte in output.bytes() {
            match (self.state, byte) {
                (0, 27) => self.state = 1,
                (1, b']') => {
                    self.state = 2;
                    self.pending.clear();
                }
                (1, _) => self.state = 0,
                (2, 7) | (3, b'\\') => {
                    self.finish();
                    self.state = 0;
                }
                (2, 27) => self.state = 3,
                (2, _) if self.pending.len() < 1024 => self.pending.push(byte),
                (2, _) | (3, _) => {
                    self.state = 0;
                    self.pending.clear();
                }
                _ => {}
            }
        }
    }
    fn finish(&mut self) {
        let Ok(value) = std::str::from_utf8(&self.pending) else {
            return;
        };
        let Some(value) = value
            .strip_prefix("0;")
            .or_else(|| value.strip_prefix("2;"))
        else {
            return;
        };
        let value = value.trim();
        if value.is_empty()
            || value.chars().any(char::is_control)
            || matches!(
                value.to_lowercase().as_str(),
                "claude" | "claude code" | "codex" | "gemini" | "terminal"
            )
        {
            return;
        }
        self.title = Some(value.chars().take(80).collect());
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_fragmented_titles_but_not_other_osc_or_unbounded_payloads() {
        let mut titles = Titles::default();
        titles.feed("\x1b]2;Fix ");
        titles.feed("login\x1b");
        titles.feed("\\");
        assert_eq!(titles.title.as_deref(), Some("Fix login"));
        titles.feed("\x1b]52;clipboard\x07\x1b]2;Claude Code\x07");
        assert_eq!(titles.title.as_deref(), Some("Fix login"));
        titles.feed(&format!("\x1b]2;{}\x07", "x".repeat(2000)));
        assert_eq!(titles.title.as_deref(), Some("Fix login"));
    }
}
