use crate::{
    groups::Group,
    readiness::Phase,
    status::{SessionStatus, StatusSource, StatusState},
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub priority: u8,
    pub reason: Option<&'static str>,
    pub status: Option<SessionStatus>,
    pub blocked_children: usize,
}
impl Projection {
    pub fn current(
        status: SessionStatus,
        readiness: Phase,
        reason: Option<&'static str>,
        blocked_children: usize,
    ) -> Self {
        let (priority, reason, indicator) = match (status.source, status.state, readiness) {
            (_, _, Phase::TimedOut) => (
                1,
                Some("startup"),
                Some(SessionStatus {
                    state: StatusState::Failed,
                    source: StatusSource::Screen,
                    ..status
                }),
            ),
            (_, StatusState::Failed, _) => (1, Some("failure"), Some(status)),
            (
                StatusSource::Hook | StatusSource::Program | StatusSource::Screen,
                StatusState::Question,
                _,
            ) => (3, Some("question"), Some(status)),
            (
                StatusSource::Hook | StatusSource::Program | StatusSource::Screen,
                StatusState::Blocked,
                _,
            ) => (2, Some(reason.unwrap_or("unknown")), Some(status)),
            _ if blocked_children > 0 => (
                2,
                Some("child"),
                Some(SessionStatus {
                    state: StatusState::Blocked,
                    source: StatusSource::Program,
                    ..status
                }),
            ),
            _ => (0, None, None),
        };
        Self {
            priority,
            reason,
            status: indicator,
            blocked_children,
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub sessions: usize,
    pub needs_you: usize,
    pub highest: Option<Projection>,
}
impl Summary {
    fn add(&mut self, projection: &Projection) {
        self.sessions += 1;
        if projection.priority > 0 {
            self.needs_you += 1;
            if self
                .highest
                .as_ref()
                .is_none_or(|p| p.priority < projection.priority)
            {
                self.highest = Some(projection.clone());
            }
        }
    }
}

pub fn rollup<'a>(
    groups: &[Group],
    sessions: impl IntoIterator<Item = (Option<&'a str>, &'a Projection)>,
) -> (Summary, HashMap<String, Summary>) {
    let parents: HashMap<_, _> = groups
        .iter()
        .map(|g| (g.id.as_str(), g.parent_id.as_deref()))
        .collect();
    let mut by_group: HashMap<String, Summary> = groups
        .iter()
        .map(|g| (g.id.clone(), Summary::default()))
        .collect();
    let mut total = Summary::default();
    for (mut parent, projection) in sessions {
        total.add(projection);
        let mut seen = HashSet::new();
        while let Some(id) = parent {
            if !seen.insert(id) {
                break;
            }
            if let Some(summary) = by_group.get_mut(id) {
                summary.add(projection);
            } else {
                break;
            }
            parent = parents.get(id).copied().flatten();
        }
    }
    (total, by_group)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn status(state: StatusState) -> SessionStatus {
        SessionStatus {
            state,
            source: StatusSource::Hook,
            updated_at: 1,
        }
    }
    #[test]
    fn current_attention_ignores_completion_history_and_separates_blocked_children() {
        for state in [
            StatusState::Working,
            StatusState::Idle,
            StatusState::Done,
            StatusState::Unknown,
        ] {
            assert_eq!(
                Projection::current(status(state), Phase::Ready, None, 0).priority,
                0
            );
        }
        let child = Projection::current(status(StatusState::Working), Phase::Ready, None, 3);
        assert_eq!(child.reason, Some("child"));
        assert_eq!(child.blocked_children, 3);
        assert_eq!(child.status.unwrap().state, StatusState::Blocked);
        assert_eq!(
            Projection::current(status(StatusState::Unknown), Phase::TimedOut, None, 0).reason,
            Some("startup")
        );
        assert_eq!(
            Projection::current(
                status(StatusState::Blocked),
                Phase::Waiting,
                Some("auth"),
                0
            )
            .reason,
            Some("auth")
        );
    }
    #[test]
    fn collapsed_ancestors_count_sessions_once_and_choose_current_highest_issue() {
        let groups = [
            Group {
                id: "a".into(),
                parent_id: None,
                name: "a".into(),
                order: 0,
            },
            Group {
                id: "b".into(),
                parent_id: Some("a".into()),
                name: "b".into(),
                order: 0,
            },
        ];
        let working = Projection::current(status(StatusState::Working), Phase::Ready, None, 0);
        let question = Projection::current(status(StatusState::Question), Phase::Waiting, None, 0);
        let child = Projection::current(status(StatusState::Working), Phase::Ready, None, 9);
        let (total, summary) = rollup(
            &groups,
            [
                (Some("b"), &question),
                (Some("a"), &child),
                (None, &working),
            ],
        );
        assert_eq!((total.sessions, total.needs_you), (3, 2));
        assert_eq!((summary["a"].sessions, summary["a"].needs_you), (2, 2));
        assert_eq!(summary["b"].needs_you, 1);
        assert_eq!(
            summary["a"].highest.as_ref().unwrap().reason,
            Some("question")
        );
        let (_, summary) = rollup(&groups, [(Some("b"), &working), (Some("a"), &child)]);
        assert_eq!(summary["a"].highest.as_ref().unwrap().reason, Some("child"));
        let mut cyclic = groups;
        cyclic[0].parent_id = Some("b".into());
        let (_, summary) = rollup(&cyclic, [(Some("b"), &question)]);
        assert_eq!(summary["a"].needs_you, 1);
        assert_eq!(summary["b"].needs_you, 1);
    }
}
