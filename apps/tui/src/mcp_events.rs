use crate::{
    cli,
    network::{Connection, NetworkEvent, Pairing, open_failure_message},
};
use anyhow::Result;
use futures_util::future;
use nesvo_wire::events::EventKind;
use rmcp::{
    ErrorData, Peer, RoleServer,
    model::{
        CacheScope, ListResourceTemplatesResult, ListResourcesResult, NotificationMetaObject,
        PaginatedRequestParams, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
        ResourceUpdatedNotification, ResourceUpdatedNotificationParam, ServerNotification,
        SubscriptionFilter,
    },
    service::{SubscriptionContext, SubscriptionSink},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tokio::{
    sync::{Notify, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

const ROOT: &str = "nesvo://events";
pub(crate) const META_KEY: &str = "nesvo/events";
const MAX_URI: usize = 512;
const MAX_ID: usize = 128;
const MAX_SAFE_CURSOR: u64 = (1 << 53) - 1;
const MAX_STREAMS: usize = 4;
const PAGE_LIMIT: u16 = 32;
const MAX_SEQUENCES: usize = 32;
const FIRST_PAGE_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Subject {
    All,
    Operations,
    Session(String),
    Run(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EventResource {
    subject: Subject,
    after: Option<u64>,
    limit: Option<u16>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn cursor(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
        .filter(|cursor| *cursor <= MAX_SAFE_CURSOR)
}

fn unknown_resource() -> anyhow::Error {
    cli::failure(
        "invalid_argument",
        "Unknown Nesvo event resource; use nesvo://events, /operations, /session/{id} or /run/{id} with optional ?after=CURSOR&limit=1-32",
    )
}

impl EventResource {
    pub(crate) fn parse(uri: &str) -> Result<Self> {
        if uri.len() > MAX_URI {
            return Err(unknown_resource());
        }
        let rest = uri.strip_prefix(ROOT).ok_or_else(unknown_resource)?;
        let (path, query) = match rest.split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (rest, None),
        };
        let subject = match path.split('/').collect::<Vec<_>>().as_slice() {
            [""] => Subject::All,
            ["", "operations"] => Subject::Operations,
            ["", "session", id] if valid_id(id) => Subject::Session((*id).into()),
            ["", "run", id] if valid_id(id) => Subject::Run((*id).into()),
            _ => return Err(unknown_resource()),
        };
        let mut resource = Self {
            subject,
            after: None,
            limit: None,
        };
        for pair in query.into_iter().flat_map(|query| query.split('&')) {
            match pair.split_once('=') {
                Some(("after", value)) if resource.after.is_none() => {
                    resource.after = Some(cursor(value).ok_or_else(unknown_resource)?);
                }
                Some(("limit", value)) if resource.limit.is_none() => {
                    resource.limit = Some(
                        cursor(value)
                            .and_then(|limit| u16::try_from(limit).ok())
                            .filter(|limit| (1..=PAGE_LIMIT).contains(limit))
                            .ok_or_else(unknown_resource)?,
                    );
                }
                _ => return Err(unknown_resource()),
            }
        }
        Ok(resource)
    }

    fn base(&self) -> String {
        match &self.subject {
            Subject::All => ROOT.into(),
            Subject::Operations => format!("{ROOT}/operations"),
            Subject::Session(id) => format!("{ROOT}/session/{id}"),
            Subject::Run(id) => format!("{ROOT}/run/{id}"),
        }
    }

    fn read_uri(&self, after: u64) -> String {
        match self.limit {
            Some(limit) => format!("{}?after={after}&limit={limit}", self.base()),
            None => format!("{}?after={after}", self.base()),
        }
    }

    fn query(&self, kind: &str, after: u64, limit: u16) -> Value {
        let session = match &self.subject {
            Subject::Session(id) => Some(id.as_str()),
            _ => None,
        };
        json!({"type":kind,"after":after,"limit":limit,"sessionId":session})
    }

    fn page_limit(&self) -> u16 {
        self.limit.unwrap_or(PAGE_LIMIT)
    }

    fn matches(&self, event: &Value) -> bool {
        let kind = event["kind"].as_str().and_then(EventKind::parse);
        match &self.subject {
            Subject::All | Subject::Session(_) => true,
            Subject::Operations => kind == Some(EventKind::OperationChanged),
            Subject::Run(id) => {
                kind.is_some_and(EventKind::is_run) && event["payload"]["runId"] == id.as_str()
            }
        }
    }

    fn page(&self, mut page: Value) -> Value {
        if let Some(object) = page.as_object_mut() {
            for transport in ["requestId", "type", "subscribed"] {
                object.remove(transport);
            }
        }
        if let Some(events) = page["events"].as_array_mut() {
            events.retain(|event| self.matches(event));
        }
        page["resource"] = self.base().into();
        page
    }
}

#[derive(Debug, Default, PartialEq)]
struct Delta {
    after: Option<u64>,
    next_cursor: u64,
    head_cursor: u64,
    sequences: VecDeque<u64>,
    dropped: u64,
    gap: bool,
    ready: bool,
    closed: Option<(String, String)>,
}

impl Delta {
    fn starting(cursor: u64) -> Self {
        Self {
            after: Some(cursor),
            next_cursor: cursor,
            head_cursor: cursor,
            ready: true,
            ..Self::default()
        }
    }

    fn absorb(&mut self, resource: &EventResource, requested: u64, page: &Value) {
        let next = page["nextCursor"].as_u64().unwrap_or(requested);
        let gap = page["gap"] == true;
        let matched: Vec<u64> = page["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|event| resource.matches(event))
            .filter_map(|event| event["sequence"].as_u64())
            .collect();
        if let Some(first) = matched.first().filter(|_| !gap) {
            self.after.get_or_insert(first.saturating_sub(1));
        }
        if gap {
            self.after.get_or_insert(requested);
            self.gap = true;
        }
        for sequence in matched {
            self.sequences.push_back(sequence);
            if self.sequences.len() > MAX_SEQUENCES {
                self.sequences.pop_front();
                self.dropped += 1;
            }
        }
        self.next_cursor = next;
        self.head_cursor = page["headCursor"].as_u64().unwrap_or(next).max(next);
    }

    fn pending(&self) -> bool {
        self.after.is_some() || self.closed.is_some()
    }

    fn take(&mut self) -> Option<Self> {
        self.pending().then(|| {
            let rest = Self {
                next_cursor: self.next_cursor,
                head_cursor: self.head_cursor,
                ..Self::default()
            };
            std::mem::replace(self, rest)
        })
    }

    fn meta(&self, resource: &EventResource) -> Value {
        let after = self.after.unwrap_or(self.next_cursor);
        let mut meta = json!({
            "schemaVersion":1,
            "resource":resource.base(),
            "readUri":resource.read_uri(after),
            "after":after,
            "nextCursor":self.next_cursor,
            "headCursor":self.head_cursor,
            "sequences":self.sequences,
            "dropped":self.dropped,
            "gap":self.gap,
            "ready":self.ready,
        });
        if let Some((code, message)) = &self.closed {
            meta["closed"] = json!({"code":code,"message":message});
        }
        meta
    }
}

#[derive(Default)]
struct Shared {
    delta: Mutex<Delta>,
    wake: Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Delta> {
        self.delta.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn update(&self, change: impl FnOnce(&mut Delta)) {
        let pending = {
            let mut delta = self.lock();
            change(&mut delta);
            delta.pending()
        };
        if pending {
            self.wake.notify_one();
        }
    }
}

struct Stream {
    connection: Connection,
    resource: EventResource,
    uri: String,
    request_id: String,
    cursor: u64,
    shared: Arc<Shared>,
}

impl Stream {
    async fn step(&mut self) -> Option<(String, String)> {
        loop {
            match self.connection.events.recv().await {
                Some(NetworkEvent::Message(value))
                    if value["requestId"] == self.request_id.as_str() =>
                {
                    if value["type"] == "error" {
                        return Some((
                            value["code"]
                                .as_str()
                                .unwrap_or("request_rejected")
                                .to_owned(),
                            value["message"]
                                .as_str()
                                .unwrap_or("Event subscription failed")
                                .to_owned(),
                        ));
                    }
                    if value["type"] != "events" {
                        continue;
                    }
                    let requested = self.cursor;
                    self.cursor = value["nextCursor"].as_u64().unwrap_or(requested);
                    let resource = &self.resource;
                    self.shared
                        .update(|delta| delta.absorb(resource, requested, &value));
                    return (value["gap"] == true).then(|| {
                        (
                            "cursor_expired".to_owned(),
                            "Event retention expired; reconcile current state before resubscribing"
                                .to_owned(),
                        )
                    });
                }
                Some(NetworkEvent::Disconnected(_)) | None => {
                    return Some((
                        "disconnected".to_owned(),
                        "Host event connection closed; resubscribe from the last notified cursor"
                            .to_owned(),
                    ));
                }
                _ => {}
            }
        }
    }

    async fn pump(&mut self) {
        loop {
            if let Some(closed) = self.step().await {
                self.shared.update(|delta| delta.closed = Some(closed));
                return;
            }
        }
    }
}

#[derive(Clone)]
enum Outlet {
    Listen(SubscriptionSink),
    Legacy(Peer<RoleServer>),
}

impl Outlet {
    async fn send(&self, notification: ServerNotification) -> bool {
        match self {
            Self::Listen(sink) => sink.send(notification).await.is_ok(),
            Self::Legacy(peer) => peer.send_notification(notification).await.is_ok(),
        }
    }
}

pub(crate) fn notification(uri: &str, meta: Value) -> ServerNotification {
    let mut notification =
        ResourceUpdatedNotification::new(ResourceUpdatedNotificationParam::new(uri));
    let mut extensions = NotificationMetaObject::new();
    extensions.insert(META_KEY.to_owned(), meta);
    notification.extensions.insert(extensions);
    ServerNotification::ResourceUpdatedNotification(notification)
}

async fn forward(mut stream: Stream, outlet: Outlet, stop: CancellationToken) {
    let shared = stream.shared.clone();
    let uri = stream.uri.clone();
    let resource = stream.resource.clone();
    let reader = async {
        stream.pump().await;
        future::pending::<()>().await;
    };
    let sender = async {
        loop {
            shared.wake.notified().await;
            let Some(delta) = shared.lock().take() else {
                continue;
            };
            if !outlet.send(notification(&uri, delta.meta(&resource))).await
                || delta.closed.is_some()
            {
                return;
            }
        }
    };
    tokio::select! {
        _ = stop.cancelled() => {}
        _ = sender => {}
        _ = reader => {}
    }
}

async fn connect(pairing: &Path, url: Option<&str>) -> Result<Connection> {
    let pairing = Pairing::load(pairing, url).map_err(|_| {
        cli::failure(
            "pairing_unavailable",
            "Cannot load the private caller context; never substitute an owner key for a worker",
        )
    })?;
    let mut connection = Connection::open(pairing).await.map_err(|error| {
        cli::failure(
            "host_unavailable",
            &open_failure_message(&error, "Cannot authenticate with the paired host"),
        )
    })?;
    let caps = cli::request(
        &mut connection,
        json!({"type":"getCapabilities"}),
        "capabilities",
    )
    .await?;
    if caps["domainEvents"] != true {
        return Err(cli::failure(
            "unsupported",
            "Host does not support durable events; update nesvo-host",
        ));
    }
    Ok(connection)
}

fn reserve(permits: &Arc<Semaphore>) -> Result<OwnedSemaphorePermit> {
    permits.clone().try_acquire_owned().map_err(|_| {
        cli::failure(
            "busy",
            "Four event subscriptions are already active; unsubscribe before adding another",
        )
    })
}

async fn open(pairing: &Path, url: Option<&str>, uri: &str) -> Result<Stream> {
    let resource = EventResource::parse(uri)?;
    let mut connection = connect(pairing, url).await?;
    let start = match resource.after {
        Some(after) => after,
        None => cli::request(
            &mut connection,
            resource.query("readEvents", 0, 1),
            "events",
        )
        .await?["headCursor"]
            .as_u64()
            .unwrap_or(0),
    };
    let request_id = format!("mcp-events-{}", hex::encode(nesvo_wire::random::<8>()));
    let mut query = resource.query("subscribeEvents", start, resource.page_limit());
    query["requestId"] = request_id.clone().into();
    connection
        .send(query)
        .map_err(|_| cli::failure("disconnected", "Host connection is closed"))?;
    let mut stream = Stream {
        connection,
        resource,
        uri: uri.to_owned(),
        request_id,
        cursor: start,
        shared: Arc::new(Shared {
            delta: Mutex::new(Delta::starting(start)),
            wake: Notify::new(),
        }),
    };
    match tokio::time::timeout(FIRST_PAGE_DEADLINE, stream.step()).await {
        Ok(None) => Ok(stream),
        Ok(Some((code, message))) => Err(cli::failure(&code, &message)),
        Err(_) => Err(cli::failure(
            "timeout",
            "Host did not start the event subscription; nothing was retried",
        )),
    }
}

fn error_data(error: &anyhow::Error) -> ErrorData {
    let value = cli::error_value(error);
    let detail = value["error"].clone();
    let message = detail["message"]
        .as_str()
        .unwrap_or("Event resource request failed")
        .to_owned();
    if detail["retryable"] == true {
        ErrorData::internal_error(message, Some(detail))
    } else {
        ErrorData::invalid_request(message, Some(detail))
    }
}

fn not_found(error: &anyhow::Error) -> ErrorData {
    let detail = cli::error_value(error)["error"].clone();
    ErrorData::resource_not_found(
        detail["message"]
            .as_str()
            .unwrap_or("Unknown Nesvo event resource")
            .to_owned(),
        Some(detail),
    )
}

pub(crate) fn single_page(request: Option<&PaginatedRequestParams>) -> Result<(), ErrorData> {
    if request.is_some_and(|request| request.cursor.is_some()) {
        return Err(ErrorData::invalid_params(
            "Resource catalog fits one page; omit cursor",
            None,
        ));
    }
    Ok(())
}

pub(crate) fn resources() -> ListResourcesResult {
    ListResourcesResult::with_all_items(vec![
        Resource::new(ROOT, "nesvo-events")
            .with_title("Visible host events")
            .with_description("Bounded readEvents page for every subject this caller may read. Append ?after=CURSOR&limit=1-32.")
            .with_mime_type("application/json"),
        Resource::new(format!("{ROOT}/operations"), "nesvo-operation-events")
            .with_title("Operation receipt events")
            .with_description("operation.changed receipt phases visible to this caller. Append ?after=CURSOR&limit=1-32.")
            .with_mime_type("application/json"),
    ])
}

pub(crate) fn templates() -> ListResourceTemplatesResult {
    ListResourceTemplatesResult::with_all_items(vec![
        ResourceTemplate::new(
            format!("{ROOT}/session/{{sessionId}}{{?after,limit}}"),
            "nesvo-session-events",
        )
        .with_title("Session events")
        .with_description("Host-filtered events of one stable session ID")
        .with_mime_type("application/json"),
        ResourceTemplate::new(
            format!("{ROOT}/run/{{runId}}{{?after,limit}}"),
            "nesvo-run-events",
        )
        .with_title("Run journal events")
        .with_description("run.* journal events of one workflow run visible to this caller")
        .with_mime_type("application/json"),
    ])
}

pub(crate) async fn read(
    pairing: &Path,
    url: Option<&str>,
    slots: &Semaphore,
    uri: &str,
    cancellation: &CancellationToken,
) -> Result<ReadResourceResult, ErrorData> {
    let resource = EventResource::parse(uri).map_err(|error| not_found(&error))?;
    let page = async {
        let _permit = slots.try_acquire().map_err(|_| {
            cli::failure(
                "busy",
                "Four host calls are already pending; wait for a result before retrying",
            )
        })?;
        let mut connection = connect(pairing, url).await?;
        cli::request(
            &mut connection,
            resource.query(
                "readEvents",
                resource.after.unwrap_or(0),
                resource.page_limit(),
            ),
            "events",
        )
        .await
    };
    let page = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cli::failure("canceled", "Resource read canceled")),
        page = page => page,
    }
    .map_err(|error| error_data(&error))?;
    let text = json!({"schemaVersion":1,"ok":true,"data":resource.page(page)}).to_string();
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(text, uri).with_mime_type("application/json"),
    ])
    .with_ttl_ms(0)
    .with_cache_scope(CacheScope::Private))
}

struct LegacyStream {
    stop: CancellationToken,
    task: JoinHandle<()>,
    _slot: OwnedSemaphorePermit,
}

type Started = (CancellationToken, JoinHandle<()>);

pub(crate) struct EventBridge {
    permits: Arc<Semaphore>,
    legacy: Mutex<HashMap<String, LegacyStream>>,
    closed: CancellationToken,
}

impl Default for EventBridge {
    fn default() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_STREAMS)),
            legacy: Mutex::default(),
            closed: CancellationToken::new(),
        }
    }
}

