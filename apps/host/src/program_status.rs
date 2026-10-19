//! Bounded OSC 7501 data. Reports are observations, never command authority.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use serde::Serialize;
use std::collections::BTreeMap;

pub const REPLY: &str =
    "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";
pub const MAX_SEQUENCE: usize = 4096;
const MAX_RECORDS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
    Clear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Permission,
    Question,
    Auth,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: Option<String>,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
}
fn valid_id(value: &str) -> bool {
    value.len() <= 128 && value.split('/').count() <= 8 && value.split('/').all(valid_segment)
}
fn text(value: &str, encoded: usize, decoded: usize) -> Option<String> {
    if value.len() > encoded {
        return None;
    }
    let bytes = STANDARD
        .decode(value)
        .or_else(|_| STANDARD_NO_PAD.decode(value))
        .ok()?;
    if bytes.len() > decoded {
        return None;
    }
    let value = String::from_utf8(bytes).ok()?;
    if value.chars().any(char::is_control) {
        return None;
    }
    // Disarm bidi overrides/isolates when a record is displayed outside its grid.
    Some(value.chars().filter(|c| !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')).collect())
}

pub fn parse(body: &str) -> Option<Report> {
    // OSC + "7501;" + ST occupy nine bytes.
    if body.len() + 9 > MAX_SEQUENCE {
        return None;
    }
    let mut pairs = BTreeMap::new();
    let mut msg = None;
    let mut title = None;
    for pair in body.split(':') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key.len() > 16 || (key == "app" && value.len() > 32) || (key == "id" && !valid_id(value))
        {
            return None;
        }
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_lowercase())
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.,+/=-".contains(&b))
        {
            continue;
        }
        match key {
            "msg" => msg = Some(text(value, 2732, 2048)?),
            "title" => title = Some(text(value, 256, 192)?),
            _ => {
                pairs.insert(key, value);
            }
        }
    }
    let state = match *pairs.get("state")? {
        "idle" => State::Idle,
        "working" => State::Working,
        "done" => State::Done,
        "blocked" => State::Blocked,
        "error" => State::Error,
        "clear" => State::Clear,
        _ => return None,
    };
    let kind = if state == State::Blocked {
        match pairs.get("kind").copied() {
            Some("permission") => Some(Kind::Permission),
            Some("question") => Some(Kind::Question),
            Some("auth") => Some(Kind::Auth),
            _ => None,
        }
    } else {
        None
    };
    let progress = if matches!(state, State::Working | State::Blocked) {
        pairs
            .get("progress")
            .filter(|s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|n| *n <= 100)
    } else {
        None
    };
    Some(Report {
        id: pairs.get("id").map(|s| (*s).into()),
        state,
        kind,
        progress,
        app: pairs
            .get("app")
            .filter(|s| valid_segment(s))
            .map(|s| (*s).into()),
        title,
        msg,
    })
}

#[derive(Default)]
pub struct Records {
    records: BTreeMap<String, (u64, Report)>,
    sequence: u64,
}
impl Records {
    pub fn apply(&mut self, report: Report) {
        let id = report.id.clone().unwrap_or_default();
        if report.state == State::Clear {
            self.records.retain(|key, _| {
                !id.is_empty()
                    && key != &id
                    && !key.strip_prefix(&id).is_some_and(|s| s.starts_with('/'))
            });
            return;
        }
        if !self.records.contains_key(&id)
            && self.records.len() >= MAX_RECORDS
            && let Some(oldest) = self
                .records
                .iter()
                .min_by_key(|(_, (sequence, _))| sequence)
                .map(|(id, _)| id.clone())
        {
            self.records.remove(&oldest);
        }
        self.sequence = self.sequence.saturating_add(1);
        self.records.insert(id, (self.sequence, report));
    }
    pub fn root(&self) -> Option<&Report> {
        self.records.get("").map(|(_, report)| report)
    }
    pub fn reset(&mut self) {
        self.records.clear();
    }
    pub fn end_program(&mut self) {
        self.records
            .retain(|_, (_, report)| matches!(report.state, State::Done | State::Error));
    }
    pub fn blocked_children(&self) -> usize {
        self.records
            .values()
            .filter(|(_, r)| r.id.is_some() && r.state == State::Blocked)
            .count()
    }
    pub fn summary(&self) -> serde_json::Value {
        // Child text is not broadcast in aggregate: 256 full messages could
        // exceed a wire frame. Explain/read endpoints can paginate later.
        let blocked_apps: std::collections::BTreeSet<_> = self
            .records
            .iter()
            .filter(|(id, (_, r))| !id.is_empty() && r.state == State::Blocked)
            .filter_map(|(id, _)| self.effective_app(id))
            .take(32)
            .collect();
        serde_json::json!({"root":self.root(), "childCount":self.records.keys().filter(|id| !id.is_empty()).count(),
            "blockedChildren":self.blocked_children(),
            "blockedChildApps":blocked_apps})
    }
    fn effective_app(&self, id: &str) -> Option<&str> {
        let mut current = id;
        loop {
            if let Some(app) = self
                .records
                .get(current)
                .and_then(|(_, r)| r.app.as_deref())
            {
                return Some(app);
            }
            if current.is_empty() {
                return None;
            }
            current = current.rsplit_once('/').map_or("", |(parent, _)| parent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_complete_reports_and_does_not_launder_bad_duplicates() {
        let r = parse("state=working:progress=42:app=claude-code:title=SGVsbG8").unwrap();
        assert_eq!(r.progress, Some(42));
        assert_eq!(r.title.as_deref(), Some("Hello"));
        for s in [
            "state=idle:id=bad//id",
            "state=idle:msg=bad=",
            "state=idle:msg=Cg==",
            "state=new",
            "state=idle:title=/w==",
        ] {
            assert!(parse(s).is_none(), "{s}");
        }
        assert!(parse(&format!("state=idle:msg={}:msg=b2s=", "a".repeat(2733))).is_none());
        assert_eq!(
            parse("bad:state=working:state=idle:extra_key=bad;:progress=999")
                .unwrap()
                .state,
            State::Idle
        );
        assert_eq!(
            parse("state=blocked:kind=question").unwrap().kind,
            Some(Kind::Question)
        );
        assert_eq!(
            parse("state=idle:kind=question:progress=1").unwrap().kind,
            None
        );
    }
    #[test]
    fn children_are_independent_bounded_and_clear_is_hierarchical() {
        let mut records = Records::default();
        for s in [
            "state=working:app=claude-code",
            "state=blocked:id=a:kind=question",
            "state=idle:id=a/b",
            "state=done:id=abc",
        ] {
            records.apply(parse(s).unwrap());
        }
        assert_eq!(records.root().unwrap().state, State::Working);
        assert_eq!(records.effective_app("a/b"), Some("claude-code"));
        records.apply(parse("state=clear:id=a").unwrap());
        assert_eq!(records.records.len(), 2);
        records.end_program();
        assert_eq!(records.records.len(), 1);
        for i in 0..300 {
            records.apply(parse(&format!("state=idle:id=n{i}")).unwrap());
        }
        assert_eq!(records.records.len(), 256);
        assert!(!records.records.contains_key("abc"));
        records.apply(parse("state=clear").unwrap());
        assert!(records.records.is_empty());
    }
}
