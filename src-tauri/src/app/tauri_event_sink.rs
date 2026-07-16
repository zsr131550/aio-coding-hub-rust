//! Usage: Tauri adapter for typed headless application events.

use aio_contract::AppEvent;
use aio_core::EventSink;
use tauri::Manager;

const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) struct TauriEventSink<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriEventSink<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> EventSink for TauriEventSink<R> {
    fn publish(&self, event: AppEvent) {
        if detail_visibility_gated(&event) && !should_emit_gateway_detail_event(&self.app) {
            return;
        }

        let Some((name, payload)) = legacy_event(&event) else {
            return;
        };
        crate::app::heartbeat_watchdog::gated_emit(&self.app, name, payload);
    }
}

pub(crate) fn legacy_event(event: &AppEvent) -> Option<(&'static str, serde_json::Value)> {
    let name = event.metadata().legacy_name?;
    match serde_json::to_value(event) {
        Ok(payload) => Some((name, payload)),
        Err(error) => {
            tracing::warn!(event = name, %error, "failed to serialize application event");
            None
        }
    }
}

fn detail_visibility_gated(event: &AppEvent) -> bool {
    matches!(
        event,
        AppEvent::GatewayRequestStarted(_)
            | AppEvent::GatewayAttempted(_)
            | AppEvent::GatewayRequestCompleted(_)
    )
}

fn should_emit_gateway_detail_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return true;
    };

    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    visible && !minimized
}

#[cfg(test)]
mod tests {
    use super::legacy_event;
    use aio_contract::{
        AppEvent, AppStartupStatus, GatewayAttemptEvent, GatewayCircuitEvent, GatewayLogEvent,
        GatewayRequestEvent, GatewayRequestSignalEvent, GatewayRequestStartEvent, GatewayStatus,
        NoticeEventPayload, NoticeLevel,
    };

    fn routed_events() -> Vec<AppEvent> {
        vec![
            AppEvent::GatewayStatusChanged(GatewayStatus::default()),
            AppEvent::GatewayRequestStarted(GatewayRequestStartEvent {
                trace_id: "start".to_string(),
                cli_key: "codex".to_string(),
                session_id: None,
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                query: None,
                requested_model: None,
                ts: 1,
            }),
            AppEvent::GatewayAttempted(GatewayAttemptEvent {
                trace_id: "attempt".to_string(),
                cli_key: "codex".to_string(),
                session_id: None,
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                query: None,
                requested_model: None,
                attempt_index: 1,
                provider_id: 1,
                session_reuse: None,
                provider_name: "Provider".to_string(),
                base_url: "https://provider.example".to_string(),
                outcome: "started".to_string(),
                status: None,
                attempt_started_ms: 1,
                attempt_duration_ms: 0,
                circuit_state_before: None,
                circuit_state_after: None,
                circuit_failure_count: None,
                circuit_failure_threshold: None,
                claude_model_mapping: None,
            }),
            AppEvent::GatewayRequestCompleted(GatewayRequestEvent {
                trace_id: "complete".to_string(),
                cli_key: "codex".to_string(),
                session_id: None,
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                query: None,
                requested_model: None,
                status: Some(200),
                error_category: None,
                error_code: None,
                duration_ms: 1,
                ttfb_ms: None,
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
                trace_id: "signal".to_string(),
                cli_key: "codex".to_string(),
                session_id: None,
                requested_model: None,
                phase: "complete",
                ts: 1,
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
                trace_id: "circuit".to_string(),
                cli_key: "codex".to_string(),
                provider_id: 1,
                provider_name: "Provider".to_string(),
                base_url: "https://provider.example".to_string(),
                prev_state: "CLOSED",
                next_state: "OPEN",
                failure_count: 1,
                failure_threshold: 1,
                open_until: None,
                cooldown_until: None,
                reason: "test",
                ts: 1,
                trigger_error_code: None,
                first_byte_timeout_secs: None,
            }),
            AppEvent::StartupStatusChanged(AppStartupStatus::default()),
            AppEvent::NoticeRequested(NoticeEventPayload {
                level: NoticeLevel::Info,
                title: "Title".to_string(),
                body: "Body".to_string(),
            }),
        ]
    }

    #[test]
    fn typed_events_map_to_exact_legacy_routes_and_payloads() {
        for event in routed_events() {
            let expected_name = event.metadata().legacy_name.expect("legacy route");
            let expected_payload = serde_json::to_value(&event).expect("serialize event");
            let (name, payload) = legacy_event(&event).expect("mapped legacy event");

            assert_eq!(name, expected_name);
            assert_eq!(payload, expected_payload);
        }
        assert!(legacy_event(&AppEvent::PlatformActivationRequested).is_none());
    }
}