impl EventBridge {
    pub(crate) fn closed(&self) -> CancellationToken {
        self.closed.clone()
    }

    pub(crate) fn accepted(requested: &SubscriptionFilter) -> SubscriptionFilter {
        SubscriptionFilter::builder()
            .resource_subscriptions(
                requested
                    .resource_subscriptions
                    .iter()
                    .flatten()
                    .filter(|uri| EventResource::parse(uri).is_ok())
                    .take(MAX_STREAMS)
                    .cloned(),
            )
            .build()
    }

    fn reserve_all(&self, count: usize) -> Result<Vec<OwnedSemaphorePermit>, ErrorData> {
        (0..count)
            .map(|_| reserve(&self.permits))
            .collect::<Result<_>>()
            .map_err(|error| error_data(&error))
    }

    pub(crate) async fn listen(
        &self,
        pairing: &Path,
        url: Option<&str>,
        context: SubscriptionContext,
    ) -> Result<(), ErrorData> {
        let uris = context
            .accepted()
            .resource_subscriptions
            .clone()
            .unwrap_or_default();
        let slots = self.reserve_all(uris.len())?;
        let streams = tokio::select! {
            _ = context.cancelled() => return Ok(()),
            streams = future::try_join_all(uris.iter().map(|uri| open(pairing, url, uri))) => streams,
        }
        .map_err(|error| error_data(&error))?;
        let outlet = Outlet::Listen(context.sink().clone());
        let stop = self.closed.child_token();
        let forwards = streams.into_iter().zip(slots).map(|(stream, slot)| {
            let outlet = outlet.clone();
            let stop = stop.clone();
            async move {
                forward(stream, outlet, stop).await;
                drop(slot);
            }
        });
        tokio::select! {
            _ = context.cancelled() => {}
            _ = future::join_all(forwards) => {}
        }
        Ok(())
    }

