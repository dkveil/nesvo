use super::*;
use futures_util::stream;
use http_body_util::StreamBody;
use hyper::body::Frame;

fn request(provider: Provider) -> Request<Full<Bytes>> {
    let names = match provider {
        Provider::Webhook => WEBHOOK_HEADERS,
        Provider::Github => GITHUB_HEADERS,
    };
    Request::builder()
        .method(Method::POST)
        .uri(format!("{ROUTE}{}", "a".repeat(32)))
        .header(header::HOST, "127.0.0.1:1234")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, "2")
        .header(names[0], "owned-delivery-1")
        .header(names[1], "push")
        .header(names[2], format!("sha256={}", "b".repeat(64)))
        .body(Full::new(Bytes::from_static(b"{}")))
        .unwrap()
}

#[tokio::test]
async fn raw_body_is_preserved_and_provider_is_bound_to_one_complete_header_family() {
    let bytes = Bytes::from_static(b"{\n \"payload\": \"\xc5\x82\xc3\xb3d\xc5\xba\" }\n");
    for provider in [Provider::Webhook, Provider::Github] {
        let (mut parts, _) = request(provider).into_parts();
        parts.headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&bytes.len().to_string()).unwrap(),
        );
        let decoded = decode(Request::from_parts(parts, Full::new(bytes.clone())))
            .await
            .unwrap();
        assert_eq!(decoded.body.as_slice(), bytes.as_ref());
        assert_eq!(decoded.trigger_id, "a".repeat(32));
        assert_eq!(decoded.delivery_id, "owned-delivery-1");
        assert_eq!(decoded.event, "push");
        assert_eq!(decoded.signature, format!("sha256={}", "b".repeat(64)));
        match provider {
            Provider::Webhook => assert!(matches!(decoded.provider, Provider::Webhook)),
            Provider::Github => assert!(matches!(decoded.provider, Provider::Github)),
        }
    }
}

#[test]
fn duplicate_partial_and_mixed_authentication_families_are_rejected() {
    for provider in [Provider::Webhook, Provider::Github] {
        let names = match provider {
            Provider::Webhook => WEBHOOK_HEADERS,
            Provider::Github => GITHUB_HEADERS,
        };
        for name in names {
            let mut duplicate = request(provider);
            let value = duplicate.headers()[name].clone();
            duplicate.headers_mut().append(name, value);
            assert!(request_head(&duplicate).is_err());

            let mut missing = request(provider);
            missing.headers_mut().remove(name);
            assert!(request_head(&missing).is_err());
        }
        let other = match provider {
            Provider::Webhook => GITHUB_HEADERS,
            Provider::Github => WEBHOOK_HEADERS,
        };
        for name in other {
            let mut mixed = request(provider);
            mixed
                .headers_mut()
                .insert(name, HeaderValue::from_static("untrusted"));
            assert!(request_head(&mixed).is_err());
        }
    }
    let mut none = request(Provider::Webhook);
    for name in WEBHOOK_HEADERS {
        none.headers_mut().remove(name);
    }
    assert!(request_head(&none).is_err());

    let mut namespaced = request(Provider::Webhook);
    namespaced.headers_mut().insert(
        "x-nesvo-event",
        HeaderValue::from_static("repository:changed"),
    );
    assert_eq!(
        request_head(&namespaced).unwrap().event,
        "repository:changed"
    );
}

