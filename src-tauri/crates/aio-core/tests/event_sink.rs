use aio_contract::{
    AppEvent, AppStartupStatus, GatewayAttemptEvent, GatewayCircuitEvent, GatewayLogEvent,
    GatewayRequestEvent, GatewayRequestSignalEvent, GatewayRequestStartEvent, GatewayStatus,
    NoticeEventPayload, NoticeLevel,
};
use aio_core::{EventSink, RecordingEventSink};
use std::sync::Arc;

fn sample_events() -> Vec<AppEvent> {
    vec![
        AppEvent::GatewayStatusChanged(GatewayStatus::default()),
        AppEvent::GatewayRequestStarted(GatewayRequestStartEvent {
            trace_id: "trace-start".to_string(),
            cli_key: "codex".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            query: None,
            requested_model: Some("gpt-5".to_string()),
            ts: 1,
        }),
        AppEvent::GatewayAttempted(GatewayAttemptEvent {
            trace_id: "trace-attempt".to_string(),
            cli_key: "codex".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            query: None,
            requested_model: Some("gpt-5".to_string()),
            attempt_index: 1,
            provider_id: 7,
            session_reuse: Some(false),
            provider_name: "Provider".to_string(),
            base_url: "https://provider.example".to_string(),
            outcome: "started".to_string(),
            status: None,
            attempt_started_ms: 2,
            attempt_duration_ms: 0,
            circuit_state_before: Some("CLOSED"),
            circuit_state_after: None,
            circuit_failure_count: Some(0),
            circuit_failure_threshold: Some(5),
            claude_model_mapping: None,
        }),
        AppEvent::GatewayRequestCompleted(GatewayRequestEvent {
            trace_id: "trace-complete".to_string(),
            cli_key: "codex".to_string(),
            session_id: None,
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            query: None,
            requested_model: Some("gpt-5".to_string()),
            status: Some(200),
            error_category: None,
            error_code: None,
            duration_ms: 3,
            ttfb_ms: Some(1),
            attempts: vec![],
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            cache_creation_5m_input_tokens: None,
            cache_creation_1h_input_tokens: None,
            effective_input_tokens: None,
            claude_model_mapping: None,
        }),
        AppEvent::GatewayRequestSignal(GatewayRequestSignalEvent {
            trace_id: "trace-signal".to_string(),
            cli_key: "codex".to_string(),
            session_id: None,
            requested_model: Some("gpt-5".to_string()),
            phase: "complete",
            ts: 4,
        }),
        AppEvent::GatewayLog(GatewayLogEvent {
            level: "warn",
            error_code: "GW_TEST",
            message: "test".to_string(),
            requested_port: 0,
            bound_port: 0,
            base_url: String::new(),
        }),
        AppEvent::GatewayCircuitChanged(GatewayCircuitEvent {
            trace_id: "trace-circuit".to_string(),
            cli_key: "codex".to_string(),
            provider_id: 7,
            provider_name: "Provider".to_string(),
            base_url: "https://provider.example".to_string(),
            prev_state: "CLOSED",
            next_state: "OPEN",
            failure_count: 5,
            failure_threshold: 5,
            open_until: Some(10),
            cooldown_until: None,
            reason: "FAILURE_THRESHOLD_REACHED",
            ts: 5,
            trigger_error_code: Some("GW_TEST".to_string()),
            first_byte_timeout_secs: None,
        }),
        AppEvent::StartupStatusChanged(AppStartupStatus::default()),
        AppEvent::NoticeRequested(NoticeEventPayload {
            level: NoticeLevel::Info,
            title: "Title".to_string(),
            body: "Body".to_string(),
        }),
        AppEvent::PlatformActivationRequested,
    ]
}

#[test]
fn recording_sink_keeps_every_app_event_variant_in_order() {
    let sink = RecordingEventSink::default();
    let expected = sample_events();

    for event in expected.iter().cloned() {
        sink.publish(event);
    }

    let recorded = sink.events();
    assert_eq!(recorded.len(), expected.len());
    for (recorded, expected) in recorded.iter().zip(expected.iter()) {
        assert_eq!(recorded.metadata(), expected.metadata());
        assert_eq!(
            serde_json::to_value(recorded).expect("serialize recorded event"),
            serde_json::to_value(expected).expect("serialize expected event")
        );
    }
}

#[test]
fn event_sink_is_object_safe() {
    let recording = Arc::new(RecordingEventSink::default());
    let sink: Arc<dyn EventSink> = recording.clone();

    sink.publish(AppEvent::PlatformActivationRequested);

    assert_eq!(recording.events().len(), 1);
}
