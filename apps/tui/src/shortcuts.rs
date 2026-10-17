//! Global terminal shortcuts are function keys, never printable agent input.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Shortcuts {
    pub keys: [u8; 5],
}
pub const LABELS: [&str; 5] = [
    "Git review",
    "Previous session",
    "Next unread attention",
    "Launch templates",
    "Restore sessions",
];
impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            keys: [4, 6, 7, 8, 9],
        }
    }
}
impl Shortcuts {
    pub fn valid(&self) -> bool {
        self.keys
            .iter()
            .enumerate()
            .all(|(i, key)| (3..=12).contains(key) && !self.keys[..i].contains(key))
    }
    pub fn assign(&mut self, index: usize, key: u8) -> bool {
        if index >= self.keys.len() {
            return false;
        }
        let mut candidate = *self;
        candidate.keys[index] = key;
        if !candidate.valid() {
            return false;
        }
        *self = candidate;
        true
    }
    pub fn hints(&self, text: &str) -> String {
        // Replace through placeholders so swapped assignments cannot cascade.
        let mut output = text.to_owned();
        for (i, key) in Self::default().keys.iter().enumerate() {
            output = output.replace(&format!("F{key}"), &format!("{{key{i}}}"));
        }
        for (i, key) in self.keys.iter().enumerate() {
            output = output.replace(&format!("{{key{i}}}"), &format!("F{key}"));
        }
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_conflicts_and_reserved_keys_without_mutating_bindings() {
        let mut keys = Shortcuts::default();
        assert!(!keys.assign(0, 6));
        assert!(!keys.assign(0, 1));
        assert_eq!(keys, Shortcuts::default());
        assert!(keys.assign(0, 10));
        assert_eq!(
            keys.hints("F4 diff · F6 previous"),
            "F10 diff · F6 previous"
        );
    }
}