    fn streams(&self) -> MutexGuard<'_, HashMap<String, LegacyStream>> {
        let mut streams = self.legacy.lock().unwrap_or_else(PoisonError::into_inner);
        streams.retain(|_, stream| !stream.task.is_finished());
        streams
    }

    async fn release(&self, uri: &str) {
        let previous = self.streams().remove(uri);
        if let Some(previous) = previous {
            previous.stop.cancel();
            let _ = previous.task.await;
        }
    }

    async fn replace(
        &self,
        uri: &str,
        start: impl Future<Output = Result<Started>>,
    ) -> Result<(), ErrorData> {
        let reserved = if self.streams().contains_key(uri) {
            None
        } else {
            Some(reserve(&self.permits).map_err(|error| error_data(&error))?)
        };
        let (stop, task) = start.await.map_err(|error| error_data(&error))?;
        let previous = {
            let mut streams = self.streams();
            if let Some(entry) = streams.get_mut(uri) {
                Some((
                    std::mem::replace(&mut entry.stop, stop),
                    std::mem::replace(&mut entry.task, task),
                ))
            } else {
                let slot = match reserved.map_or_else(|| reserve(&self.permits), Ok) {
                    Ok(slot) => slot,
                    Err(error) => {
                        stop.cancel();
                        return Err(error_data(&error));
                    }
                };
                streams.insert(
                    uri.to_owned(),
                    LegacyStream {
                        stop,
                        task,
                        _slot: slot,
                    },
                );
                None
            }
        };
        if let Some((stop, task)) = previous {
            stop.cancel();
            let _ = task.await;
        }
        Ok(())
    }

    pub(crate) async fn subscribe(
        &self,
        pairing: &Path,
        url: Option<&str>,
        uri: String,
        peer: Peer<RoleServer>,
    ) -> Result<(), ErrorData> {
        EventResource::parse(&uri).map_err(|error| not_found(&error))?;
        let start = async {
            let stream = open(pairing, url, &uri).await?;
            let stop = self.closed.child_token();
            let task = tokio::spawn(forward(stream, Outlet::Legacy(peer), stop.clone()));
            Ok((stop, task))
        };
        self.replace(&uri, start).await
    }

    pub(crate) async fn unsubscribe(&self, uri: &str) -> Result<(), ErrorData> {
        self.release(uri).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn page(after: u64, events: Value, gap: bool) -> Value {
        let next = events
            .as_array()
            .and_then(|events| events.last())
            .and_then(|event| event["sequence"].as_u64())
            .unwrap_or(after);
        json!({"type":"events","events":events,"nextCursor":next,"headCursor":next + 3,"gap":gap,"more":false})
    }

    fn event(sequence: u64, kind: &str, run: Option<&str>) -> Value {
        json!({"sequence":sequence,"sessionId":"s1","kind":kind,"at":1,"payload":{"runId":run}})
    }

    #[test]
    fn mcp_event_resource_names_round_trip_and_reject_ambiguous_uris() {
        for (uri, base) in [
            ("nesvo://events", "nesvo://events"),
            ("nesvo://events/operations", "nesvo://events/operations"),
            (
                "nesvo://events/session/ab-12_c",
                "nesvo://events/session/ab-12_c",
            ),
            ("nesvo://events/run/R1?after=7", "nesvo://events/run/R1"),
            ("nesvo://events?limit=5&after=0", "nesvo://events"),
        ] {
            assert_eq!(EventResource::parse(uri).unwrap().base(), base, "{uri}");
        }
        let limited = EventResource::parse("nesvo://events/session/a?limit=4&after=9").unwrap();
        assert_eq!((limited.after, limited.limit), (Some(9), Some(4)));
        assert_eq!(
            limited.read_uri(12),
            "nesvo://events/session/a?after=12&limit=4"
        );
        assert_eq!(
            limited.query("readEvents", 12, limited.page_limit()),
            json!({"type":"readEvents","after":12,"limit":4,"sessionId":"a"})
        );
        assert_eq!(
            EventResource::parse("nesvo://events/run/r")
                .unwrap()
                .query("subscribeEvents", 3, 32)["sessionId"],
            Value::Null
        );
        let long = format!("nesvo://events/session/{}", "a".repeat(129));
        for uri in [
            "nesvo://event",
            "nesvo://events/",
            "nesvo://events?",
            "nesvo://events/session/",
            "nesvo://events/session/a/b",
            "nesvo://events/session/a%2Fb",
            "nesvo://events/run/a b",
            "nesvo://events/unknown/a",
            "nesvo://events?after=-1",
            "nesvo://events?after=1&after=2",
            "nesvo://events?after=9007199254740992",
            "nesvo://events?limit=0",
            "nesvo://events?limit=33",
            "nesvo://events?cursor=1",
            "file://events",
            long.as_str(),
        ] {
            let error = EventResource::parse(uri).unwrap_err();
            assert_eq!(
                cli::error_value(&error)["error"]["code"],
                "invalid_argument",
                "{uri}"
            );
        }
    }

    #[test]
    fn mcp_event_filters_match_operations_and_run_journal_only() {
        let operation = event(1, "operation.changed", None);
        let run = event(2, "run.created", Some("R1"));
        let other_run = event(3, "run.created", Some("R2"));
        let session = event(4, "session.created", Some("R1"));
        let operations = EventResource::parse("nesvo://events/operations").unwrap();
        let runs = EventResource::parse("nesvo://events/run/R1").unwrap();
        assert!(operations.matches(&operation) && !operations.matches(&run));
        assert!(runs.matches(&run) && !runs.matches(&other_run) && !runs.matches(&session));
        let filtered = runs.page(json!({
            "type":"events",
            "subscribed":false,
            "requestId":"x",
            "events":[operation,run,other_run,session],
            "nextCursor":4
        }));
        assert_eq!(filtered["events"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["nextCursor"], 4);
        assert_eq!(filtered["resource"], "nesvo://events/run/R1");
        for transport in ["requestId", "type", "subscribed"] {
            assert!(filtered.get(transport).is_none(), "{transport}");
        }
    }

    #[test]
    fn mcp_event_filters_follow_the_typed_event_kinds() {
        let operations = EventResource::parse("nesvo://events/operations").unwrap();
        let runs = EventResource::parse("nesvo://events/run/R1").unwrap();
        let mut run_kinds = 0;
        for kind in nesvo_wire::events::Event::KINDS {
            let typed = EventKind::parse(kind).unwrap();
            let journaled = event(1, kind, Some("R1"));
            assert_eq!(
                operations.matches(&journaled),
                typed == EventKind::OperationChanged,
                "{kind}"
            );
            assert_eq!(runs.matches(&journaled), typed.is_run(), "{kind}");
            run_kinds += usize::from(typed.is_run());
        }
        assert!(run_kinds > 0);
        assert!(operations.matches(&event(1, EventKind::OperationChanged.as_str(), None)));
        assert!(!runs.matches(&event(1, "run.unknown", Some("R1"))));
    }

    #[test]
    fn mcp_event_delta_reports_the_cursor_before_the_first_unread_match() {
        let runs = EventResource::parse("nesvo://events/run/R1").unwrap();
        let mut delta = Delta::starting(10);
        let ready = delta.take().unwrap();
        assert_eq!(ready.meta(&runs)["ready"], true);
        assert_eq!(
            ready.meta(&runs)["readUri"],
            "nesvo://events/run/R1?after=10"
        );
        assert!(delta.take().is_none());
        delta.absorb(
            &runs,
            10,
            &page(10, json!([event(11, "operation.changed", None)]), false),
        );
        assert!(delta.take().is_none(), "Unmatched pages advance silently");
        assert_eq!(delta.next_cursor, 11);
        delta.absorb(
            &runs,
            11,
            &page(
                11,
                json!([
                    event(12, "session.created", None),
                    event(13, "run.activated", Some("R1"))
                ]),
                false,
            ),
        );
        delta.absorb(
            &runs,
            13,
            &page(
                13,
                json!([event(14, "run.plan_changed", Some("R1"))]),
                false,
            ),
        );
        let meta = delta.take().unwrap().meta(&runs);
        assert_eq!(meta["after"], 12);
        assert_eq!(meta["readUri"], "nesvo://events/run/R1?after=12");
        assert_eq!(meta["nextCursor"], 14);
        assert_eq!(meta["headCursor"], 17);
        assert_eq!(meta["sequences"], json!([13, 14]));
        assert_eq!(
            (meta["gap"].clone(), meta["ready"].clone()),
            (json!(false), json!(false))
        );
        assert!(meta.get("closed").is_none());
        assert_eq!(delta.next_cursor, 14, "Taking keeps the stream cursor");
    }

    #[test]
    fn mcp_event_delta_drops_oldest_sequences_with_a_visible_marker() {
        let all = EventResource::parse("nesvo://events").unwrap();
        let mut delta = Delta::default();
        for sequence in 1..=40 {
            delta.absorb(
                &all,
                sequence - 1,
                &page(
                    sequence - 1,
                    json!([event(sequence, "session.created", None)]),
                    false,
                ),
            );
        }
        let meta = delta.take().unwrap().meta(&all);
        assert_eq!(
            meta["after"], 0,
            "The cursor still covers every dropped sequence"
        );
        assert_eq!(meta["dropped"], 8);
        assert_eq!(meta["sequences"].as_array().unwrap().len(), MAX_SEQUENCES);
        assert_eq!(meta["sequences"][0], 9);
        assert_eq!(meta["nextCursor"], 40);
    }

    fn scripted(uri: &str, cursor: u64) -> (Stream, mpsc::Sender<NetworkEvent>) {
        let (connection, events) = Connection::scripted();
        let stream = Stream {
            connection,
            resource: EventResource::parse(uri).unwrap(),
            uri: uri.to_owned(),
            request_id: "r1".into(),
            cursor,
            shared: Arc::new(Shared {
                delta: Mutex::new(Delta::starting(cursor)),
                wake: Notify::new(),
            }),
        };
        (stream, events)
    }

    fn frame(mut value: Value) -> NetworkEvent {
        value["requestId"] = "r1".into();
        NetworkEvent::Message(value)
    }

    async fn feed(events: &mpsc::Sender<NetworkEvent>, frames: Vec<NetworkEvent>) {
        for frame in frames {
            events.send(frame).await.unwrap();
        }
    }

    fn closed_meta(stream: &Stream) -> Value {
        stream.shared.lock().take().unwrap().meta(&stream.resource)
    }

    #[tokio::test]
    async fn mcp_event_stream_closes_with_cursor_expired_on_a_retention_gap() {
        let (mut stream, events) = scripted("nesvo://events/session/s1", 5);
        feed(
            &events,
            vec![frame(page(
                5,
                json!([event(90, "session.created", None)]),
                true,
            ))],
        )
        .await;
        stream.pump().await;
        let meta = closed_meta(&stream);
        assert_eq!(meta["after"], 5);
        assert_eq!(meta["gap"], true);
        assert_eq!(meta["sequences"], json!([90]));
        assert_eq!(meta["closed"]["code"], "cursor_expired");
    }

    #[tokio::test]
    async fn mcp_event_stream_closes_with_the_host_error_after_delivered_pages() {
        let (mut stream, events) = scripted("nesvo://events/operations", 4);
        feed(
            &events,
            vec![
                frame(page(4, json!([event(5, "operation.changed", None)]), false)),
                NetworkEvent::Message(
                    json!({"type":"error","code":"forbidden","requestId":"other"}),
                ),
                frame(json!({"type":"eventsUnsubscribed"})),
                frame(json!({
                    "type":"error",
                    "code":"scope_revoked",
                    "message":"Event subscription authority has expired"
                })),
            ],
        )
        .await;
        stream.pump().await;
        assert_eq!(stream.cursor, 5);
        let meta = closed_meta(&stream);
        assert_eq!(meta["sequences"], json!([5]));
        assert_eq!(
            meta["closed"],
            json!({"code":"scope_revoked","message":"Event subscription authority has expired"})
        );
    }

    #[tokio::test]
    async fn mcp_event_stream_closes_as_disconnected_when_the_host_connection_ends() {
        let (mut stream, events) = scripted("nesvo://events", 2);
        feed(&events, vec![NetworkEvent::Disconnected("reset".into())]).await;
        assert_eq!(stream.step().await.unwrap().0, "disconnected");
        drop(events);
        stream.pump().await;
        assert_eq!(closed_meta(&stream)["closed"]["code"], "disconnected");
    }

    async fn idle(stop: CancellationToken) -> Result<Started> {
        let task = tokio::spawn({
            let stop = stop.clone();
            async move { stop.cancelled().await }
        });
        Ok((stop, task))
    }

    fn refused(code: &str) -> impl Future<Output = Result<Started>> {
        let error = cli::failure(code, "Replacement did not open");
        async move { Err(error) }
    }

    fn code(error: ErrorData) -> Value {
        error.data.unwrap()["code"].clone()
    }

    #[tokio::test]
    async fn mcp_event_listen_refuses_a_fifth_stream_before_opening_any() {
        let bridge = EventBridge::default();
        let held = bridge.reserve_all(MAX_STREAMS).unwrap();
        assert_eq!(code(bridge.reserve_all(1).unwrap_err()), "busy");
        assert_eq!(bridge.permits.available_permits(), 0);
        drop(held);
        assert!(bridge.reserve_all(MAX_STREAMS + 1).is_err());
        assert_eq!(bridge.permits.available_permits(), MAX_STREAMS);
    }

    #[tokio::test]
    async fn mcp_event_legacy_resubscribe_keeps_the_old_stream_until_the_new_one_opens() {
        let bridge = EventBridge::default();
        let uri = "nesvo://events/operations";
        let first = CancellationToken::new();
        bridge.replace(uri, idle(first.clone())).await.unwrap();
        let failed = bridge
            .replace(uri, refused("host_unavailable"))
            .await
            .unwrap_err();
        assert_eq!(code(failed), "host_unavailable");
        assert!(!first.is_cancelled());
        assert!(!bridge.streams()[uri].task.is_finished());
        assert_eq!(bridge.permits.available_permits(), MAX_STREAMS - 1);

        for index in 1..MAX_STREAMS {
            let other = format!("nesvo://events/session/s{index}");
            bridge
                .replace(&other, idle(CancellationToken::new()))
                .await
                .unwrap();
        }
        let second = CancellationToken::new();
        bridge.replace(uri, idle(second.clone())).await.unwrap();
        assert!(first.is_cancelled() && !second.is_cancelled());
        assert_eq!(bridge.permits.available_permits(), 0);
        let fifth = bridge
            .replace("nesvo://events", refused("must_not_open"))
            .await
            .unwrap_err();
        assert_eq!(code(fifth), "busy");

        bridge.unsubscribe(uri).await.unwrap();
        assert!(second.is_cancelled());
        assert_eq!(bridge.permits.available_permits(), 1);
    }

    #[test]
    fn mcp_event_notification_carries_the_cursor_meta_on_the_resource_uri() {
        let uri = "nesvo://events/operations";
        let value = serde_json::to_value(notification(uri, json!({"after":3}))).unwrap();
        assert_eq!(value["method"], "notifications/resources/updated");
        assert_eq!(value["params"]["uri"], uri);
        assert_eq!(value["params"]["_meta"][META_KEY]["after"], 3);
    }

    #[test]
    fn mcp_event_subscriptions_accept_only_valid_uris_within_the_stream_bound() {
        let requested = SubscriptionFilter::builder()
            .tools_list_changed()
            .resource_subscriptions([
                "nesvo://events",
                "nesvo://unknown",
                "nesvo://events/operations",
                "nesvo://events/session/a",
                "nesvo://events/run/b",
                "nesvo://events/session/c",
            ])
            .build();
        let accepted = EventBridge::accepted(&requested);
        assert_eq!(accepted.tools_list_changed, None);
        assert_eq!(
            accepted.resource_subscriptions.unwrap(),
            [
                "nesvo://events",
                "nesvo://events/operations",
                "nesvo://events/session/a",
                "nesvo://events/run/b",
            ]
        );
        assert!(single_page(None).is_ok());
    }
}