#[test]
fn route_and_headers_cannot_select_other_commands_or_ambiguous_framing() {
    for uri in [
        "/",
        "/v1/job-triggers",
        "/v1/job-triggers/owner",
        "/v1/job-triggers/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "/v1/job-triggers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?key=owner",
        "/v1/job-triggers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        "http://127.0.0.1/v1/job-triggers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        let mut invalid = request(Provider::Webhook);
        *invalid.uri_mut() = uri.parse().unwrap();
        assert!(request_head(&invalid).is_err(), "{uri}");
    }
    for method in [Method::GET, Method::PUT, Method::OPTIONS, Method::CONNECT] {
        let mut invalid = request(Provider::Webhook);
        *invalid.method_mut() = method;
        assert!(request_head(&invalid).is_err());
    }
    for (name, value) in [
        ("authorization", "Bearer owner-key"),
        ("x-nesvo-scope", "owner"),
        ("upgrade", "websocket"),
        ("connection", "keep-alive, upgrade"),
        ("expect", "100-continue"),
        ("content-encoding", "gzip"),
        ("trailer", "x-nesvo-signature-256"),
        ("transfer-encoding", "chunked"),
        ("transfer-encoding", "chunked, gzip"),
    ] {
        let mut invalid = request(Provider::Webhook);
        invalid
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
        assert!(request_head(&invalid).is_err(), "{name}");
    }
    let mut duplicate_host = request(Provider::Webhook);
    duplicate_host
        .headers_mut()
        .append(header::HOST, HeaderValue::from_static("untrusted"));
    assert!(request_head(&duplicate_host).is_err());
    let mut conflicting = request(Provider::Webhook);
    conflicting.headers_mut().insert(
        header::TRANSFER_ENCODING,
        HeaderValue::from_static("chunked"),
    );
    conflicting
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_static("2"));
    assert!(request_head(&conflicting).is_err());
}

#[test]
fn bounded_headers_and_json_media_are_required_before_body_collection() {
    for content_type in [
        "text/plain",
        "application/json; charset=iso-8859-1",
        "application/json; charset=utf-8; unknown=1",
    ] {
        let mut invalid = request(Provider::Webhook);
        invalid.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type).unwrap(),
        );
        assert_eq!(
            request_head(&invalid).err().unwrap().status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }
    let mut valid = request(Provider::Webhook);
    valid.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=UTF-8"),
    );
    assert!(request_head(&valid).is_ok());

    let mut huge_header = request(Provider::Webhook);
    huge_header.headers_mut().insert(
        "untrusted",
        HeaderValue::from_str(&"x".repeat(MAX_HEADER_BYTES)).unwrap(),
    );
    assert!(request_head(&huge_header).is_err());
    let mut too_many = request(Provider::Webhook);
    for index in 0..MAX_HEADERS {
        too_many.headers_mut().insert(
            hyper::header::HeaderName::from_bytes(format!("extra-{index}").as_bytes()).unwrap(),
            HeaderValue::from_static("x"),
        );
    }
    assert!(request_head(&too_many).is_err());

    let mut huge_body = request(Provider::Webhook);
    huge_body.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&(MAX_BODY_BYTES + 1).to_string()).unwrap(),
    );
    assert_eq!(
        request_head(&huge_body).err().unwrap().status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn streamed_size_limit_and_trailers_cannot_bypass_the_boundary() {
    let (mut parts, _) = request(Provider::Webhook).into_parts();
    parts.headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&MAX_BODY_BYTES.to_string()).unwrap(),
    );
    let bytes = Bytes::from(vec![b'x'; MAX_BODY_BYTES]);
    let decoded = decode(Request::from_parts(parts, Full::new(bytes.clone())))
        .await
        .unwrap();
    assert_eq!(decoded.body.len(), MAX_BODY_BYTES);

    let (mut parts, _) = request(Provider::Webhook).into_parts();
    parts.headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&MAX_BODY_BYTES.to_string()).unwrap(),
    );
    let frames = vec![
        Ok::<_, Infallible>(Frame::data(bytes)),
        Ok(Frame::data(Bytes::from_static(b"x"))),
    ];
    let oversized = decode(Request::from_parts(
        parts,
        StreamBody::new(stream::iter(frames)),
    ))
    .await;
    assert_eq!(
        oversized.err().unwrap().status,
        StatusCode::PAYLOAD_TOO_LARGE
    );

    let (parts, _) = request(Provider::Webhook).into_parts();
    let mut trailers = HeaderMap::new();
    trailers.insert(
        "x-nesvo-signature-256",
        HeaderValue::from_static("untrusted"),
    );
    let frames = vec![
        Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"{}"))),
        Ok(Frame::trailers(trailers)),
    ];
    assert!(
        decode(Request::from_parts(
            parts,
            StreamBody::new(stream::iter(frames)),
        ))
        .await
        .is_err()
    );
}

