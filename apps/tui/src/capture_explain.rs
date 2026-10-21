//! Pure, allowlisted presentation of launch-local capture receipts.
use serde_json::Value;

#[derive(Clone, Copy)]
struct Attempt {
    sequence: u64,
    description: &'static str,
    completed: bool,
    rejected: bool,
}

fn attempt(value: &Value) -> Option<Attempt> {
    let sequence = value.get("attemptSequence")?.as_u64().filter(|n| *n > 0)?;
    value.get("entryGeneration")?.as_u64().filter(|n| *n > 0)?;
    let bound = value.get("boundAtEntry")?.as_bool()?;
    let state = value.get("state")?.as_str()?;
    let outcome = value.get("outcome")?;
    let reason = value.get("parseReason")?;
    if state == "unconfirmed" && outcome.is_null() && reason.is_null() {
        return Some(Attempt {
            sequence,
            description: "unconfirmed",
            completed: false,
            rejected: false,
        });
    }
    if state != "completed" {
        return None;
    }
    let outcome = outcome.as_str()?;
    let description = if outcome == "recorded" && bound {
        match reason.as_str()? {
            "observed" => "recorded; windows observed (receipt only)",
            "partialSnapshot" => "recorded; partial windows (receipt only)",
            "windowsUnavailable" => "recorded; windows unavailable (receipt only)",
            "invalidWindow" => "recorded; invalid windows (receipt only)",
            "invalidInput" => "recorded; invalid input (receipt only)",
            "inputOversized" => "recorded; input oversized (receipt only)",
            "inputReadFailed" => "recorded; input read failed (receipt only)",
            _ => return None,
        }
    } else if reason.is_null() {
        match outcome {
            "rootUnbound" if !bound => "root unbound",
            "payloadScopeRejected" if bound => "payload scope rejected",
            "scopeChanged" if bound => "scope changed",
            "superseded" if bound => "superseded",
            "storageUnavailable" => "storage unavailable",
            _ => return None,
        }
    } else {
        return None;
    };
    Some(Attempt {
        sequence,
        description,
        completed: true,
        rejected: outcome != "recorded",
    })
}

fn reader_label(value: &Value) -> &'static str {
    match value.as_str() {
        Some("notPolled") => "not polled",
        Some("readable") => "readable",
        Some("missing") => "missing",
        Some("unreadable") => "unreadable",
        Some("invalidStoredData") => "invalid stored data",
        Some("scopeChanged") => "scope changed",
        _ => "not reported",
    }
}

