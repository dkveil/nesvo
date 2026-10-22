use crate::{
    event_log::Service,
    job_triggers::{Acceptance, Inbound, Provider},
};
use anyhow::{Context, Result, anyhow};
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::{
    HeaderMap, Method, Request, Response, StatusCode, Version,
    body::{Body, Bytes},
    header::{self, HeaderValue},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use std::{convert::Infallible, error::Error, net::Ipv4Addr, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const MAX_CONNECTIONS: usize = 8;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_BODY_BYTES: usize = 256 * 1024;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_TIMEOUT: Duration = Duration::from_secs(2);
const ROUTE: &str = "/v1/job-triggers/";
const WEBHOOK_HEADERS: [&str; 3] = ["x-nesvo-delivery", "x-nesvo-event", "x-nesvo-signature-256"];
const GITHUB_HEADERS: [&str; 3] = ["x-github-delivery", "x-github-event", "x-hub-signature-256"];

pub struct Listener {
    address: String,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<()>>>,
    exited: watch::Receiver<Option<bool>>,
}
impl Listener {
    pub async fn bind(port: u16, log: Service) -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .context("Could not bind the loopback job webhook listener")?;
        let address = format!("http://{}", listener.local_addr()?);
        let (stop, stopped) = oneshot::channel();
        let (exit, exited) = watch::channel(None);
        let task = tokio::spawn(async move {
            let result = run(listener, log, stopped).await;
            exit.send_replace(Some(result.is_err()));
            result
        });
        Ok(Self {
            address,
            stop: Some(stop),
            task: Some(task),
            exited,
        })
    }
    pub fn address(&self) -> String {
        self.address.clone()
    }
    pub fn exit_notification(&self) -> watch::Receiver<Option<bool>> {
        self.exited.clone()
    }
    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(mut task) = self.task.take() {
            match timeout(Duration::from_secs(2), &mut task).await {
                Ok(result) => result.context("Job webhook listener stopped unexpectedly")??,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    return Err(anyhow!("Job webhook listener shutdown timed out"));
                }
            }
        }
        Ok(())
    }
}

pub async fn wait_for_exit(mut exited: watch::Receiver<Option<bool>>) -> bool {
    loop {
        let result = *exited.borrow_and_update();
        if let Some(failed) = result {
            return failed;
        }
        if exited.changed().await.is_err() {
            return true;
        }
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn run(listener: TcpListener, log: Service, mut stop: oneshot::Receiver<()>) -> Result<()> {
    let mut connections = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut stop => break Ok(()),
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (socket, _) = match accepted {
                    Ok(socket) => socket,
                    Err(_) => break Err(anyhow!("Job webhook listener could not accept a connection")),
                };
                if connections.len() >= MAX_CONNECTIONS {
                    drop(socket);
                    continue;
                }
                let log = log.clone();
                connections.spawn(async move {
                    let _ = timeout(CONNECTION_TIMEOUT, serve(socket, log)).await;
                });
            }
        }
    };
    drop(listener);
    if timeout(Duration::from_secs(1), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    result
}

async fn serve(socket: TcpStream, log: Service) {
    let _ = socket.set_nodelay(true);
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .max_headers(MAX_HEADERS)
        .max_header_size(MAX_HEADER_BYTES)
        .max_buf_size(MAX_HEADER_BYTES)
        .keep_alive(false);
    let service = service_fn(move |request| {
        let log = log.clone();
        async move {
            let response = match decode(request).await {
                Ok(inbound) => match log.external_trigger(inbound).await {
                    Ok(accepted) => accepted_response(accepted),
                    Err(error) => journal_rejection(&error).response(),
                },
                Err(error) => error.response(),
            };
            Ok::<_, Infallible>(response)
        }
    });
    let _ = builder
        .serve_connection(TokioIo::new(socket), service)
        .await;
}

#[derive(Debug)]
struct Rejection {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}
impl Rejection {
    fn invalid() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_argument",
            message: "Invalid job webhook request",
        }
    }
    fn oversized() -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "trigger_payload_too_large",
            message: "Job webhook payload exceeds the limit",
        }
    }
    fn response(self) -> Response<Full<Bytes>> {
        response(
            self.status,
            json!({"schemaVersion":1,"ok":false,"error":{"code":self.code,"message":self.message,"retryable":matches!(self.status,StatusCode::TOO_MANY_REQUESTS|StatusCode::SERVICE_UNAVAILABLE)}}),
        )
    }
}

fn journal_rejection(error: &anyhow::Error) -> Rejection {
    let code = error
        .downcast_ref::<crate::api_error::Error>()
        .map(|error| error.code);
    match code {
        Some("invalid_argument") => Rejection::invalid(),
        Some("trigger_unauthorized") => Rejection {
            status: StatusCode::UNAUTHORIZED,
            code: "trigger_unauthorized",
            message: "Job webhook authentication failed",
        },
        Some("trigger_payload_too_large") => Rejection::oversized(),
        Some("trigger_rate_limited") => Rejection {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "trigger_rate_limited",
            message: "Job webhook rate limit exceeded",
        },
        _ => Rejection {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "busy",
            message: "Job webhook admission is unavailable; recover the same delivery",
        },
    }
}