#[tokio::test]
async fn responses_preserve_receipts_and_redact_internal_failures() {
    let view = json!({"delivery":{"id":"original","acceptedAt":123,"disposition":"ignored","occurrenceId":null}});
    for replayed in [false, true] {
        let response = accepted_response(Acceptance {
            view: view.clone(),
            replayed,
        });
        assert_eq!(
            response.status(),
            if replayed {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            }
        );
        assert_eq!(response.headers()[header::CONNECTION], "close");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(body["ok"], true);
        assert_eq!(body["data"]["type"], "workflow");
        assert_eq!(body["data"]["delivery"], view["delivery"]);
        assert!(view.get("type").is_none());
    }
    for (error, status, retryable) in [
        (
            anyhow!("untrusted secret, signature and payload must not escape"),
            StatusCode::SERVICE_UNAVAILABLE,
            true,
        ),
        (
            crate::api_error::Error::new(
                "trigger_unauthorized",
                "private credential or trigger detail",
            )
            .into(),
            StatusCode::UNAUTHORIZED,
            false,
        ),
        (
            crate::api_error::Error::new("trigger_rate_limited", "private admission detail").into(),
            StatusCode::TOO_MANY_REQUESTS,
            true,
        ),
    ] {
        let response = journal_rejection(&error).response();
        assert_eq!(response.status(), status);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["retryable"], retryable);
        let text = body.to_string();
        for private in ["untrusted", "secret", "signature", "payload", "private"] {
            assert!(!text.contains(private));
        }
    }
}

