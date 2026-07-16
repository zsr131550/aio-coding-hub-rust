use aio_contract::{
    AppEvent, AppStartupStage, AppStartupStatus, ClaudeModelMapping, EventCoalescing,
    EventDelivery, FailoverAttempt, GatewayAttemptEvent, GatewayCircuitEvent, GatewayLogEvent,
    GatewayRequestEvent, GatewayRequestSignalEvent, GatewayRequestStartEvent, GatewayStatus,
    NoticeEventPayload, NoticeLevel,
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

fn fixture(path: &str) -> Value {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = std::fs::read(repository_root.join(path)).expect("read committed event fixture");
    serde_json::from_slice(&bytes).expect("parse committed event fixture")
}

fn assert_fixture<T: Serialize>(payload: &T, path: &str) {
    assert_eq!(
        serde_json::to_value(payload).expect("serialize typed event payload"),
        fixture(path),
        "typed payload no longer matches {path}"
    );
}

fn assert_event(
    event: AppEvent,
    name: &'static str,
    delivery: EventDelivery,
    coalescing: EventCoalescing,
    fixture_path: &str,
) {
    let metadata = event.metadata();
    assert_eq!(metadata.legacy_name, Some(name));
    assert_eq!(metadata.delivery, delivery);
    assert_eq!(metadata.coalescing, coalescing);
    assert_fixture(&event, fixture_path);
}

fn mapping() -> ClaudeModelMapping {
    ClaudeModelMapping {
        requested_model: "claude-sonnet-4-5".to_string(),
        effective_model: "gpt-5.4".to_string(),
        mapping_kind: "sonnet".to_string(),
        provider_id: 7,
        provider_name: "Provider A".to_string(),
        applied: true,
    }
}

#[test]
fn frozen_non_heartbeat_events_keep_their_legacy_routes_and_payloads() {
    assert_event(
        AppEvent::GatewayStatusChanged(GatewayStatus {
            running: true,
            port: Some(37123),
            base_url: Some("http://127.0.0.1:37123".to_string()),
            listen_addr: Some("127.0.0.1:37123".to_string()),
        }),
        "gateway:status",
        EventDelivery::Snapshot,
        EventCoalescing::LatestWins,
        "src/services/gateway/__fixtures__/gatewayEvents/status.json",
    );

    assert_event(
        AppEvent::GatewayRequestStarted(GatewayRequestStartEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            method: "POST".to_string(),
            path: "/v1/messages".to_string(),
            query: Some("beta=true".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            ts: 1_750_000_000,
        }),
        "gateway:request_start",
        EventDelivery::Realtime,
        EventCoalescing::None,
        "src/services/gateway/__fixtures__/gatewayEvents/request_start.json",
    );

    assert_event(
        AppEvent::GatewayAttempted(GatewayAttemptEvent {
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
            claude_model_mapping: Some(mapping()),
        }),
        "gateway:attempt",
        EventDelivery::Realtime,
        EventCoalescing::None,
        "src/services/gateway/__fixtures__/gatewayEvents/attempt.json",
    );

    assert_event(
        AppEvent::GatewayRequestCompleted(GatewayRequestEvent {
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
            duration_ms: 2_350,
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
                selection_method: Some("ordered"),
                reason_code: Some("request_success"),
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
            input_tokens: Some(1_200),
            output_tokens: Some(350),
            total_tokens: Some(1_550),
            cache_read_input_tokens: Some(800),
            cache_creation_input_tokens: Some(100),
            cache_creation_5m_input_tokens: Some(60),
            cache_creation_1h_input_tokens: Some(40),
            effective_input_tokens: Some(1_200),
            claude_model_mapping: Some(mapping()),
        }),
        "gateway:request",
        EventDelivery::DurableProjection,
        EventCoalescing::None,
        "src/services/gateway/__fixtures__/gatewayEvents/request.json",
    );

    assert_event(
        AppEvent::GatewayRequestSignal(GatewayRequestSignalEvent {
            trace_id: "trace-fixture-001".to_string(),
            cli_key: "claude".to_string(),
            session_id: Some("sess-fixture-001".to_string()),
            requested_model: Some("claude-sonnet-4-5".to_string()),
            phase: "complete",
            ts: 1_750_000_001,
        }),
        "gateway:request_signal",
        EventDelivery::Realtime,
        EventCoalescing::SameTracePhaseLatestWins,
        "src/services/gateway/__fixtures__/gatewayEvents/request_signal.json",
    );

    assert_event(
        AppEvent::GatewayLog(GatewayLogEvent {
            level: "warn",
            error_code: "GW_PORT_IN_USE",
            message: "port 37123 already in use".to_string(),
            requested_port: 37123,
            bound_port: 37124,
            base_url: "http://127.0.0.1:37124".to_string(),
        }),
        "gateway:log",
        EventDelivery::BestEffort,
        EventCoalescing::None,
        "src/services/gateway/__fixtures__/gatewayEvents/log.json",
    );

    assert_event(
        AppEvent::GatewayCircuitChanged(GatewayCircuitEvent {
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
        }),
        "gateway:circuit",
        EventDelivery::Realtime,
        EventCoalescing::ProviderLatestWins,
        "src/services/gateway/__fixtures__/gatewayEvents/circuit.json",
    );

    assert_event(
        AppEvent::StartupStatusChanged(AppStartupStatus {
            running: false,
            current_stage: AppStartupStage::Ready,
            failed_stage: None,
            error_message: None,
            can_retry: false,
        }),
        "app:startup_status",
        EventDelivery::Snapshot,
        EventCoalescing::LatestWins,
        "src/services/app/__fixtures__/startupStatus/ready.json",
    );

    assert_event(
        AppEvent::NoticeRequested(NoticeEventPayload {
            level: NoticeLevel::Info,
            title: "AIO Coding Hub \u{00b7} Fixture".to_string(),
            body: "Synthetic compatibility fixture notice".to_string(),
        }),
        "notice:notify",
        EventDelivery::BestEffort,
        EventCoalescing::None,
        "src/services/app/__fixtures__/notice.json",
    );
}

#[test]
fn platform_activation_is_internal_control_event() {
    let metadata = AppEvent::PlatformActivationRequested.metadata();
    assert_eq!(metadata.legacy_name, None);
    assert_eq!(metadata.delivery, EventDelivery::Control);
    assert_eq!(metadata.coalescing, EventCoalescing::None);
}
