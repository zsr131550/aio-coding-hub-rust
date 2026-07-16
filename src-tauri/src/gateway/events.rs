use crate::{circuit_breaker, usage};
use aio_core::EventSink;

pub(crate) use aio_contract::{
    AppEvent, ClaudeModelMapping, FailoverAttempt, GatewayAttemptEvent, GatewayCircuitEvent,
    GatewayLogEvent, GatewayRequestEvent, GatewayRequestSignalEvent, GatewayRequestStartEvent,
    GATEWAY_ATTEMPT_EVENT_NAME, GATEWAY_CIRCUIT_EVENT_NAME, GATEWAY_LOG_EVENT_NAME,
    GATEWAY_REQUEST_EVENT_NAME, GATEWAY_REQUEST_SIGNAL_EVENT_NAME,
    GATEWAY_REQUEST_START_EVENT_NAME, GATEWAY_STATUS_EVENT_NAME,
};
const REQUEST_EVENT_MAX_ATTEMPTS: usize = 100;
const EVENT_METHOD_MAX_CHARS: usize = 32;
const EVENT_STATE_MAX_CHARS: usize = 64;
const EVENT_SHORT_TEXT_MAX_CHARS: usize = 512;
const EVENT_PATH_MAX_CHARS: usize = 2048;
const EVENT_QUERY_MAX_CHARS: usize = 4096;
const EVENT_URL_MAX_CHARS: usize = 2048;

pub(in crate::gateway) mod decision_chain {
    pub(in crate::gateway) const SELECTION_METHOD_SESSION_REUSE: &str = "session_reuse";
    pub(in crate::gateway) const SELECTION_METHOD_ORDERED: &str = "ordered";
    pub(in crate::gateway) const SELECTION_METHOD_FILTERED: &str = "filtered";

    pub(in crate::gateway) const REASON_REQUEST_SUCCESS: &str = "request_success";
    pub(in crate::gateway) const REASON_RETRY_SUCCESS: &str = "retry_success";
    pub(in crate::gateway) const REASON_RETRY_FAILED: &str = "retry_failed";
    pub(in crate::gateway) const REASON_SYSTEM_ERROR: &str = "system_error";
    pub(in crate::gateway) const REASON_RESOURCE_NOT_FOUND: &str = "resource_not_found";
    pub(in crate::gateway) const REASON_CLIENT_ERROR_NON_RETRYABLE: &str =
        "client_error_non_retryable";
    pub(in crate::gateway) const REASON_ABORTED: &str = "aborted";
    pub(in crate::gateway) const REASON_CIRCUIT_OPEN: &str = "circuit_open";
    pub(in crate::gateway) const REASON_CIRCUIT_COOLDOWN: &str = "circuit_cooldown";
    pub(in crate::gateway) const REASON_RATE_LIMITED: &str = "rate_limited";

    /// Determine how the provider was selected for this attempt.
    /// Only meaningful for the first attempt (provider_index=1, retry_index=1).
    pub(in crate::gateway) fn selection_method(
        provider_index: u32,
        retry_index: u32,
        session_reuse: Option<bool>,
    ) -> Option<&'static str> {
        if provider_index == 1 && retry_index == 1 {
            Some(if session_reuse == Some(true) {
                SELECTION_METHOD_SESSION_REUSE
            } else {
                SELECTION_METHOD_ORDERED
            })
        } else {
            None
        }
    }

    /// Determine reason code for a successful attempt.
    pub(in crate::gateway) fn success_reason_code(
        provider_index: u32,
        retry_index: u32,
    ) -> &'static str {
        if provider_index == 1 && retry_index == 1 {
            REASON_REQUEST_SUCCESS
        } else {
            REASON_RETRY_SUCCESS
        }
    }
}

pub(crate) fn emit_gateway_log(
    sink: &dyn EventSink,
    level: &'static str,
    error_code: &'static str,
    message: String,
) {
    let payload = GatewayLogEvent {
        level,
        error_code,
        message,
        requested_port: 0,
        bound_port: 0,
        base_url: String::new(),
    };
    sink.publish(AppEvent::GatewayLog(bound_gateway_log_event(payload)));
}

fn emit_request_signal(
    sink: &dyn EventSink,
    trace_id: String,
    cli_key: String,
    session_id: Option<String>,
    requested_model: Option<String>,
    phase: &'static str,
    ts: i64,
) {
    let payload = GatewayRequestSignalEvent {
        trace_id,
        cli_key,
        session_id,
        requested_model,
        phase,
        ts,
    };
    sink.publish(AppEvent::GatewayRequestSignal(bound_request_signal_event(
        payload,
    )));
}