#[tokio::test]
async fn real_http_parser_limits_headers_and_shutdown_closes_an_owned_idle_socket() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn exchange(address: &str, request: &[u8]) -> Result<Vec<u8>> {
        timeout(CONNECTION_TIMEOUT + Duration::from_secs(1), async {
            let mut socket = TcpStream::connect(address).await?;
            let written = socket.write_all(request).await;
            let mut response = Vec::new();
            let read = socket.read_to_end(&mut response).await;
            if response.is_empty() {
                written?;
                read?;
            } else if let Err(error) = read
                && !matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                )
            {
                return Err(error.into());
            }
            Ok::<_, anyhow::Error>(response)
        })
        .await?
    }

    let log = Service::open(":memory:".into()).await?;
    let listener = Listener::bind(0, log.clone()).await?;
    let url = listener.address();
    let address = url.strip_prefix("http://").context("Listener base URL")?;
    let result = async {
        anyhow::ensure!(address.starts_with("127.0.0.1:"));
        let owner = || crate::orchestration::Actor {
            issuer: "owner".into(),
            scope: crate::orchestration::Scope::Owner,
        };
        let job = log.workflow(owner(), serde_json::from_value(json!({"action":"jobs","request":{"action":"create","key":"wire-job","spec":{"title":"HTTP boundary","instruction":"Metadata fixture only","profile":{"program":"claude","workspace":"shared"},"schedule":{"kind":"external"}}}}))?).await?;
        let secret = "a".repeat(64);
        let trigger = log.workflow(owner(), serde_json::from_value(json!({"action":"jobs","request":{"action":"triggers","request":{"action":"create","key":"wire-trigger","spec":{"title":"HTTP signature fixture","jobId":job["job"]["id"],"jobRevision":job["job"]["revision"],"adapter":{"kind":"webhook","event":"push"}},"secret":secret}}}))?).await?;
        log.workflow(owner(), serde_json::from_value(json!({"action":"jobs","request":{"action":"triggers","request":{"action":"setEnabled","key":"wire-enable","id":trigger["trigger"]["id"],"expectedRevision":trigger["trigger"]["revision"],"enabled":true}}}))?).await?;
        let trigger_id = trigger["trigger"]["id"].as_str().context("Trigger identity")?;
        let body = json!({"schemaVersion":1,"id":"one","event":"push","sentAt":crate::status::now_millis(),"payload":null}).to_string();
        let signature = hex::encode(ring::hmac::sign(&ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes()), body.as_bytes()).as_ref());
        let before = log.read(0, 32, None).await?.head_cursor;
        let base = format!(
            "POST {ROUTE}{} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nX-Nesvo-Delivery: one\r\nX-Nesvo-Event: push\r\nX-Nesvo-Signature-256: sha256={}\r\n",
            trigger_id,
            signature
        );
        let duplicate = format!("{base}X-Nesvo-Delivery: two\r\nContent-Length: 2\r\n\r\n{{}}");
        let response = exchange(address, duplicate.as_bytes()).await?;
        anyhow::ensure!(response.starts_with(b"HTTP/1.1 400"), "Duplicate security header was accepted");

        let mut many = base.clone();
        for index in 0..MAX_HEADERS {
            many.push_str(&format!("Extra-{index}: x\r\n"));
        }
        many.push_str("Content-Length: 0\r\n\r\n");
        let response = exchange(address, many.as_bytes()).await?;
        anyhow::ensure!(response.starts_with(b"HTTP/1.1 431"), "HTTP header count limit was bypassed");

        let large = format!("{base}Extra: {}\r\nContent-Length: 0\r\n\r\n", "x".repeat(MAX_HEADER_BYTES));
        let response = exchange(address, large.as_bytes()).await?;
        anyhow::ensure!(response.starts_with(b"HTTP/1.1 431"), "HTTP header byte limit was bypassed");

        let chunks = format!("{:x}\r\n{body}\r\n0\r\n\r\n", body.len());
        for framing in [
            format!("Content-Length: {}\r\nTransfer-Encoding: chunked\r\n", body.len()),
            format!("Transfer-Encoding: chunked\r\nContent-Length: {}\r\n", body.len()),
        ] {
            let ambiguous = format!("{base}{framing}\r\n{chunks}");
            let response = exchange(address, ambiguous.as_bytes()).await?;
            anyhow::ensure!(response.starts_with(b"HTTP/1.1 400"), "Transfer coding reached authenticated admission");
        }
        let conflicting = format!("{base}Content-Length: {}\r\nContent-Length: {}\r\n\r\n{body}", body.len(), body.len() + 1);
        let response = exchange(address, conflicting.as_bytes()).await?;
        anyhow::ensure!(response.starts_with(b"HTTP/1.1 400"), "Conflicting lengths reached authenticated admission");
        anyhow::ensure!(log.read(0, 32, None).await?.head_cursor == before, "Rejected framing created journal acceptance");

        let equal = format!("{base}Content-Length: {}\r\nContent-Length: {}\r\n\r\n{body}", body.len(), body.len());
        let response = exchange(address, equal.as_bytes()).await?;
        anyhow::ensure!(response.starts_with(b"HTTP/1.1 202"), "Valid fixed-length signature was not accepted");
        let admitted = log.read(before, 32, None).await?;
        anyhow::ensure!(admitted.events.iter().filter(|event| event.kind == "job.trigger_delivery").count() == 1, "Expected one final valid delivery acceptance");
        TcpStream::connect(address).await.map_err(anyhow::Error::from)
    }
    .await;
    let stopped = listener.shutdown().await;
    let closed = match result {
        Ok(mut socket) => timeout(Duration::from_secs(1), async {
            let mut byte = [0; 1];
            match socket.read(&mut byte).await {
                Ok(0) => Ok(()),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) =>
                {
                    Ok(())
                }
                _ => Err(anyhow!("Owned idle HTTP socket survived listener shutdown")),
            }
        })
        .await
        .context("Owned HTTP shutdown did not close its socket")
        .and_then(|result| result),
        Err(error) => Err(error),
    };
    log.shutdown().await;
    stopped?;
    closed
}

#[tokio::test]
async fn listener_exit_observer_retains_early_completion_and_missing_producer_failure() {
    for failed in [false, true] {
        let (sender, receiver) = watch::channel(None);
        sender.send_replace(Some(failed));
        assert_eq!(wait_for_exit(receiver).await, failed);
    }
    let (sender, receiver) = watch::channel(None);
    drop(sender);
    assert!(wait_for_exit(receiver).await);
}