/// These lines describe callback delivery, never backend permission or freshness.
pub fn lines(capture: &Value) -> Vec<String> {
    if capture.get("configured").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    let delivery = &capture["delivery"];
    let started = attempt(&delivery["latestStarted"]);
    let completed = attempt(&delivery["latestCompleted"]).filter(|item| item.completed);
    let current = match (started, completed) {
        (Some(started), Some(completed)) if completed.sequence > started.sequence => {
            Some(completed)
        }
        (Some(started), _) => Some(started),
        (None, completed) => completed,
    };
    let mut heading = format!(
        "Claude capture: reader {}",
        reader_label(&capture["reader"]["outcome"])
    );
    match current {
        Some(item) => heading.push_str(&format!(
            " · attempt #{}: {}",
            item.sequence, item.description
        )),
        None => heading.push_str(" · no confirmed attempt"),
    }
    let mut result = vec![heading];
    let previous =
        completed.filter(|item| current.is_some_and(|current| current.sequence > item.sequence));
    if let Some(item) = previous {
        result.push(format!(
            "Claude capture historical completion: attempt #{}: {}",
            item.sequence, item.description
        ));
    }
    if let Some(item) = attempt(&delivery["latestRejected"]).filter(|item| {
        item.completed
            && item.rejected
            && current.is_none_or(|current| current.sequence > item.sequence)
            && previous.is_none_or(|previous| previous.sequence != item.sequence)
    }) {
        result.push(format!(
            "Claude capture historical rejection: attempt #{}: {}",
            item.sequence, item.description
        ));
    }
    let failure = &delivery["lastStorageFailure"];
    if failure["outcome"] == "storageUnavailable" {
        let stage = match failure["stage"].as_str() {
            Some("begin") => "begin",
            Some("append") => "append",
            _ => "stage not reported",
        };
        result.push(format!(
            "Claude capture historical storage failure: {stage}"
        ));
    }
    let failure_reader = &capture["reader"]["storageFailureOutcome"];
    if matches!(
        failure_reader.as_str(),
        Some("unreadable" | "invalidStoredData" | "scopeChanged")
    ) {
        result.push(format!(
            "Claude capture: storage-failure reader {}",
            reader_label(failure_reader)
        ));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn completed(sequence: u64, outcome: &str, reason: Value) -> Value {
        json!({
            "attemptSequence": sequence,
            "entryGeneration": 1,
            "boundAtEntry": outcome != "rootUnbound",
            "state": "completed",
            "outcome": outcome,
            "parseReason": reason,
        })
    }

    fn capture(attempt: Value) -> Value {
        json!({
            "configured": true,
            "reader": {"outcome": "readable", "storageFailureOutcome": "missing"},
            "delivery": {"latestStarted": attempt, "latestCompleted": attempt},
        })
    }

    #[test]
    fn unbound_unavailable_and_recorded_without_windows_are_distinct() {
        let unbound = lines(&capture(completed(1, "rootUnbound", Value::Null))).join("\n");
        assert!(unbound.contains("Claude capture: reader readable"));
        assert!(unbound.contains("attempt #1: root unbound"));
        assert!(!unbound.contains("windows observed"));

        let unavailable = lines(&json!({
            "configured": true,
            "reader": {"outcome": "unreadable"},
            "delivery": {"lastStorageFailure": {
                "outcome": "storageUnavailable", "stage": "begin",
            }},
        }))
        .join("\n");
        assert!(unavailable.contains("Claude capture: reader unreadable"));
        assert!(unavailable.contains("no confirmed attempt"));
        assert!(unavailable.contains("historical storage failure: begin"));
        assert!(!unavailable.contains("root unbound"));

        let absent = lines(&capture(completed(
            2,
            "recorded",
            json!("windowsUnavailable"),
        )))
        .join("\n");
        assert!(absent.contains("recorded; windows unavailable (receipt only)"));
        assert!(!absent.contains("windows observed"));
    }

    #[test]
    fn unfinished_newer_attempt_keeps_previous_completion_separate() {
        let mut value = capture(completed(2, "recorded", json!("observed")));
        value["delivery"]["latestStarted"] = json!({
            "attemptSequence": 3, "entryGeneration": 2, "boundAtEntry": true,
            "state": "unconfirmed", "outcome": null, "parseReason": null,
        });
        let output = lines(&value);
        assert_eq!(output.len(), 2);
        assert_eq!(
            output[0],
            "Claude capture: reader readable · attempt #3: unconfirmed"
        );
        assert!(output[1].contains("historical completion: attempt #2"));
        assert!(output[1].contains("windows observed (receipt only)"));
    }

    #[test]
    fn recovered_success_labels_retained_failures_as_historical() {
        let mut value = capture(completed(3, "recorded", json!("observed")));
        value["delivery"]["latestRejected"] = completed(1, "payloadScopeRejected", Value::Null);
        value["delivery"]["lastStorageFailure"] = json!({
            "outcome": "storageUnavailable", "stage": "append",
        });
        let output = lines(&value);
        assert!(output[0].contains("attempt #3: recorded; windows observed (receipt only)"));
        assert!(!output[0].contains("rejected"));
        assert!(output[1].contains("historical rejection: attempt #1: payload scope rejected"));
        assert!(output[2].contains("historical storage failure: append"));
    }

    #[test]
    fn current_rejection_and_sidecar_reader_health_remain_visible() {
        let mut value = capture(completed(4, "payloadScopeRejected", Value::Null));
        value["delivery"]["latestRejected"] = value["delivery"]["latestCompleted"].clone();
        value["reader"]["storageFailureOutcome"] = json!("invalidStoredData");
        let output = lines(&value);
        assert_eq!(output.len(), 2);
        assert!(output[0].contains("attempt #4: payload scope rejected"));
        assert_eq!(
            output[1],
            "Claude capture: storage-failure reader invalid stored data"
        );
    }

    #[test]
    fn recorded_reasons_are_allowlisted_receipts() {
        for (reason, label) in [
            ("observed", "windows observed"),
            ("partialSnapshot", "partial windows"),
            ("windowsUnavailable", "windows unavailable"),
            ("invalidWindow", "invalid windows"),
            ("invalidInput", "invalid input"),
            ("inputOversized", "input oversized"),
            ("inputReadFailed", "input read failed"),
        ] {
            let output = lines(&capture(completed(1, "recorded", json!(reason)))).join("\n");
            assert!(output.contains(label));
            assert!(output.contains("receipt only"));
        }
    }

    #[test]
    fn malformed_and_legacy_values_never_echo_private_or_control_text() {
        let secret = "PRIVATE_PATH_ACCOUNT_PROMPT\u{1b}[31m";
        let value = json!({
            "configured": true, "displayProfile": secret, "account": secret,
            "reader": {"outcome": secret, "storageFailureOutcome": secret},
            "delivery": {
                "latestStarted": {"attemptSequence": secret, "outcome": secret},
                "latestCompleted": completed(2, "recorded", json!(secret)),
                "latestRejected": completed(1, secret, Value::Null),
                "lastStorageFailure": {"outcome": "storageUnavailable", "stage": secret},
            },
        });
        let output = lines(&value).join("\n");
        assert!(output.contains("reader not reported · no confirmed attempt"));
        assert!(output.contains("historical storage failure: stage not reported"));
        assert!(!output.contains("PRIVATE"));
        assert!(!output.contains('\u{1b}'));
        assert_eq!(
            lines(&json!({"configured": true})),
            ["Claude capture: reader not reported · no confirmed attempt"]
        );
        for absent in [
            Value::Null,
            json!({}),
            json!({"configured": false}),
            json!({"configured": secret}),
        ] {
            assert!(lines(&absent).is_empty());
        }
    }
}
