use crate::model::App;
use nesvo_wire::views::{
    self,
    mcp::{ListMcpServers, ServerListing},
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    time::{Duration, Instant},
};

const REFRESH: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SHOWN_SERVERS: usize = 3;

struct Pending {
    request: String,
    directory: String,
    sent: Instant,
}

#[derive(Default)]
pub struct Servers {
    pending: Option<Pending>,
    checked: HashMap<String, Instant>,
    repositories: HashMap<String, String>,
    attached: HashMap<String, (String, BTreeSet<String>)>,
}

fn supported(app: &App) -> bool {
    app.host_features["mcpServers"] == true
}

pub fn tick(app: &mut App) -> Option<Value> {
    if !app.connected || !supported(app) {
        return None;
    }
    let directory = app
        .active_id()
        .and_then(|id| app.session(id))
        .map(|session| session.cwd.clone())
        .filter(|cwd| !cwd.is_empty())?;
    let state = &mut app.mcp_servers;
    if let Some(pending) = &state.pending {
        if pending.sent.elapsed() < REQUEST_TIMEOUT {
            return None;
        }
        state.pending = None;
    }
    if state
        .checked
        .get(&directory)
        .is_some_and(|at| at.elapsed() < REFRESH)
    {
        return None;
    }
    let command = app.request(views::encode(&ListMcpServers {
        directory: &directory,
    }));
    app.mcp_servers.pending = Some(Pending {
        request: command["requestId"].as_str().unwrap_or_default().to_owned(),
        directory,
        sent: Instant::now(),
    });
    Some(command)
}

pub fn host_event(app: &mut App, event: &Value) -> bool {
    let state = &mut app.mcp_servers;
    let Some(pending) = state
        .pending
        .take_if(|pending| event["requestId"].as_str() == Some(pending.request.as_str()))
    else {
        return false;
    };
    state
        .checked
        .insert(pending.directory.clone(), Instant::now());
    let listing = (event["type"] == "mcpServers")
        .then(|| views::decode::<ServerListing>(event))
        .flatten()
        .unwrap_or_default();
    let repository = if listing.repository.is_empty() {
        pending.directory.clone()
    } else {
        listing.repository.clone()
    };
    if let Some(previous) = state
        .repositories
        .insert(pending.directory, repository.clone())
        .filter(|previous| *previous != repository)
    {
        state.attached.retain(|_, (owner, _)| *owner != previous);
    }
    state.attached.retain(|_, (owner, _)| *owner != repository);
    for attachment in listing.attachments() {
        state
            .attached
            .entry(attachment.session_id.clone())
            .or_insert_with(|| (repository.clone(), BTreeSet::new()))
            .1
            .insert(attachment.server.clone());
    }
    true
}

pub fn disconnect(app: &mut App) {
    let state = &mut app.mcp_servers;
    state.pending = None;
    state.checked.clear();
}

pub fn header(app: &App, session_id: &str) -> Option<String> {
    let (_, servers) = app.mcp_servers.attached.get(session_id)?;
    let shown: Vec<&str> = servers
        .iter()
        .take(SHOWN_SERVERS)
        .map(String::as_str)
        .collect();
    let more = servers.len().saturating_sub(SHOWN_SERVERS);
    Some(if more > 0 {
        format!("mcp {} +{more}", shown.join(", "))
    } else {
        format!("mcp {}", shown.join(", "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn app(features: bool) -> App {
        let mut app = App::new(1);
        app.event(
            json!({"type":"capabilities","workspace":"/w","programs":[],"mcpServers":features}),
        )
        .unwrap();
        app.event(
            json!({"type":"sessions","revision":1,"groups":[],"sessions":[
                {"id":"s1","name":"agent","cwd":"/w/repo","program":"claude","cols":80,"rows":24,
                 "running":true,"groupId":null,"controllerId":null},
                {"id":"s2","name":"other","cwd":"/w/repo","program":"claude","cols":80,"rows":24,
                 "running":true,"groupId":null,"controllerId":null}
            ]}),
        )
        .unwrap();
        app.connected = true;
        app.dialog = None;
        app.overlay = None;
        app.panes[0] = Some("s1".into());
        app
    }

    fn listing(request: &Value, attached: Value) -> Value {
        json!({"type":"mcpServers","requestId":request["requestId"],"repository":"/w/repo",
            "source":"HEAD:nesvo.toml","configured":true,"digest":null,"approved":true,
            "servers":[],"attached":attached,"providers":{},"bounds":{}})
    }

    fn attachment(session: &str, server: &str) -> Value {
        json!({"sessionId":session,"server":server,"program":"claude","mode":"pooled",
            "reason":null,"entryId":null,"repository":"/w/repo"})
    }

    #[test]
    fn the_active_session_folder_is_listed_once_per_refresh_and_fills_the_header() {
        let mut app = app(true);
        let request = tick(&mut app).expect("a listing request");
        assert_eq!(request["type"], "listMcpServers");
        assert_eq!(request["directory"], "/w/repo");
        assert!(tick(&mut app).is_none());
        assert!(host_event(
            &mut app,
            &listing(
                &request,
                json!([
                    attachment("s1", "search"),
                    attachment("s1", "docs"),
                    attachment("s2", "docs")
                ])
            )
        ));
        assert_eq!(header(&app, "s1").as_deref(), Some("mcp docs, search"));
        assert_eq!(header(&app, "s2").as_deref(), Some("mcp docs"));
        assert_eq!(header(&app, "s3"), None);
        assert!(tick(&mut app).is_none());
        assert!(!host_event(
            &mut app,
            &json!({"type":"mcpServers","requestId":"other"})
        ));
    }

    #[test]
    fn a_new_listing_replaces_the_repository_and_an_error_clears_it() {
        let mut app = app(true);
        let first = tick(&mut app).unwrap();
        let servers: Vec<Value> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|name| attachment("s1", name))
            .collect();
        host_event(&mut app, &listing(&first, json!(servers)));
        assert_eq!(header(&app, "s1").as_deref(), Some("mcp a, b, c +2"));
        app.mcp_servers.checked.clear();
        let second = tick(&mut app).unwrap();
        host_event(
            &mut app,
            &listing(&second, json!([attachment("s2", "docs")])),
        );
        assert_eq!(header(&app, "s1"), None);
        assert_eq!(header(&app, "s2").as_deref(), Some("mcp docs"));
        app.mcp_servers.checked.clear();
        let failed = tick(&mut app).unwrap();
        assert!(host_event(
            &mut app,
            &json!({"type":"error","code":"forbidden","message":"no","requestId":failed["requestId"]})
        ));
        assert_eq!(header(&app, "s2"), None);
        assert!(tick(&mut app).is_none());
    }

    #[test]
    fn nothing_is_requested_without_the_capability_or_a_connection() {
        let mut app = app(false);
        assert!(tick(&mut app).is_none());
        let mut app = super::tests::app(true);
        app.connected = false;
        assert!(tick(&mut app).is_none());
        app.connected = true;
        let request = tick(&mut app).unwrap();
        disconnect(&mut app);
        assert!(!host_event(&mut app, &listing(&request, json!([]))));
        assert!(tick(&mut app).is_some());
    }
}
