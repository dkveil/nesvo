//! Live-only protocol owner. Consumed queries never reach clients or replay.
use crate::program_status::{self, MAX_SEQUENCE, Report};

pub enum Event {
    Reply(&'static str),
    Report(Report),
    Reset,
    Prompt,
}
pub struct Feed {
    pub visible: String,
    pub events: Vec<Event>,
}

#[derive(Default)]
enum Scan {
    #[default]
    Ground,
    Escape,
    Csi,
    Osc,
    OscEscape,
    Passthrough,
    PassthroughEscape,
}

pub struct Decoder {
    scan: Scan,
    pending: String,
    overflow: bool,
    initial_cursor: bool,
    initial_cursor_reply_sent: bool,
    passthrough_bell: bool,
    queries: u64,
    reports: u64,
    rejected: u64,
}
impl Default for Decoder {
    fn default() -> Self {
        Self::new(cfg!(windows))
    }
}
impl Decoder {
    fn new(initial_cursor: bool) -> Self {
        Self {
            scan: Scan::Ground,
            pending: String::new(),
            overflow: false,
            initial_cursor,
            initial_cursor_reply_sent: false,
            passthrough_bell: false,
            queries: 0,
            reports: 0,
            rejected: 0,
        }
    }
    #[cfg(windows)]
    pub fn initial_cursor_reply_needed(&self) -> bool {
        self.initial_cursor && !self.initial_cursor_reply_sent
    }
    #[cfg(windows)]
    pub fn confirm_initial_cursor_reply(&mut self) {
        self.initial_cursor_reply_sent = true;
    }
    pub fn feed(&mut self, data: &str) -> Feed {
        let mut feed = Feed {
            visible: String::with_capacity(data.len()),
            events: Vec::new(),
        };
        for ch in data.chars() {
            match self.scan {
                Scan::Ground => {
                    if ch == '\x1b' {
                        self.pending.push(ch);
                        self.scan = Scan::Escape;
                    } else {
                        feed.visible.push(ch);
                    }
                }
                Scan::Escape => {
                    self.pending.push(ch);
                    match ch {
                        ']' => self.scan = Scan::Osc,
                        '[' => self.scan = Scan::Csi,
                        'P' | '_' | '^' | 'X' => {
                            feed.visible.push_str(&self.pending);
                            self.pending.clear();
                            self.passthrough_bell = false;
                            self.scan = Scan::Passthrough;
                        }
                        _ => {
                            if ch == 'c' {
                                feed.events.push(Event::Reset);
                            }
                            feed.visible.push_str(&self.pending);
                            self.pending.clear();
                            self.scan = Scan::Ground;
                        }
                    }
                }
                Scan::Csi => {
                    self.pending.push(ch);
                    if ('@'..='~').contains(&ch) {
                        match self.pending.as_str() {
                            "\x1b[c" | "\x1b[0c" => feed.events.push(Event::Reply("\x1b[?1;2c")),
                            "\x1b[6n" if self.initial_cursor => {
                                self.initial_cursor = false;
                                if !self.initial_cursor_reply_sent {
                                    self.initial_cursor_reply_sent = true;
                                    feed.events.push(Event::Reply("\x1b[1;1R"));
                                }
                            }
                            _ => feed.visible.push_str(&self.pending),
                        }
                        self.pending.clear();
                        self.scan = Scan::Ground;
                    } else if self.pending.len() >= MAX_SEQUENCE || ch == '\x1b' {
                        feed.visible.push_str(&self.pending);
                        self.pending.clear();
                        self.scan = Scan::Ground;
                    }
                }
                Scan::Osc | Scan::OscEscape => {
                    let terminated =
                        ch == '\x07' || (matches!(self.scan, Scan::OscEscape) && ch == '\\');
                    if !self.overflow {
                        self.pending.push(ch);
                    }
                    if self.pending.len() > MAX_SEQUENCE {
                        self.overflow = true;
                        if !self.pending.starts_with("\x1b]7501;") {
                            feed.visible.push_str(&self.pending);
                            self.pending.clear();
                            self.passthrough_bell = true;
                            self.overflow = false;
                            self.scan = if terminated {
                                Scan::Ground
                            } else if ch == '\x1b' {
                                Scan::PassthroughEscape
                            } else {
                                Scan::Passthrough
                            };
                            continue;
                        }
                        self.pending.clear();
                    }
                    if terminated {
                        if !self.overflow {
                            self.finish_osc(&mut feed);
                        }
                        self.pending.clear();
                        self.overflow = false;
                        self.scan = Scan::Ground;
                    } else {
                        self.scan = if ch == '\x1b' {
                            Scan::OscEscape
                        } else {
                            Scan::Osc
                        };
                    }
                }
                Scan::Passthrough => {
                    feed.visible.push(ch);
                    if ch == '\x07' && self.passthrough_bell {
                        self.scan = Scan::Ground;
                    } else if ch == '\x1b' {
                        self.scan = Scan::PassthroughEscape;
                    }
                }
                Scan::PassthroughEscape => {
                    feed.visible.push(ch);
                    self.scan = if ch == '\\' {
                        Scan::Ground
                    } else {
                        Scan::Passthrough
                    };
                }
            }
        }
        feed
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({"owner":"host","queries":self.queries,"reports":self.reports,"rejected":self.rejected})
    }
    fn finish_osc(&mut self, feed: &mut Feed) {
        let body = self
            .pending
            .strip_suffix('\x07')
            .or_else(|| self.pending.strip_suffix("\x1b\\"))
            .unwrap_or_default();
        if let Some(body) = body.strip_prefix("\x1b]7501;") {
            if body.trim() == "?" {
                self.queries = self.queries.saturating_add(1);
                feed.events.push(Event::Reply(program_status::REPLY));
            } else if let Some(report) = program_status::parse(body) {
                self.reports = self.reports.saturating_add(1);
                feed.events.push(Event::Report(report));
            } else {
                self.rejected = self.rejected.saturating_add(1);
            }
        } else {
            if body == "\x1b]133;A" || body.starts_with("\x1b]133;A;") {
                feed.events.push(Event::Prompt);
            }
            feed.visible.push_str(&self.pending);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn early_cleanup_and_live_decoder_share_the_initial_cursor_reply() {
        let mut early = Decoder::new(true);
        assert!(early.initial_cursor_reply_needed());
        early.confirm_initial_cursor_reply();
        assert!(!early.initial_cursor_reply_needed());
        let feed = early.feed("\x1b[6n");
        assert!(
            feed.visible.is_empty() && feed.events.is_empty(),
            "late startup query is consumed without a second reply"
        );
        let mut normal = Decoder::new(true);
        assert!(matches!(
            &normal.feed("\x1b[6n").events[..],
            [Event::Reply("\x1b[1;1R")]
        ));
        assert!(
            !normal.initial_cursor_reply_needed(),
            "cleanup cannot send a duplicate after normal negotiation"
        );
    }
    #[test]
    fn fragmented_queries_have_one_reply_owner_and_keep_negotiation_order() {
        for split in 0..=29 {
            let text = "a\x1b]7501;?\x1b\\\x1b[cb\x1b]2;Title\x07";
            let split = split.min(text.len());
            let mut decoder = Decoder::new(false);
            let mut first = decoder.feed(&text[..split]);
            let second = decoder.feed(&text[split..]);
            first.visible.push_str(&second.visible);
            first.events.extend(second.events);
            assert_eq!(first.visible, "ab\x1b]2;Title\x07");
            let replies: Vec<_> = first
                .events
                .into_iter()
                .filter_map(|e| match e {
                    Event::Reply(s) => Some(s),
                    _ => None,
                })
                .collect();
            assert_eq!(replies, [program_status::REPLY, "\x1b[?1;2c"]);
        }
    }
    #[test]
    fn ignores_nested_dcs_and_bounds_bad_osc_then_recovers() {
        let mut decoder = Decoder::new(false);
        let feed = decoder.feed("\x1bPq\x1b]7501;?\x07\x1b\\");
        assert!(feed.events.is_empty());
        let feed = decoder.feed(&format!(
            "\x1b]7501;state=idle:msg={}\x07ok\x1b]7501;state=working\x07",
            "a".repeat(10000)
        ));
        assert_eq!(feed.visible, "ok");
        assert_eq!(feed.events.len(), 1);
        assert!(decoder.pending.capacity() < 10000);
        let feed = decoder.feed("\x1b]7501;state=clear\x07\x1bc\x1b]133;A\x07");
        assert!(matches!(
            feed.events.as_slice(),
            [Event::Report(_), Event::Reset, Event::Prompt]
        ));
    }
    #[test]
    fn initial_conpty_query_is_answered_once_without_clients() {
        let mut decoder = Decoder::new(true);
        let feed = decoder.feed("\x1b[6n\x1b[6n");
        assert_eq!(feed.visible, "\x1b[6n");
        assert!(matches!(
            feed.events.as_slice(),
            [Event::Reply("\x1b[1;1R")]
        ));
    }
    #[test]
    fn other_osc_drawing_and_unicode_are_preserved_even_above_status_cap() {
        let mut decoder = Decoder::new(false);
        let input = format!("zażółć\x1b]2;{}\x1b\\\x1b[31m🦀\x1b[0m", "x".repeat(8000));
        let first = decoder.feed(&input[..6]);
        let second = decoder.feed(&input[6..]);
        assert_eq!(first.visible + &second.visible, input);
        assert!(second.events.is_empty());
    }
}