fn truncate_chars(mut value: String, max_chars: usize) -> String {
    if let Some((index, _)) = value.char_indices().nth(max_chars) {
        value.truncate(index);
    }
    value
}

fn truncate_optional_chars(value: &mut Option<String>, max_chars: usize) {
    if let Some(raw) = value.take() {
        *value = Some(truncate_chars(raw, max_chars));
    }
}

fn bound_claude_model_mapping(mut mapping: ClaudeModelMapping) -> ClaudeModelMapping {
    mapping.requested_model = truncate_chars(mapping.requested_model, EVENT_SHORT_TEXT_MAX_CHARS);
    mapping.effective_model = truncate_chars(mapping.effective_model, EVENT_SHORT_TEXT_MAX_CHARS);
    mapping.mapping_kind = truncate_chars(mapping.mapping_kind, EVENT_SHORT_TEXT_MAX_CHARS);
    mapping.provider_name = truncate_chars(mapping.provider_name, EVENT_SHORT_TEXT_MAX_CHARS);
    mapping
}

fn bound_optional_claude_model_mapping(
    mapping: Option<ClaudeModelMapping>,
) -> Option<ClaudeModelMapping> {
    mapping.map(bound_claude_model_mapping)
}

fn bound_failover_attempt(mut attempt: FailoverAttempt) -> FailoverAttempt {
    attempt.provider_name = truncate_chars(attempt.provider_name, EVENT_SHORT_TEXT_MAX_CHARS);
    attempt.base_url = truncate_chars(attempt.base_url, EVENT_URL_MAX_CHARS);
    attempt.outcome = truncate_chars(attempt.outcome, EVENT_STATE_MAX_CHARS);
    truncate_optional_chars(&mut attempt.reason, EVENT_QUERY_MAX_CHARS);
    attempt
}

fn trim_request_event_attempts(mut attempts: Vec<FailoverAttempt>) -> Vec<FailoverAttempt> {
    if attempts.len() <= REQUEST_EVENT_MAX_ATTEMPTS {
        return attempts.into_iter().map(bound_failover_attempt).collect();
    }

    attempts
        .split_off(attempts.len() - REQUEST_EVENT_MAX_ATTEMPTS)
        .into_iter()
        .map(bound_failover_attempt)
        .collect()
}

fn bound_request_event(mut payload: GatewayRequestEvent) -> GatewayRequestEvent {
    payload.method = truncate_chars(payload.method, EVENT_METHOD_MAX_CHARS);
    payload.path = truncate_chars(payload.path, EVENT_PATH_MAX_CHARS);
    truncate_optional_chars(&mut payload.query, EVENT_QUERY_MAX_CHARS);
    truncate_optional_chars(&mut payload.requested_model, EVENT_SHORT_TEXT_MAX_CHARS);
    payload.attempts = trim_request_event_attempts(payload.attempts);
    payload.claude_model_mapping =
        bound_optional_claude_model_mapping(payload.claude_model_mapping);
    payload
}

fn bound_request_start_event(mut payload: GatewayRequestStartEvent) -> GatewayRequestStartEvent {
    payload.method = truncate_chars(payload.method, EVENT_METHOD_MAX_CHARS);
    payload.path = truncate_chars(payload.path, EVENT_PATH_MAX_CHARS);
    truncate_optional_chars(&mut payload.query, EVENT_QUERY_MAX_CHARS);
    truncate_optional_chars(&mut payload.requested_model, EVENT_SHORT_TEXT_MAX_CHARS);
    payload
}

fn bound_request_signal_event(mut payload: GatewayRequestSignalEvent) -> GatewayRequestSignalEvent {
    truncate_optional_chars(&mut payload.requested_model, EVENT_SHORT_TEXT_MAX_CHARS);
    payload
}

fn request_event_effective_input_tokens(
    cli_key: &str,
    attempts: &[FailoverAttempt],
    usage: &usage::UsageMetrics,
) -> Option<i64> {
    // Skipped and synthetic attempts carry no provider snapshot. The last
    // concrete attempt matches final-provider resolution in the persisted log.
    let final_provider_bridged = attempts
        .iter()
        .rev()
        .find_map(|attempt| attempt.provider_bridged)
        .unwrap_or(false);
    crate::usage_stats::effective_input_tokens_display(
        cli_key,
        None,
        final_provider_bridged,
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
    )
}