fn response(status: StatusCode, body: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
fn accepted_response(accepted: Acceptance) -> Response<Full<Bytes>> {
    let mut data = accepted.view;
    let Some(object) = data.as_object_mut() else {
        return journal_rejection(&anyhow!("Invalid stored job webhook receipt")).response();
    };
    object.insert("type".into(), "workflow".into());
    response(
        if accepted.replayed {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        },
        json!({"schemaVersion":1,"ok":true,"data":data}),
    )
}

fn single<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, Rejection> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().ok_or_else(Rejection::invalid)?;
    if values.next().is_some() {
        return Err(Rejection::invalid());
    }
    value.to_str().map_err(|_| Rejection::invalid())
}

fn media_type(value: &str) -> bool {
    let mut parts = value.split(';');
    if !parts
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    if let Some(parameter) = parts.next() {
        let Some((key, value)) = parameter.trim().split_once('=') else {
            return false;
        };
        if !key.trim().eq_ignore_ascii_case("charset")
            || !value.trim().eq_ignore_ascii_case("utf-8")
        {
            return false;
        }
    }
    parts.next().is_none()
}

fn request_head<B>(request: &Request<B>) -> Result<Inbound, Rejection> {
    let uri = request.uri();
    let trigger_id = uri.path().strip_prefix(ROUTE).unwrap_or("");
    if request.method() != Method::POST
        || request.version() != Version::HTTP_11
        || uri.scheme().is_some()
        || uri.authority().is_some()
        || uri.query().is_some()
        || trigger_id.len() != 32
        || !trigger_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Rejection::invalid());
    }
    let headers = request.headers();
    if headers.len() > MAX_HEADERS
        || headers
            .iter()
            .try_fold(
                request.method().as_str().len() + uri.path().len() + 16,
                |size, (name, value)| {
                    size.checked_add(name.as_str().len() + value.as_bytes().len() + 4)
                },
            )
            .is_none_or(|size| size > MAX_HEADER_BYTES)
        || [
            header::UPGRADE,
            header::EXPECT,
            header::CONTENT_ENCODING,
            header::TRAILER,
            header::TRANSFER_ENCODING,
            header::AUTHORIZATION,
        ]
        .iter()
        .any(|name| headers.contains_key(name))
        || headers.contains_key("x-nesvo-scope")
    {
        return Err(Rejection::invalid());
    }
    let host = single(headers, "host")?;
    if host.is_empty()
        || host
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte == b',')
    {
        return Err(Rejection::invalid());
    }
    if !media_type(single(headers, "content-type")?) {
        return Err(Rejection {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            code: "invalid_argument",
            message: "Job webhooks require application/json with UTF-8 encoding",
        });
    }
    let length = single(headers, "content-length")?
        .parse::<u64>()
        .map_err(|_| Rejection::invalid())?;
    if length > MAX_BODY_BYTES as u64 {
        return Err(Rejection::oversized());
    }
    if headers.contains_key(header::CONNECTION)
        && single(headers, "connection")?
            .split(',')
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    {
        return Err(Rejection::invalid());
    }
    let webhook = WEBHOOK_HEADERS
        .iter()
        .any(|name| headers.contains_key(*name));
    let github = GITHUB_HEADERS
        .iter()
        .any(|name| headers.contains_key(*name));
    let (provider, names) = match (webhook, github) {
        (true, false) => (Provider::Webhook, WEBHOOK_HEADERS),
        (false, true) => (Provider::Github, GITHUB_HEADERS),
        _ => return Err(Rejection::invalid()),
    };
    let delivery_id = single(headers, names[0])?;
    let event = single(headers, names[1])?;
    let signature = single(headers, names[2])?;
    if delivery_id.is_empty()
        || delivery_id.len() > 128
        || !delivery_id
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b',')
        || event.is_empty()
        || event.len() > 64
        || !event
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
        || signature.len() != 71
        || !signature.strip_prefix("sha256=").is_some_and(|value| {
            value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return Err(Rejection::invalid());
    }
    Ok(Inbound {
        provider,
        trigger_id: trigger_id.into(),
        delivery_id: delivery_id.into(),
        event: event.into(),
        signature: signature.into(),
        body: Vec::new(),
    })
}

async fn decode<B>(request: Request<B>) -> Result<Inbound, Rejection>
where
    B: Body,
    B::Error: Into<Box<dyn Error + Send + Sync>>,
{
    let mut inbound = request_head(&request)?;
    let body = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
        .map_err(|error| {
            if error.downcast_ref::<LengthLimitError>().is_some() {
                Rejection::oversized()
            } else {
                Rejection::invalid()
            }
        })?;
    if body.trailers().is_some() {
        return Err(Rejection::invalid());
    }
    inbound.body = body.to_bytes().to_vec();
    Ok(inbound)
}

#[cfg(test)]
#[path = "job_webhook_http_tests.rs"]
mod tests;
