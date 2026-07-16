use serde::Serialize;

pub const GATEWAY_STATUS_EVENT_NAME: &str = "gateway:status";
pub const GATEWAY_REQUEST_START_EVENT_NAME: &str = "gateway:request_start";
pub const GATEWAY_ATTEMPT_EVENT_NAME: &str = "gateway:attempt";
pub const GATEWAY_REQUEST_EVENT_NAME: &str = "gateway:request";
pub const GATEWAY_REQUEST_SIGNAL_EVENT_NAME: &str = "gateway:request_signal";
pub const GATEWAY_LOG_EVENT_NAME: &str = "gateway:log";
pub const GATEWAY_CIRCUIT_EVENT_NAME: &str = "gateway:circuit";
pub const APP_STARTUP_STATUS_EVENT_NAME: &str = "app:startup_status";
pub const NOTICE_EVENT_NAME: &str = "notice:notify";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventDelivery {
    Snapshot,
    Realtime,
    DurableProjection,
    BestEffort,
    Control,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventCoalescing {
    None,
    LatestWins,
    SameTracePhaseLatestWins,
    ProviderLatestWins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventMetadata {
    pub legacy_name: Option<&'static str>,
    pub delivery: EventDelivery,
    pub coalescing: EventCoalescing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum AppEvent {
    GatewayStatusChanged(GatewayStatus),
    GatewayRequestStarted(GatewayRequestStartEvent),
    GatewayAttempted(GatewayAttemptEvent),
    GatewayRequestCompleted(GatewayRequestEvent),
    GatewayRequestSignal(GatewayRequestSignalEvent),
    GatewayLog(GatewayLogEvent),
    GatewayCircuitChanged(GatewayCircuitEvent),
    StartupStatusChanged(AppStartupStatus),
    NoticeRequested(NoticeEventPayload),
    PlatformActivationRequested,
}

impl AppEvent {
    pub const fn metadata(&self) -> EventMetadata {
        match self {
            Self::GatewayStatusChanged(_) => EventMetadata {
                legacy_name: Some(GATEWAY_STATUS_EVENT_NAME),
                delivery: EventDelivery::Snapshot,
                coalescing: EventCoalescing::LatestWins,
            },
            Self::GatewayRequestStarted(_) => EventMetadata {
                legacy_name: Some(GATEWAY_REQUEST_START_EVENT_NAME),
                delivery: EventDelivery::Realtime,
                coalescing: EventCoalescing::None,
            },
            Self::GatewayAttempted(_) => EventMetadata {
                legacy_name: Some(GATEWAY_ATTEMPT_EVENT_NAME),
                delivery: EventDelivery::Realtime,
                coalescing: EventCoalescing::None,
            },
            Self::GatewayRequestCompleted(_) => EventMetadata {
                legacy_name: Some(GATEWAY_REQUEST_EVENT_NAME),
                delivery: EventDelivery::DurableProjection,
                coalescing: EventCoalescing::None,
            },
            Self::GatewayRequestSignal(_) => EventMetadata {
                legacy_name: Some(GATEWAY_REQUEST_SIGNAL_EVENT_NAME),
                delivery: EventDelivery::Realtime,
                coalescing: EventCoalescing::SameTracePhaseLatestWins,
            },
            Self::GatewayLog(_) => EventMetadata {
                legacy_name: Some(GATEWAY_LOG_EVENT_NAME),
                delivery: EventDelivery::BestEffort,
                coalescing: EventCoalescing::None,
            },
            Self::GatewayCircuitChanged(_) => EventMetadata {
                legacy_name: Some(GATEWAY_CIRCUIT_EVENT_NAME),
                delivery: EventDelivery::Realtime,
                coalescing: EventCoalescing::ProviderLatestWins,
            },
            Self::StartupStatusChanged(_) => EventMetadata {
                legacy_name: Some(APP_STARTUP_STATUS_EVENT_NAME),
                delivery: EventDelivery::Snapshot,
                coalescing: EventCoalescing::LatestWins,
            },
            Self::NoticeRequested(_) => EventMetadata {
                legacy_name: Some(NOTICE_EVENT_NAME),
                delivery: EventDelivery::BestEffort,
                coalescing: EventCoalescing::None,
            },
            Self::PlatformActivationRequested => EventMetadata {
                legacy_name: None,
                delivery: EventDelivery::Control,
                coalescing: EventCoalescing::None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type, Default, PartialEq, Eq)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub listen_addr: Option<String>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct FailoverAttempt {
    pub provider_id: i64,
    pub provider_name: String,
    pub base_url: String,
    pub outcome: String,
    pub status: Option<u16>,
    pub provider_index: Option<u32>,
    pub retry_index: Option<u32>,
    pub session_reuse: Option<bool>,
    pub error_category: Option<&'static str>,
    pub error_code: Option<&'static str>,
    pub decision: Option<&'static str>,
    pub reason: Option<String>,
    pub selection_method: Option<&'static str>,
    pub reason_code: Option<&'static str>,
    pub attempt_started_ms: Option<u128>,
    pub attempt_duration_ms: Option<u128>,
    pub circuit_state_before: Option<&'static str>,
    pub circuit_state_after: Option<&'static str>,
    pub circuit_failure_count: Option<u32>,
    pub circuit_failure_threshold: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_recover_at_unix: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_trigger_error_code: Option<&'static str>,
    pub provider_bridged: Option<bool>,
    pub timeout_secs: Option<u32>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelMapping {
    pub requested_model: String,
    pub effective_model: String,
    pub mapping_kind: String,
    pub provider_id: i64,
    pub provider_name: String,
    pub applied: bool,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GatewayRequestEvent {
    pub trace_id: String,
    pub cli_key: String,
    pub session_id: Option<String>,
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub requested_model: Option<String>,
    pub status: Option<u16>,
    pub error_category: Option<&'static str>,
    pub error_code: Option<&'static str>,
    pub duration_ms: u128,
    pub ttfb_ms: Option<u128>,
    pub attempts: Vec<FailoverAttempt>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_creation_5m_input_tokens: Option<i64>,
    pub cache_creation_1h_input_tokens: Option<i64>,
    pub effective_input_tokens: Option<i64>,
    pub claude_model_mapping: Option<ClaudeModelMapping>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GatewayRequestStartEvent {
    pub trace_id: String,
    pub cli_key: String,
    pub session_id: Option<String>,
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub requested_model: Option<String>,
    pub ts: i64,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GatewayRequestSignalEvent {
    pub trace_id: String,
    pub cli_key: String,
    pub session_id: Option<String>,
    pub requested_model: Option<String>,
    pub phase: &'static str,
    pub ts: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, specta::Type)]
pub struct GatewayAttemptEvent {
    pub trace_id: String,
    pub cli_key: String,
    pub session_id: Option<String>,
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub requested_model: Option<String>,
    pub attempt_index: u32,
    pub provider_id: i64,
    pub session_reuse: Option<bool>,
    pub provider_name: String,
    pub base_url: String,
    pub outcome: String,
    pub status: Option<u16>,
    pub attempt_started_ms: u128,
    pub attempt_duration_ms: u128,
    pub circuit_state_before: Option<&'static str>,
    pub circuit_state_after: Option<&'static str>,
    pub circuit_failure_count: Option<u32>,
    pub circuit_failure_threshold: Option<u32>,
    pub claude_model_mapping: Option<ClaudeModelMapping>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GatewayCircuitEvent {
    pub trace_id: String,
    pub cli_key: String,
    pub provider_id: i64,
    pub provider_name: String,
    pub base_url: String,
    pub prev_state: &'static str,
    pub next_state: &'static str,
    pub failure_count: u32,
    pub failure_threshold: u32,
    pub open_until: Option<i64>,
    pub cooldown_until: Option<i64>,
    pub reason: &'static str,
    pub ts: i64,
    pub trigger_error_code: Option<String>,
    pub first_byte_timeout_secs: Option<u32>,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
pub struct GatewayLogEvent {
    pub level: &'static str,
    pub error_code: &'static str,
    pub message: String,
    pub requested_port: u16,
    pub bound_port: u16,
    pub base_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AppStartupStage {
    Idle,
    InitializingDb,
    ReadingSettings,
    StartingGateway,
    SyncingCliProxy,
    FinalizingWsl,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppStartupStatus {
    pub running: bool,
    pub current_stage: AppStartupStage,
    pub failed_stage: Option<AppStartupStage>,
    pub error_message: Option<String>,
    pub can_retry: bool,
}

impl Default for AppStartupStatus {
    fn default() -> Self {
        Self {
            running: false,
            current_stage: AppStartupStage::Idle,
            failed_stage: None,
            error_message: None,
            can_retry: false,
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoticeEventPayload {
    pub level: NoticeLevel,
    pub title: String,
    pub body: String,
}