pub(super) fn bound_attempt_event(mut payload: GatewayAttemptEvent) -> GatewayAttemptEvent {
    payload.method = truncate_chars(payload.method, EVENT_METHOD_MAX_CHARS);
    payload.path = truncate_chars(payload.path, EVENT_PATH_MAX_CHARS);
    truncate_optional_chars(&mut payload.query, EVENT_QUERY_MAX_CHARS);
    truncate_optional_chars(&mut payload.requested_model, EVENT_SHORT_TEXT_MAX_CHARS);
    payload.provider_name = truncate_chars(payload.provider_name, EVENT_SHORT_TEXT_MAX_CHARS);
    payload.base_url = truncate_chars(payload.base_url, EVENT_URL_MAX_CHARS);
    payload.outcome = truncate_chars(payload.outcome, EVENT_STATE_MAX_CHARS);
    payload.claude_model_mapping =
        bound_optional_claude_model_mapping(payload.claude_model_mapping);
    payload
}

fn bound_circuit_event(mut payload: GatewayCircuitEvent) -> GatewayCircuitEvent {
    payload.provider_name = truncate_chars(payload.provider_name, EVENT_SHORT_TEXT_MAX_CHARS);
    payload.base_url = truncate_chars(payload.base_url, EVENT_URL_MAX_CHARS);
    truncate_optional_chars(&mut payload.trigger_error_code, EVENT_SHORT_TEXT_MAX_CHARS);
    payload
}

fn bound_gateway_log_event(mut payload: GatewayLogEvent) -> GatewayLogEvent {
    payload.message = truncate_chars(payload.message, EVENT_QUERY_MAX_CHARS);
    payload.base_url = truncate_chars(payload.base_url, EVENT_URL_MAX_CHARS);
    payload
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_request_event(
    sink: &dyn EventSink,
    trace_id: String,
    cli_key: String,
    session_id: Option<String>,
    method: String,
    path: String,
    query: Option<String>,
    requested_model: Option<String>,
    status: Option<u16>,
    error_category: Option<&'static str>,
    error_code: Option<&'static str>,
    duration_ms: u128,
    ttfb_ms: Option<u128>,
    attempts: Vec<FailoverAttempt>,
    claude_model_mapping: Option<ClaudeModelMapping>,
    usage: Option<usage::UsageMetrics>,
) {
    emit_request_signal(
        sink,
        trace_id.clone(),
        cli_key.clone(),
        session_id.clone(),
        requested_model.clone(),
        "complete",
        crate::gateway::util::now_unix_seconds() as i64,
    );

    let usage = usage.unwrap_or_default();
    let effective_input_tokens = request_event_effective_input_tokens(&cli_key, &attempts, &usage);
    let payload = GatewayRequestEvent {
        trace_id,
        cli_key,
        session_id,
        method,
        path,
        query,
        requested_model,
        status,
        error_category,
        error_code,
        duration_ms,
        ttfb_ms,
        attempts,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_creation_5m_input_tokens: usage.cache_creation_5m_input_tokens,
        cache_creation_1h_input_tokens: usage.cache_creation_1h_input_tokens,
        effective_input_tokens,
        claude_model_mapping,
    };

    sink.publish(AppEvent::GatewayRequestCompleted(bound_request_event(
        payload,
    )));
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_request_start_event(
    sink: &dyn EventSink,
    trace_id: String,
    cli_key: String,
    session_id: Option<String>,
    method: String,
    path: String,
    query: Option<String>,
    requested_model: Option<String>,
    ts: i64,
) {
    emit_request_signal(
        sink,
        trace_id.clone(),
        cli_key.clone(),
        session_id.clone(),
        requested_model.clone(),
        "start",
        ts,
    );

    let payload = GatewayRequestStartEvent {
        trace_id,
        cli_key,
        session_id,
        method,
        path,
        query,
        requested_model,
        ts,
    };
    sink.publish(AppEvent::GatewayRequestStarted(bound_request_start_event(
        payload,
    )));
}

pub(super) fn emit_attempt_event(sink: &dyn EventSink, payload: GatewayAttemptEvent) {
    sink.publish(AppEvent::GatewayAttempted(bound_attempt_event(payload)));
}

pub(super) fn emit_circuit_event(sink: &dyn EventSink, payload: GatewayCircuitEvent) {
    sink.publish(AppEvent::GatewayCircuitChanged(bound_circuit_event(
        payload,
    )));
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_circuit_transition(
    sink: &dyn EventSink,
    trace_id: &str,
    cli_key: &str,
    provider_id: i64,
    provider_name: &str,
    base_url: &str,
    transition: &circuit_breaker::CircuitTransition,
    now_unix: i64,
    trigger_error_code: Option<&'static str>,
    first_byte_timeout_secs: Option<u32>,
) {
    let payload = GatewayCircuitEvent {
        trace_id: trace_id.to_string(),
        cli_key: cli_key.to_string(),
        provider_id,
        provider_name: provider_name.to_string(),
        base_url: base_url.to_string(),
        prev_state: transition.prev_state.as_str(),
        next_state: transition.next_state.as_str(),
        failure_count: transition.snapshot.failure_count,
        failure_threshold: transition.snapshot.failure_threshold,
        open_until: transition.snapshot.open_until,
        cooldown_until: transition.snapshot.cooldown_until,
        reason: transition.reason,
        ts: now_unix,
        trigger_error_code: trigger_error_code.map(str::to_string),
        first_byte_timeout_secs,
    };

    emit_circuit_event(sink, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use aio_core::RecordingEventSink;
    use serde::Serialize;
    use serde_json::json;

    fn sample_attempt_event() -> GatewayAttemptEvent {
        GatewayAttemptEvent {
            trace_id: "trace-producer".to_string(),
            cli_key: "codex".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            query: None,
            requested_model: Some("gpt-5.4".to_string()),
            attempt_index: 1,
            provider_id: 7,
            session_reuse: Some(false),
            provider_name: "Provider A".to_string(),
            base_url: "https://provider.example".to_string(),
            outcome: "success".to_string(),
            status: Some(200),
            attempt_started_ms: 10,
            attempt_duration_ms: 5,
            circuit_state_before: Some("CLOSED"),
            circuit_state_after: Some("CLOSED"),
            circuit_failure_count: Some(0),
            circuit_failure_threshold: Some(5),
            claude_model_mapping: None,
        }
    }

    fn sample_circuit_event() -> GatewayCircuitEvent {
        GatewayCircuitEvent {
            trace_id: "trace-producer".to_string(),
            cli_key: "codex".to_string(),
            provider_id: 7,
            provider_name: "Provider A".to_string(),
            base_url: "https://provider.example".to_string(),
            prev_state: "CLOSED",
            next_state: "OPEN",
            failure_count: 5,
            failure_threshold: 5,
            open_until: Some(100),
            cooldown_until: None,
            reason: "FAILURE_THRESHOLD_REACHED",
            ts: 10,
            trigger_error_code: Some("GW_UPSTREAM_TIMEOUT".to_string()),
            first_byte_timeout_secs: Some(30),
        }
    }

    #[test]
    fn gateway_event_producers_publish_typed_events_in_order() {
        let sink = RecordingEventSink::default();

        emit_gateway_log(&sink, "warn", "GW_TEST", "log".to_string());
        emit_request_start_event(
            &sink,
            "trace-producer".to_string(),
            "codex".to_string(),
            None,
            "POST".to_string(),
            "/v1/responses".to_string(),
            None,
            Some("gpt-5.4".to_string()),
            10,
        );
        emit_attempt_event(&sink, sample_attempt_event());
        emit_request_event(
            &sink,
            "trace-producer".to_string(),
            "codex".to_string(),
            None,
            "POST".to_string(),
            "/v1/responses".to_string(),
            None,
            Some("gpt-5.4".to_string()),
            Some(200),
            None,
            None,
            15,
            Some(5),
            Vec::new(),
            None,
            None,
        );
        emit_circuit_event(&sink, sample_circuit_event());

        let events = sink.events();
        assert_eq!(events.len(), 7);
        assert!(matches!(events[0], AppEvent::GatewayLog(_)));
        assert!(matches!(events[1], AppEvent::GatewayRequestSignal(_)));
        assert!(matches!(events[2], AppEvent::GatewayRequestStarted(_)));
        assert!(matches!(events[3], AppEvent::GatewayAttempted(_)));
        assert!(matches!(events[4], AppEvent::GatewayRequestSignal(_)));
        assert!(matches!(events[5], AppEvent::GatewayRequestCompleted(_)));
        assert!(matches!(events[6], AppEvent::GatewayCircuitChanged(_)));
    }

    #[test]
    fn status_event_payload_matches_shared_fixture() {
        let status = crate::gateway::GatewayStatus {
            running: true,
            port: Some(37123),
            base_url: Some("http://127.0.0.1:37123".to_string()),
            listen_addr: Some("127.0.0.1:37123".to_string()),
        };

        assert_matches_fixture(
            &status,
            include_str!("../../../src/services/gateway/__fixtures__/gatewayEvents/status.json"),
        );
    }

    fn sample_mapping() -> ClaudeModelMapping {
        ClaudeModelMapping {
            requested_model: "claude-sonnet".to_string(),
            effective_model: "gpt-5.4".to_string(),
            mapping_kind: "sonnet".to_string(),
            provider_id: 7,
            provider_name: "Provider A".to_string(),
            applied: true,
        }
    }

    fn sample_attempt(provider_id: i64) -> FailoverAttempt {
        FailoverAttempt {
            provider_id,
            provider_name: format!("Provider {provider_id}"),
            base_url: format!("https://provider-{provider_id}.example"),
            outcome: "failed".to_string(),
            status: Some(500),
            provider_index: Some(provider_id as u32),
            retry_index: Some(1),
            session_reuse: Some(false),
            error_category: Some("upstream"),
            error_code: Some("upstream_error"),
            decision: Some("switch_provider"),
            reason: Some("test attempt".to_string()),
            selection_method: Some(decision_chain::SELECTION_METHOD_ORDERED),
            reason_code: Some(decision_chain::REASON_RETRY_FAILED),
            attempt_started_ms: Some(provider_id as u128),
            attempt_duration_ms: Some(5),
            circuit_state_before: None,
            circuit_state_after: None,
            circuit_failure_count: None,
            circuit_failure_threshold: None,
            circuit_recover_at_unix: None,
            circuit_trigger_error_code: None,
            provider_bridged: Some(false),
            timeout_secs: None,
        }
    }

    fn ascii_len(value: &str) -> usize {
        value.chars().count()
    }

    #[test]
    fn request_event_effective_input_uses_protocol_and_provider_snapshot() {
        let usage = usage::UsageMetrics {
            input_tokens: Some(1_000),
            output_tokens: Some(50),
            total_tokens: Some(1_050),
            cache_read_input_tokens: Some(100),
            cache_creation_input_tokens: Some(200),
            ..Default::default()
        };
        let plain_attempt = sample_attempt(1);
        let mut bridged_attempt = sample_attempt(2);
        bridged_attempt.provider_bridged = Some(true);
        let mut synthetic_attempt = sample_attempt(3);
        synthetic_attempt.provider_bridged = None;

        assert_eq!(
            request_event_effective_input_tokens("codex", &[], &usage),
            Some(700)
        );
        assert_eq!(
            request_event_effective_input_tokens(
                "claude",
                &[bridged_attempt, synthetic_attempt],
                &usage,
            ),
            Some(700)
        );
        assert_eq!(
            request_event_effective_input_tokens("gemini", &[], &usage),
            Some(900)
        );
        assert_eq!(
            request_event_effective_input_tokens("claude", &[plain_attempt], &usage),
            Some(1_000)
        );

        let mut unknown = usage;
        unknown.input_tokens = None;
        assert_eq!(
            request_event_effective_input_tokens("codex", &[], &unknown),
            None
        );
    }

    // --- Shared payload fixtures ---
    // These JSON files are the wire contract with the frontend runtime guards
    // (src/services/gateway/__tests__/gatewayEvents.contract.test.ts validates
    // the same files). A failing test here means the payload shape changed:
    // update the fixture AND the frontend types/normalizers together.

    fn fixture_mapping() -> ClaudeModelMapping {
        ClaudeModelMapping {
            requested_model: "claude-sonnet-4-5".to_string(),
            effective_model: "gpt-5.4".to_string(),
            mapping_kind: "sonnet".to_string(),
            provider_id: 7,
            provider_name: "Provider A".to_string(),
            applied: true,
        }
    }

    fn assert_matches_fixture<T: Serialize>(event: &T, fixture: &str) {
        let expected: serde_json::Value =
            serde_json::from_str(fixture).expect("parse shared event fixture");
        let actual = serde_json::to_value(event).expect("serialize event payload");
        assert_eq!(
            actual, expected,
            "event payload no longer matches the shared frontend fixture; \
             update the fixture and the frontend guards together"
        );
    }

    #[test]
    fn request_event_payload_matches_shared_fixture() {
        let event = GatewayRequestEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: Some("beta=true".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            status: Some(200),
            error_category: None,
            error_code: None,
            duration_ms: 2350,
            ttfb_ms: Some(420),
            attempts: vec![FailoverAttempt {
                provider_id: 7,
                provider_name: "Provider A".to_string(),
                base_url: "https://provider-a.example".to_string(),
                outcome: "success".to_string(),
                status: Some(200),
                provider_index: Some(1),
                retry_index: Some(1),
                session_reuse: Some(false),
                error_category: None,
                error_code: None,
                decision: None,
                reason: None,
                selection_method: Some(decision_chain::SELECTION_METHOD_ORDERED),
                reason_code: Some(decision_chain::REASON_REQUEST_SUCCESS),
                attempt_started_ms: Some(1_750_000_000_123),
                attempt_duration_ms: Some(458),
                circuit_state_before: Some("CLOSED"),
                circuit_state_after: Some("CLOSED"),
                circuit_failure_count: Some(0),
                circuit_failure_threshold: Some(5),
                circuit_recover_at_unix: None,
                circuit_trigger_error_code: None,
                provider_bridged: Some(false),
                timeout_secs: None,
            }],
            input_tokens: Some(1200),
            output_tokens: Some(350),
            total_tokens: Some(1550),
            cache_read_input_tokens: Some(800),
            cache_creation_input_tokens: Some(100),
            cache_creation_5m_input_tokens: Some(60),
            cache_creation_1h_input_tokens: Some(40),
            // claude + non-bridged provider: effective input == raw input.
            effective_input_tokens: Some(1200),
            claude_model_mapping: Some(fixture_mapping()),
        };

        assert_matches_fixture(
            &event,
            include_str!("../../../src/services/gateway/__fixtures__/gatewayEvents/request.json"),
        );
    }

    #[test]
    fn request_start_event_payload_matches_shared_fixture() {
        let event = GatewayRequestStartEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: Some("beta=true".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            ts: 1_750_000_000,
        };

        assert_matches_fixture(
            &event,
            include_str!(
                "../../../src/services/gateway/__fixtures__/gatewayEvents/request_start.json"
            ),
        );
    }

    #[test]
    fn request_signal_event_payload_matches_shared_fixture() {
        let event = GatewayRequestSignalEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            phase: "complete",
            ts: 1_750_000_001,
        };

        assert_matches_fixture(
            &event,
            include_str!(
                "../../../src/services/gateway/__fixtures__/gatewayEvents/request_signal.json"
            ),
        );
    }

    #[test]
    fn attempt_event_payload_matches_shared_fixture() {
        let event = GatewayAttemptEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: Some("beta=true".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            attempt_index: 1,
            provider_id: 7,
            session_reuse: Some(false),
            provider_name: "Provider A".to_string(),
            base_url: "https://provider-a.example".to_string(),
            outcome: "success".to_string(),
            status: Some(200),
            attempt_started_ms: 1_750_000_000_123,
            attempt_duration_ms: 458,
            circuit_state_before: Some("CLOSED"),
            circuit_state_after: Some("CLOSED"),
            circuit_failure_count: Some(0),
            circuit_failure_threshold: Some(5),
            claude_model_mapping: Some(fixture_mapping()),
        };

        assert_matches_fixture(
            &event,
            include_str!("../../../src/services/gateway/__fixtures__/gatewayEvents/attempt.json"),
        );
    }

    #[test]
    fn circuit_event_payload_matches_shared_fixture() {
        let event = GatewayCircuitEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            provider_id: 7,
            provider_name: "Provider A".to_string(),
            base_url: "https://provider-a.example".to_string(),
            prev_state: "CLOSED",
            next_state: "OPEN",
            failure_count: 5,
            failure_threshold: 5,
            open_until: Some(1_750_001_800),
            cooldown_until: None,
            reason: "FAILURE_THRESHOLD_REACHED",
            ts: 1_750_000_000,
            trigger_error_code: Some("GW_UPSTREAM_TIMEOUT".to_string()),
            first_byte_timeout_secs: Some(300),
        };

        assert_matches_fixture(
            &event,
            include_str!("../../../src/services/gateway/__fixtures__/gatewayEvents/circuit.json"),
        );
    }

    #[test]
    fn circuit_event_serializes_missing_trigger_fields_as_null() {
        let event = GatewayCircuitEvent {
            trace_id: "trace-1".to_string(),
            cli_key: "claude".to_string(),
            provider_id: 7,
            provider_name: "Provider A".to_string(),
            base_url: "https://provider-a.example".to_string(),
            prev_state: "OPEN",
            next_state: "HALF_OPEN",
            failure_count: 5,
            failure_threshold: 5,
            open_until: None,
            cooldown_until: None,
            reason: "OPEN_EXPIRED",
            ts: 1_750_000_000,
            trigger_error_code: None,
            first_byte_timeout_secs: None,
        };

        let value = serde_json::to_value(event).expect("serializable circuit event");
        assert_eq!(value.get("trigger_error_code"), Some(&json!(null)));
        assert_eq!(value.get("first_byte_timeout_secs"), Some(&json!(null)));
    }

    #[test]
    fn log_event_payload_matches_shared_fixture() {
        let event = GatewayLogEvent {
            level: "warn",
            error_code: "GW_PORT_IN_USE",
            message: "port 37123 already in use".to_string(),
            requested_port: 37123,
            bound_port: 37124,
            base_url: "http://127.0.0.1:37124".to_string(),
        };

        assert_matches_fixture(
            &event,
            include_str!("../../../src/services/gateway/__fixtures__/gatewayEvents/log.json"),
        );
    }

    fn repeated_ascii(count: usize) -> String {
        "a".repeat(count)
    }

    #[test]
    fn request_event_attempt_trimming_keeps_latest_tail() {
        let attempts = (0..150)
            .map(|provider_id| sample_attempt(provider_id as i64))
            .collect::<Vec<_>>();

        let trimmed = trim_request_event_attempts(attempts);

        assert_eq!(trimmed.len(), REQUEST_EVENT_MAX_ATTEMPTS);
        assert_eq!(trimmed.first().map(|attempt| attempt.provider_id), Some(50));
        assert_eq!(trimmed.last().map(|attempt| attempt.provider_id), Some(149));
    }

    #[test]
    fn request_event_attempt_trimming_keeps_limit_sized_payload() {
        let attempts = (0..REQUEST_EVENT_MAX_ATTEMPTS)
            .map(|provider_id| sample_attempt(provider_id as i64))
            .collect::<Vec<_>>();

        let trimmed = trim_request_event_attempts(attempts);

        assert_eq!(trimmed.len(), REQUEST_EVENT_MAX_ATTEMPTS);
        assert_eq!(trimmed.first().map(|attempt| attempt.provider_id), Some(0));
        assert_eq!(trimmed.last().map(|attempt| attempt.provider_id), Some(99));
    }

    #[test]
    fn request_event_attempt_trimming_bounds_attempt_text() {
        let attempts = vec![FailoverAttempt {
            provider_name: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 10),
            base_url: repeated_ascii(EVENT_URL_MAX_CHARS + 10),
            outcome: repeated_ascii(EVENT_STATE_MAX_CHARS + 10),
            reason: Some(repeated_ascii(EVENT_QUERY_MAX_CHARS + 10)),
            ..sample_attempt(1)
        }];

        let trimmed = trim_request_event_attempts(attempts);
        let attempt = trimmed.first().expect("retains attempt");

        assert_eq!(
            ascii_len(&attempt.provider_name),
            EVENT_SHORT_TEXT_MAX_CHARS
        );
        assert_eq!(ascii_len(&attempt.base_url), EVENT_URL_MAX_CHARS);
        assert_eq!(ascii_len(&attempt.outcome), EVENT_STATE_MAX_CHARS);
        assert_eq!(
            attempt.reason.as_deref().map(ascii_len),
            Some(EVENT_QUERY_MAX_CHARS)
        );
    }

    #[test]
    fn event_text_truncation_preserves_utf8_boundaries() {
        let truncated = truncate_chars(
            "界".repeat(EVENT_STATE_MAX_CHARS + 1),
            EVENT_STATE_MAX_CHARS,
        );

        assert_eq!(truncated.chars().count(), EVENT_STATE_MAX_CHARS);
        assert!(truncated.chars().all(|ch| ch == '界'));
    }

    #[test]
    fn attempt_event_bounds_text_before_emit_serialization() {
        let payload = GatewayAttemptEvent {
            trace_id: "trace-1".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("session-1".to_string()),
            method: repeated_ascii(EVENT_METHOD_MAX_CHARS + 1),
            path: repeated_ascii(EVENT_PATH_MAX_CHARS + 1),
            query: Some(repeated_ascii(EVENT_QUERY_MAX_CHARS + 1)),
            requested_model: Some(repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1)),
            attempt_index: 1,
            provider_id: 7,
            session_reuse: Some(false),
            provider_name: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1),
            base_url: repeated_ascii(EVENT_URL_MAX_CHARS + 1),
            outcome: repeated_ascii(EVENT_STATE_MAX_CHARS + 1),
            status: Some(500),
            attempt_started_ms: 10,
            attempt_duration_ms: 5,
            circuit_state_before: None,
            circuit_state_after: None,
            circuit_failure_count: None,
            circuit_failure_threshold: None,
            claude_model_mapping: Some(ClaudeModelMapping {
                requested_model: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1),
                effective_model: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1),
                mapping_kind: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1),
                provider_id: 7,
                provider_name: repeated_ascii(EVENT_SHORT_TEXT_MAX_CHARS + 1),
                applied: true,
            }),
        };

        let bounded = bound_attempt_event(payload);

        assert_eq!(bounded.trace_id, "trace-1");
        assert_eq!(bounded.cli_key, "claude");
        assert_eq!(bounded.session_id.as_deref(), Some("session-1"));
        assert_eq!(ascii_len(&bounded.method), EVENT_METHOD_MAX_CHARS);
        assert_eq!(ascii_len(&bounded.path), EVENT_PATH_MAX_CHARS);
        assert_eq!(
            bounded.query.as_deref().map(ascii_len),
            Some(EVENT_QUERY_MAX_CHARS)
        );
        assert_eq!(
            bounded.requested_model.as_deref().map(ascii_len),
            Some(EVENT_SHORT_TEXT_MAX_CHARS)
        );
        assert_eq!(
            ascii_len(&bounded.provider_name),
            EVENT_SHORT_TEXT_MAX_CHARS
        );
        assert_eq!(ascii_len(&bounded.base_url), EVENT_URL_MAX_CHARS);
        assert_eq!(ascii_len(&bounded.outcome), EVENT_STATE_MAX_CHARS);
        let mapping = bounded.claude_model_mapping.expect("mapping retained");
        assert_eq!(
            ascii_len(&mapping.requested_model),
            EVENT_SHORT_TEXT_MAX_CHARS
        );
        assert_eq!(
            ascii_len(&mapping.effective_model),
            EVENT_SHORT_TEXT_MAX_CHARS
        );
        assert_eq!(ascii_len(&mapping.mapping_kind), EVENT_SHORT_TEXT_MAX_CHARS);
        assert_eq!(
            ascii_len(&mapping.provider_name),
            EVENT_SHORT_TEXT_MAX_CHARS
        );
    }

    #[test]
    fn attempt_event_serializes_claude_model_mapping() {
        let payload = GatewayAttemptEvent {
            trace_id: "trace-1".to_string(),
            cli_key: "claude".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: None,
            requested_model: Some("claude-sonnet".to_string()),
            attempt_index: 1,
            provider_id: 7,
            session_reuse: Some(false),
            provider_name: "Provider A".to_string(),
            base_url: "https://provider.example".to_string(),
            outcome: "started".to_string(),
            status: None,
            attempt_started_ms: 10,
            attempt_duration_ms: 0,
            circuit_state_before: None,
            circuit_state_after: None,
            circuit_failure_count: None,
            circuit_failure_threshold: None,
            claude_model_mapping: Some(sample_mapping()),
        };

        let value = serde_json::to_value(payload).expect("serializable attempt event");
        assert_eq!(
            value.get("claude_model_mapping"),
            Some(&json!({
                "requestedModel": "claude-sonnet",
                "effectiveModel": "gpt-5.4",
                "mappingKind": "sonnet",
                "providerId": 7,
                "providerName": "Provider A",
                "applied": true,
            }))
        );
    }

    #[test]
    fn request_event_serializes_empty_claude_model_mapping_as_null() {
        let payload = GatewayRequestEvent {
            trace_id: "trace-2".to_string(),
            cli_key: "claude".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: None,
            requested_model: Some("claude-sonnet".to_string()),
            status: Some(200),
            error_category: None,
            error_code: None,
            duration_ms: 50,
            ttfb_ms: Some(10),
            attempts: Vec::new(),
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            cache_creation_5m_input_tokens: None,
            cache_creation_1h_input_tokens: None,
            effective_input_tokens: None,
            claude_model_mapping: None,
        };

        let value = serde_json::to_value(payload).expect("serializable request event");
        assert_eq!(value.get("claude_model_mapping"), Some(&json!(null)));
    }
}
