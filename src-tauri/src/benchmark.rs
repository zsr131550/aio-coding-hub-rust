//! Benchmark-only startup and UI instrumentation.
//!
//! The module stays inert unless the runner supplies a validated absolute
//! report path and an isolated test-home marker with the same run id.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const BENCHMARK_SCHEMA_VERSION: u32 = 1;
const MARKER_FILE_NAME: &str = ".aio-benchmark-home.json";
const REPORT_ENV: &str = "AIO_CODING_HUB_BENCHMARK_REPORT";
const TEST_HOME_ENV: &str = "AIO_CODING_HUB_TEST_HOME";
const REAL_HOME_ENV: &str = "AIO_CODING_HUB_BENCHMARK_REAL_HOME";
const RUN_ID_ENV: &str = "AIO_CODING_HUB_BENCHMARK_RUN_ID";
const SCENARIO_ENV: &str = "AIO_CODING_HUB_BENCHMARK_SCENARIO";
const FIXTURE_ENV: &str = "AIO_CODING_HUB_BENCHMARK_FIXTURE";
const FIXTURE_SHA256_ENV: &str = "AIO_CODING_HUB_BENCHMARK_FIXTURE_SHA256";
const FIXTURE_ROW_COUNT_ENV: &str = "AIO_CODING_HUB_BENCHMARK_FIXTURE_ROW_COUNT";
const DURATION_MS_ENV: &str = "AIO_CODING_HUB_BENCHMARK_DURATION_MS";
const GATEWAY_UPSTREAM_ENV: &str = "AIO_CODING_HUB_BENCHMARK_UPSTREAM_URL";
const MAX_REPORT_DATA_BYTES: usize = 16 * 1024;
const MAX_FIXTURE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FIXTURE_LINE_BYTES: usize = 64 * 1024;
const VISIBLE_IDLE_DURATION: Duration = Duration::from_secs(60);
const HIDDEN_TRAY_DURATION: Duration = Duration::from_secs(600);
const SCENARIO_COMPLETION_PENDING: u8 = 0;
const SCENARIO_COMPLETION_WRITING: u8 = 1;
const SCENARIO_COMPLETION_DONE: u8 = 2;
const SCENARIO_COMPLETION_FAILED: u8 = 3;

static REPORTER: OnceLock<Option<BenchmarkReporter>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BenchmarkScenario {
    StartupColdProcess,
    StartupWarmProcess,
    FirstInteractive,
    VisibleIdle,
    HiddenTray,
    Logs10k,
    GatewayLoad,
}

impl BenchmarkScenario {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "startup-cold-process" => Some(Self::StartupColdProcess),
            "startup-warm-process" => Some(Self::StartupWarmProcess),
            "first-interactive" => Some(Self::FirstInteractive),
            "visible-idle" => Some(Self::VisibleIdle),
            "hidden-tray" => Some(Self::HiddenTray),
            "logs-10k" => Some(Self::Logs10k),
            "gateway-load" => Some(Self::GatewayLoad),
            _ => None,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::StartupColdProcess => "startup-cold-process",
            Self::StartupWarmProcess => "startup-warm-process",
            Self::FirstInteractive => "first-interactive",
            Self::VisibleIdle => "visible-idle",
            Self::HiddenTray => "hidden-tray",
            Self::Logs10k => "logs-10k",
            Self::GatewayLoad => "gateway-load",
        }
    }
}

pub(crate) fn native_idle_completion_delay(
    scenario: BenchmarkScenario,
    duration_ms: Option<u64>,
) -> Option<Duration> {
    let default = match scenario {
        BenchmarkScenario::VisibleIdle => VISIBLE_IDLE_DURATION,
        BenchmarkScenario::HiddenTray => HIDDEN_TRAY_DURATION,
        _ => return None,
    };
    Some(duration_ms.map(Duration::from_millis).unwrap_or(default))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IsolationMarker {
    pub(crate) schema_version: u32,
    pub(crate) run_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BenchmarkConfig {
    pub(crate) report_path: PathBuf,
    pub(crate) test_home: PathBuf,
    pub(crate) run_id: String,
    pub(crate) scenario: BenchmarkScenario,
    pub(crate) fixture_path: Option<PathBuf>,
    pub(crate) fixture_sha256: Option<String>,
    pub(crate) fixture_row_count: Option<usize>,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) gateway_upstream_url: Option<reqwest::Url>,
}

impl BenchmarkConfig {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_values(
        report: Option<OsString>,
        test_home: Option<OsString>,
        run_id: Option<OsString>,
        scenario: Option<OsString>,
        fixture_path: Option<OsString>,
        fixture_sha256: Option<OsString>,
        fixture_row_count: Option<OsString>,
    ) -> Result<Option<Self>, String> {
        let Some(report) = report else {
            return Ok(None);
        };

        let report_path = PathBuf::from(report);
        require_absolute_clean_path(&report_path, "benchmark report")?;
        let test_home_input = PathBuf::from(
            test_home.ok_or_else(|| format!("{TEST_HOME_ENV} is required in benchmark mode"))?,
        );
        require_absolute_clean_path(&test_home_input, "benchmark test home")?;
        let report_relative = report_path
            .strip_prefix(&test_home_input)
            .map_err(|_| "benchmark report must be inside the isolated test home".to_string())?;
        if report_relative.as_os_str().is_empty() {
            return Err("benchmark report must name a file".to_string());
        }

        let test_home = test_home_input
            .canonicalize()
            .map_err(|err| format!("canonicalize benchmark test home: {err}"))?;
        let report_path = test_home.join(report_relative);
        let run_id = os_string_to_utf8(
            run_id.ok_or_else(|| format!("{RUN_ID_ENV} is required in benchmark mode"))?,
            "benchmark runId",
        )?;
        if !is_safe_token(&run_id, 64) {
            return Err("benchmark runId must be 1-64 ASCII token characters".to_string());
        }

        let marker_path = test_home.join(MARKER_FILE_NAME);
        let marker: IsolationMarker =
            serde_json::from_slice(&fs::read(&marker_path).map_err(|err| {
                format!(
                    "read benchmark home marker {}: {err}",
                    marker_path.display()
                )
            })?)
            .map_err(|err| format!("parse benchmark home marker: {err}"))?;
        if marker.schema_version != BENCHMARK_SCHEMA_VERSION {
            return Err(format!(
                "benchmark home marker schema mismatch: expected {}, got {}",
                BENCHMARK_SCHEMA_VERSION, marker.schema_version
            ));
        }
        if marker.run_id != run_id {
            return Err("benchmark home marker runId does not match environment".to_string());
        }

        let scenario = os_string_to_utf8(
            scenario.ok_or_else(|| format!("{SCENARIO_ENV} is required in benchmark mode"))?,
            "benchmark scenario",
        )?;
        let scenario = BenchmarkScenario::parse(&scenario)
            .ok_or_else(|| format!("unsupported benchmark scenario: {scenario}"))?;

        let fixture_path = fixture_path.map(PathBuf::from);
        if let Some(path) = &fixture_path {
            require_absolute_clean_path(path, "benchmark fixture")?;
        }
        let fixture_sha256 = fixture_sha256
            .map(|value| os_string_to_utf8(value, "benchmark fixture SHA-256"))
            .transpose()?
            .map(|value| value.to_ascii_lowercase());
        if fixture_sha256
            .as_deref()
            .is_some_and(|value| !is_sha256(value))
        {
            return Err("benchmark fixture SHA-256 must be 64 hex characters".to_string());
        }
        let fixture_row_count = fixture_row_count
            .map(|value| os_string_to_utf8(value, "benchmark fixture row count"))
            .transpose()?
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    "benchmark fixture row count must be a positive integer".to_string()
                })
            })
            .transpose()?;
        if fixture_row_count == Some(0) {
            return Err("benchmark fixture row count must be a positive integer".to_string());
        }

        Ok(Some(Self {
            report_path,
            test_home,
            run_id,
            scenario,
            fixture_path,
            fixture_sha256,
            fixture_row_count,
            duration_ms: None,
            gateway_upstream_url: None,
        }))
    }

    fn from_env() -> Result<Option<Self>, String> {
        let mut config = Self::from_values(
            std::env::var_os(REPORT_ENV),
            std::env::var_os(TEST_HOME_ENV),
            std::env::var_os(RUN_ID_ENV),
            std::env::var_os(SCENARIO_ENV),
            std::env::var_os(FIXTURE_ENV),
            std::env::var_os(FIXTURE_SHA256_ENV),
            std::env::var_os(FIXTURE_ROW_COUNT_ENV),
        )?;
        if let Some(config) = config.as_mut() {
            validate_real_home(&config.test_home, std::env::var_os(REAL_HOME_ENV))?;
            config.duration_ms = std::env::var(DURATION_MS_ENV)
                .ok()
                .map(|value| {
                    let duration = value.parse::<u64>().map_err(|_| {
                        format!("{DURATION_MS_ENV} must be an integer number of milliseconds")
                    })?;
                    if !(1..=1_800_000).contains(&duration) {
                        return Err(format!("{DURATION_MS_ENV} must be between 1 and 1800000"));
                    }
                    Ok(duration)
                })
                .transpose()?;
            let upstream = std::env::var(GATEWAY_UPSTREAM_ENV).ok();
            match (config.scenario, upstream) {
                (BenchmarkScenario::GatewayLoad, Some(value)) => {
                    config.gateway_upstream_url = Some(parse_gateway_upstream_url(&value)?);
                }
                (BenchmarkScenario::GatewayLoad, None) => {
                    return Err(format!(
                        "{GATEWAY_UPSTREAM_ENV} is required for gateway-load"
                    ));
                }
                (_, Some(_)) => {
                    return Err(format!(
                        "{GATEWAY_UPSTREAM_ENV} is only allowed for gateway-load"
                    ));
                }
                (_, None) => {}
            }
        }
        Ok(config)
    }
}

pub(crate) fn parse_gateway_upstream_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| "benchmark gateway upstream must be a valid URL".to_string())?;
    if url.scheme() != "http" {
        return Err("benchmark gateway upstream must use plain HTTP".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("benchmark gateway upstream must not contain credentials".to_string());
    }
    if url.port().is_none() {
        return Err("benchmark gateway upstream must use an explicit port".to_string());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "benchmark gateway upstream must be an origin without path/query/fragment".to_string(),
        );
    }
    let loopback = url.host_str().is_some_and(|host| {
        let host = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if !loopback {
        return Err(
            "benchmark gateway upstream must resolve syntactically to loopback".to_string(),
        );
    }
    Ok(url)
}

fn require_absolute_clean_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} path must be absolute"));
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(format!("{label} path must not contain parent traversal"));
    }
    Ok(())
}

pub(crate) fn validate_real_home(
    test_home: &Path,
    real_home: Option<OsString>,
) -> Result<(), String> {
    let real_home = PathBuf::from(
        real_home.ok_or_else(|| format!("{REAL_HOME_ENV} is required in benchmark mode"))?,
    );
    require_absolute_clean_path(&real_home, "benchmark real user home")?;
    let real_home = real_home
        .canonicalize()
        .map_err(|err| format!("canonicalize benchmark real user home: {err}"))?;
    if real_home == test_home {
        return Err("benchmark test home must not be the real user home".to_string());
    }
    Ok(())
}

pub(crate) fn configure_tauri_context(
    context: &mut tauri::Context<tauri::Wry>,
    test_home: Option<&Path>,
) {
    let Some(test_home) = test_home else {
        return;
    };
    let webview_data = test_home.join(".aio-benchmark").join("webview");
    for window in &mut context.config_mut().app.windows {
        window.width = 1500.0;
        window.height = 900.0;
        window.maximized = false;
        window.fullscreen = false;
        window.data_directory = Some(webview_data.clone());
    }
}

fn os_string_to_utf8(value: OsString, label: &str) -> Result<String, String> {
    value
        .into_string()
        .map_err(|_| format!("{label} must be valid UTF-8"))
}

fn is_safe_token(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug)]
struct WriterState {
    writer: BufWriter<File>,
    next_seq: u64,
}

#[derive(Debug)]
pub(crate) struct BenchmarkReporter {
    config: BenchmarkConfig,
    started: Instant,
    state: Mutex<WriterState>,
    native_idle_completion_claimed: AtomicBool,
    scenario_completion_state: AtomicU8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MilestoneRecord<'a> {
    schema_version: u32,
    run_id: &'a str,
    scenario: &'a str,
    seq: u64,
    milestone: &'a str,
    elapsed_ms: f64,
    wall_clock_unix_ms: u128,
    data: &'a Value,
}

impl BenchmarkReporter {
    pub(crate) fn create(config: BenchmarkConfig) -> Result<Self, String> {
        let parent = config
            .report_path
            .parent()
            .ok_or_else(|| "benchmark report must have a parent directory".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("create benchmark report directory: {err}"))?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|err| format!("canonicalize benchmark report directory: {err}"))?;
        if !canonical_parent.starts_with(&config.test_home) {
            return Err("benchmark report directory escaped the isolated test home".to_string());
        }

        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&config.report_path)
            .map_err(|err| format!("create benchmark report: {err}"))?;
        Ok(Self {
            config,
            started: Instant::now(),
            state: Mutex::new(WriterState {
                writer: BufWriter::new(file),
                next_seq: 1,
            }),
            native_idle_completion_claimed: AtomicBool::new(false),
            scenario_completion_state: AtomicU8::new(SCENARIO_COMPLETION_PENDING),
        })
    }

    pub(crate) fn config(&self) -> &BenchmarkConfig {
        &self.config
    }

    pub(crate) fn record(&self, milestone: &str, data: Value) -> Result<(), String> {
        if !is_safe_token(milestone, 64) {
            return Err("benchmark milestone must be a 1-64 character ASCII token".to_string());
        }
        let data_bytes = serde_json::to_vec(&data)
            .map_err(|err| format!("serialize benchmark milestone data: {err}"))?;
        if data_bytes.len() > MAX_REPORT_DATA_BYTES {
            return Err(format!(
                "benchmark milestone data exceeds {MAX_REPORT_DATA_BYTES} bytes"
            ));
        }

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let seq = state.next_seq;
        let row = MilestoneRecord {
            schema_version: BENCHMARK_SCHEMA_VERSION,
            run_id: &self.config.run_id,
            scenario: self.config.scenario.as_str(),
            seq,
            milestone,
            elapsed_ms: self.started.elapsed().as_secs_f64() * 1_000.0,
            wall_clock_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            data: &data,
        };
        serde_json::to_writer(&mut state.writer, &row)
            .map_err(|err| format!("write benchmark milestone: {err}"))?;
        state
            .writer
            .write_all(b"\n")
            .and_then(|_| state.writer.flush())
            .map_err(|err| format!("flush benchmark milestone: {err}"))?;
        state.next_seq = seq.saturating_add(1);
        Ok(())
    }

    pub(crate) fn claim_native_idle_completion(&self) -> Option<Duration> {
        let duration = native_idle_completion_delay(self.config.scenario, self.config.duration_ms)?;
        self.native_idle_completion_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        Some(duration)
    }

    pub(crate) fn complete_scenario(&self, data: Value) -> Result<bool, String> {
        if self
            .scenario_completion_state
            .compare_exchange(
                SCENARIO_COMPLETION_PENDING,
                SCENARIO_COMPLETION_WRITING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return Ok(false);
        }

        match self.record("scenario_completed", data) {
            Ok(()) => {
                self.scenario_completion_state
                    .store(SCENARIO_COMPLETION_DONE, Ordering::Release);
                Ok(true)
            }
            Err(err) => {
                self.scenario_completion_state
                    .store(SCENARIO_COMPLETION_FAILED, Ordering::Release);
                Err(err)
            }
        }
    }
}

pub fn initialize_from_env() -> Result<bool, String> {
    if let Some(existing) = REPORTER.get() {
        return Ok(existing.is_some());
    }

    let reporter = match BenchmarkConfig::from_env()? {
        Some(config) => Some(BenchmarkReporter::create(config)?),
        None => None,
    };
    let enabled = reporter.is_some();
    REPORTER
        .set(reporter)
        .map_err(|_| "benchmark reporter was initialized concurrently".to_string())?;
    Ok(enabled)
}

pub(crate) fn is_enabled() -> bool {
    REPORTER.get().is_some_and(Option::is_some)
}

pub(crate) fn test_home() -> Option<&'static Path> {
    REPORTER
        .get()
        .and_then(Option::as_ref)
        .map(|reporter| reporter.config().test_home.as_path())
}

pub(crate) fn milestone(milestone: &str, data: Value) {
    let Some(reporter) = REPORTER.get().and_then(Option::as_ref) else {
        return;
    };
    if let Err(err) = reporter.record(milestone, data) {
        tracing::warn!(milestone, "benchmark milestone write failed: {err}");
    }
}

pub(crate) fn schedule_native_idle_completion(app: tauri::AppHandle) {
    let Some(reporter) = REPORTER.get().and_then(Option::as_ref) else {
        return;
    };
    let Some(duration) = reporter.claim_native_idle_completion() else {
        return;
    };
    let started = Instant::now();
    let deadline = started + duration;

    crate::task_runtime::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        let data = serde_json::json!({
            "completionSource": "native_idle_timer",
            "scheduledDurationMs": duration.as_millis() as u64,
            "actualDurationMs": started.elapsed().as_secs_f64() * 1_000.0,
        });
        match complete_scenario_and_exit(&app, data) {
            Ok(_) => {}
            Err(err) => tracing::warn!("benchmark native idle completion failed: {err}"),
        }
    });
}

pub(crate) fn record_window_visibility(app: &tauri::AppHandle, start_minimized: bool) {
    if !is_enabled() {
        return;
    }
    use tauri::Manager;
    let window = app.get_webview_window("main");
    let visible = window
        .as_ref()
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(!start_minimized);
    let data = window
        .as_ref()
        .and_then(|window| {
            let size = window.inner_size().ok()?;
            let scale_factor = window.scale_factor().ok()?;
            Some(window_measurement(
                size.width,
                size.height,
                scale_factor,
                start_minimized,
            ))
        })
        .unwrap_or_else(|| serde_json::json!({ "startMinimized": start_minimized }));
    milestone(
        if visible {
            "window_visible"
        } else {
            "window_hidden"
        },
        data,
    );
}

pub(crate) fn window_measurement(
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
    start_minimized: bool,
) -> Value {
    serde_json::json!({
        "startMinimized": start_minimized,
        "physicalWidth": physical_width,
        "physicalHeight": physical_height,
        "logicalWidth": f64::from(physical_width) / scale_factor,
        "logicalHeight": f64::from(physical_height) / scale_factor,
        "scaleFactor": scale_factor,
    })
}

pub(crate) fn process_entry_data(pid: u32) -> Value {
    serde_json::json!({
        "pid": pid,
        "appVersion": env!("CARGO_PKG_VERSION"),
    })
}

pub(crate) async fn record_gateway_ready(status: &crate::gateway::GatewayStatus) {
    if !is_enabled() {
        return;
    }
    let Some(base_url) = status.base_url.as_deref() else {
        milestone(
            "gateway_probe_failed",
            serde_json::json!({ "reason": "missing_base_url" }),
        );
        return;
    };
    let Ok(url) = reqwest::Url::parse(base_url).and_then(|url| url.join("health")) else {
        milestone(
            "gateway_probe_failed",
            serde_json::json!({ "reason": "invalid_base_url" }),
        );
        return;
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            milestone(
                "gateway_probe_failed",
                serde_json::json!({ "reason": "client_build" }),
            );
            return;
        }
    };
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if client
            .get(url.clone())
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            milestone("gateway_ready", serde_json::json!({ "port": status.port }));
            return;
        }
        if Instant::now() >= deadline {
            milestone(
                "gateway_probe_failed",
                serde_json::json!({ "reason": "timeout" }),
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

fn current_config() -> Result<&'static BenchmarkConfig, String> {
    REPORTER
        .get()
        .and_then(Option::as_ref)
        .map(BenchmarkReporter::config)
        .ok_or_else(|| "benchmark mode is not enabled".to_string())
}

pub(crate) fn load_request_log_fixture(
    config: &BenchmarkConfig,
) -> Result<Vec<crate::request_logs::RequestLogSummary>, String> {
    if config.scenario != BenchmarkScenario::Logs10k {
        return Err("request log fixture is only available in the logs-10k scenario".to_string());
    }
    let path = config
        .fixture_path
        .as_ref()
        .ok_or_else(|| format!("{FIXTURE_ENV} is required for logs-10k"))?;
    let expected_hash = config
        .fixture_sha256
        .as_deref()
        .ok_or_else(|| format!("{FIXTURE_SHA256_ENV} is required for logs-10k"))?;
    let expected_rows = config
        .fixture_row_count
        .ok_or_else(|| format!("{FIXTURE_ROW_COUNT_ENV} is required for logs-10k"))?;
    let metadata =
        fs::metadata(path).map_err(|err| format!("read benchmark fixture metadata: {err}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FIXTURE_BYTES {
        return Err(format!(
            "benchmark fixture must be a regular file no larger than {MAX_FIXTURE_BYTES} bytes"
        ));
    }

    let file = File::open(path).map_err(|err| format!("open benchmark fixture: {err}"))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut line = Vec::new();
    let mut rows = Vec::with_capacity(expected_rows);
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|err| format!("read benchmark fixture: {err}"))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_FIXTURE_LINE_BYTES {
            return Err("benchmark fixture contains an oversized JSONL row".to_string());
        }
        digest.update(&line);
        while line
            .last()
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
        {
            line.pop();
        }
        if line.is_empty() {
            return Err("benchmark fixture contains an empty JSONL row".to_string());
        }
        let value: crate::request_logs::RequestLogSummary = serde_json::from_slice(&line)
            .map_err(|err| format!("parse benchmark fixture RequestLogSummary row: {err}"))?;
        rows.push(value);
        if rows.len() > expected_rows {
            return Err(format!(
                "benchmark fixture row count mismatch: expected {expected_rows}, got more"
            ));
        }
    }

    let actual_hash = format!("{:x}", digest.finalize());
    if actual_hash != expected_hash {
        return Err(format!(
            "benchmark fixture SHA-256 mismatch: expected {expected_hash}, got {actual_hash}"
        ));
    }
    if rows.len() != expected_rows {
        return Err(format!(
            "benchmark fixture row count mismatch: expected {expected_rows}, got {}",
            rows.len()
        ));
    }
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiMilestone {
    milestone: String,
    #[serde(default)]
    data: Value,
}

fn is_allowed_ui_milestone(value: &str) -> bool {
    matches!(
        value,
        "first_interactive"
            | "logs_dataset_ready"
            | "logs_filter_painted"
            | "logs_select_painted"
            | "gateway_load_ready"
            | "gateway_load_completed"
            | "scenario_failed"
    )
}

#[tauri::command]
fn record(payload: UiMilestone) -> Result<(), String> {
    if !is_allowed_ui_milestone(&payload.milestone) {
        return Err("unsupported benchmark UI milestone".to_string());
    }
    let reporter = REPORTER
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "benchmark mode is not enabled".to_string())?;
    reporter.record(&payload.milestone, payload.data)
}

#[tauri::command]
async fn request_logs() -> Result<Vec<crate::request_logs::RequestLogSummary>, String> {
    let config = current_config()?.clone();
    crate::task_runtime::spawn_blocking(move || load_request_log_fixture(&config))
        .await
        .map_err(|err| format!("join benchmark fixture loader: {err}"))?
}

const GATEWAY_NON_STREAM_REQUESTS: usize = 24;
const GATEWAY_NON_STREAM_CONCURRENCY: usize = 4;
const GATEWAY_STREAM_REQUESTS: usize = 4;
const GATEWAY_STREAM_DATA_EVENTS: usize = 5;
const GATEWAY_STREAM_DONE_EVENTS: usize = 1;
const GATEWAY_STREAM_EVENT_INTERVAL_MS: u64 = 20;

#[derive(Debug, Default)]
pub(crate) struct SseEventParser {
    pending: Vec<u8>,
}

impl SseEventParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((event_end, boundary_end)) = sse_event_boundary(&self.pending) {
            let event = parse_sse_data_event(&self.pending[..event_end])?;
            self.pending.drain(..boundary_end);
            if let Some(event) = event {
                events.push(event);
            }
        }
        Ok(events)
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err("gateway stream ended with an incomplete SSE event".to_string())
        }
    }
}

fn sse_event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut line_start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let content_end = if index > line_start && bytes[index - 1] == b'\r' {
            index - 1
        } else {
            index
        };
        if content_end == line_start {
            return Some((line_start, index + 1));
        }
        line_start = index + 1;
    }
    None
}

fn parse_sse_data_event(bytes: &[u8]) -> Result<Option<String>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|err| format!("gateway stream SSE event is not UTF-8: {err}"))?;
    let data = text
        .lines()
        .filter_map(|line| {
            line.strip_prefix("data:")
                .map(|value| value.strip_prefix(' ').unwrap_or(value))
        })
        .collect::<Vec<_>>();
    Ok((!data.is_empty()).then(|| data.join("\n")))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLoadResult {
    condition: String,
    non_stream_requests: usize,
    non_stream_concurrency: usize,
    non_stream_elapsed_ms: f64,
    throughput_requests_per_second: f64,
    non_stream_ttfb_ms: Vec<f64>,
    stream_requests: usize,
    stream_data_events: usize,
    stream_done_events: usize,
    stream_event_interval_ms: u64,
    stream_ttfb_ms: Vec<f64>,
    stream_inter_event_ms: Vec<f64>,
    observed_stream_transport_chunks: Vec<usize>,
}

pub(super) fn benchmark_provider_input(
    name: String,
    upstream: String,
) -> crate::providers::ProviderUpsertParams {
    crate::providers::ProviderUpsertParams {
        provider_id: None,
        cli_key: "codex".to_string(),
        name,
        base_urls: vec![upstream],
        base_url_mode: crate::providers::ProviderBaseUrlMode::Order,
        auth_mode: Some(crate::providers::ProviderAuthMode::ApiKey),
        api_key: Some("sk-aio-benchmark-local-only".to_string()),
        enabled: true,
        cost_multiplier: 1.0,
        priority: Some(0),
        claude_models: None,
        limit_5h_usd: None,
        limit_daily_usd: None,
        daily_reset_mode: None,
        daily_reset_time: None,
        limit_weekly_usd: None,
        limit_monthly_usd: None,
        limit_total_usd: None,
        tags: Some(vec!["egui-baseline".to_string()]),
        note: Some("synthetic local benchmark provider".to_string()),
        source_provider_id: None,
        bridge_type: None,
        stream_idle_timeout_seconds: Some(60),
        extension_values: None,
    }
}

pub(super) fn upsert_benchmark_provider(
    db: &crate::db::Db,
    name: String,
    upstream: String,
) -> crate::shared::error::AppResult<crate::providers::ProviderSummary> {
    let provider = crate::providers::upsert(db, benchmark_provider_input(name, upstream))?;
    let mut route = crate::providers::default_route_list(db, "codex")?
        .into_iter()
        .map(|item| item.provider_id)
        .collect::<Vec<_>>();
    if !route.contains(&provider.id) {
        route.push(provider.id);
        crate::providers::default_route_set_order(db, "codex", route)?;
    }
    Ok(provider)
}

fn gateway_request_body(stream: bool) -> String {
    serde_json::json!({
        "model": "benchmark-model",
        "stream": stream,
        "messages": [{ "role": "user", "content": "fixed benchmark request" }],
    })
    .to_string()
}

async fn run_non_stream_gateway_load(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
) -> Result<(f64, Vec<f64>), String> {
    let started = Instant::now();
    let mut ttfb_ms = Vec::with_capacity(GATEWAY_NON_STREAM_REQUESTS);
    for batch_start in (0..GATEWAY_NON_STREAM_REQUESTS).step_by(GATEWAY_NON_STREAM_CONCURRENCY) {
        let batch_size = GATEWAY_NON_STREAM_CONCURRENCY
            .min(GATEWAY_NON_STREAM_REQUESTS.saturating_sub(batch_start));
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..batch_size {
            let client = client.clone();
            let endpoint = endpoint.clone();
            let body = gateway_request_body(false);
            tasks.spawn(async move {
                let request_started = Instant::now();
                let response = client
                    .post(endpoint)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(body)
                    .send()
                    .await
                    .map_err(|err| format!("gateway non-stream request: {err}"))?;
                let ttfb = request_started.elapsed().as_secs_f64() * 1_000.0;
                if !response.status().is_success() {
                    return Err(format!(
                        "gateway non-stream response status: {}",
                        response.status()
                    ));
                }
                let body = response
                    .bytes()
                    .await
                    .map_err(|err| format!("read gateway non-stream response: {err}"))?;
                if !body
                    .windows(b"chatcmpl-egui-baseline".len())
                    .any(|window| window == b"chatcmpl-egui-baseline")
                {
                    return Err("gateway non-stream response did not match fixed stub".to_string());
                }
                Ok::<f64, String>(ttfb)
            });
        }
        while let Some(result) = tasks.join_next().await {
            ttfb_ms.push(result.map_err(|err| format!("join gateway non-stream request: {err}"))??);
        }
    }
    Ok((started.elapsed().as_secs_f64() * 1_000.0, ttfb_ms))
}

async fn run_stream_gateway_load(
    client: &reqwest::Client,
    endpoint: &reqwest::Url,
) -> Result<(Vec<f64>, Vec<f64>, Vec<usize>), String> {
    let mut ttfb_ms = Vec::with_capacity(GATEWAY_STREAM_REQUESTS);
    let mut inter_event_ms =
        Vec::with_capacity(GATEWAY_STREAM_REQUESTS * GATEWAY_STREAM_DATA_EVENTS);
    let mut observed_transport_chunks = Vec::with_capacity(GATEWAY_STREAM_REQUESTS);
    for _ in 0..GATEWAY_STREAM_REQUESTS {
        let request_started = Instant::now();
        let mut response = client
            .post(endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(gateway_request_body(true))
            .send()
            .await
            .map_err(|err| format!("gateway stream request: {err}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "gateway stream response status: {}",
                response.status()
            ));
        }
        let mut parser = SseEventParser::default();
        let mut previous_event_at = None;
        let mut data_events = 0_usize;
        let mut saw_done = false;
        let mut transport_chunks = 0_usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| format!("read gateway stream response: {err}"))?
        {
            transport_chunks = transport_chunks.saturating_add(1);
            let event_observed_at = Instant::now();
            for event in parser.push(&chunk)? {
                if saw_done {
                    return Err("gateway stream received an SSE event after [DONE]".to_string());
                }
                if let Some(previous) = previous_event_at {
                    inter_event_ms
                        .push(event_observed_at.duration_since(previous).as_secs_f64() * 1_000.0);
                } else {
                    ttfb_ms.push(
                        event_observed_at
                            .duration_since(request_started)
                            .as_secs_f64()
                            * 1_000.0,
                    );
                }
                previous_event_at = Some(event_observed_at);

                if event == "[DONE]" {
                    saw_done = true;
                } else {
                    serde_json::from_str::<Value>(&event)
                        .map_err(|err| format!("gateway stream data event is not JSON: {err}"))?;
                    data_events = data_events.saturating_add(1);
                }
            }
        }
        parser.finish()?;
        if data_events != GATEWAY_STREAM_DATA_EVENTS {
            return Err(format!(
                "gateway stream returned {data_events} JSON data events; expected {GATEWAY_STREAM_DATA_EVENTS}"
            ));
        }
        if !saw_done {
            return Err("gateway stream did not reach the fixed [DONE] event".to_string());
        }
        observed_transport_chunks.push(transport_chunks);
    }
    Ok((ttfb_ms, inter_event_ms, observed_transport_chunks))
}

#[tauri::command]
async fn run_gateway_load(app: tauri::AppHandle, condition: String) -> Result<Value, String> {
    if !matches!(condition.as_str(), "idle" | "active") {
        return Err("gateway benchmark condition must be idle or active".to_string());
    }
    let config = current_config()?.clone();
    if config.scenario != BenchmarkScenario::GatewayLoad {
        return Err("gateway load is only available in the gateway-load scenario".to_string());
    }
    let upstream = config
        .gateway_upstream_url
        .clone()
        .ok_or_else(|| format!("{GATEWAY_UPSTREAM_ENV} is required for gateway-load"))?;

    use tauri::Manager;
    let state = app.state::<crate::app_state::ManagedCoreRuntimeState>();
    let db = crate::app_state::ensure_db_ready(app.clone(), &state)
        .await
        .map_err(|err| format!("benchmark database initialization: {err}"))?;
    let provider_name = format!("egui-baseline-{}-{condition}", config.run_id);
    let provider = crate::blocking::run("benchmark_gateway_provider_upsert", move || {
        upsert_benchmark_provider(&db, provider_name, upstream.to_string())
    })
    .await
    .map_err(|err| format!("create benchmark provider: {err}"))?;

    let gateway = crate::gateway_runtime_access::app_gateway_status(&app);
    let base_url = gateway
        .base_url
        .as_deref()
        .ok_or_else(|| "benchmark gateway is not running".to_string())?;
    let endpoint = reqwest::Url::parse(&format!(
        "{}/codex/_aio/provider/{}/v1/chat/completions",
        base_url.trim_end_matches('/'),
        provider.id
    ))
    .map_err(|err| format!("build benchmark gateway endpoint: {err}"))?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| format!("build benchmark gateway client: {err}"))?;

    milestone(
        &format!("gateway_load_{condition}_started"),
        serde_json::json!({ "providerId": provider.id }),
    );
    let (non_stream_elapsed_ms, non_stream_ttfb_ms) =
        run_non_stream_gateway_load(&client, &endpoint).await?;
    let throughput_requests_per_second =
        GATEWAY_NON_STREAM_REQUESTS as f64 / (non_stream_elapsed_ms / 1_000.0);
    let (stream_ttfb_ms, stream_inter_event_ms, observed_stream_transport_chunks) =
        run_stream_gateway_load(&client, &endpoint).await?;
    let result = GatewayLoadResult {
        condition: condition.clone(),
        non_stream_requests: GATEWAY_NON_STREAM_REQUESTS,
        non_stream_concurrency: GATEWAY_NON_STREAM_CONCURRENCY,
        non_stream_elapsed_ms,
        throughput_requests_per_second,
        non_stream_ttfb_ms,
        stream_requests: GATEWAY_STREAM_REQUESTS,
        stream_data_events: GATEWAY_STREAM_DATA_EVENTS,
        stream_done_events: GATEWAY_STREAM_DONE_EVENTS,
        stream_event_interval_ms: GATEWAY_STREAM_EVENT_INTERVAL_MS,
        stream_ttfb_ms,
        stream_inter_event_ms,
        observed_stream_transport_chunks,
    };
    let value = serde_json::to_value(&result)
        .map_err(|err| format!("serialize gateway benchmark result: {err}"))?;
    let reporter = REPORTER
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "benchmark mode is not enabled".to_string())?;
    reporter.record(
        &format!("gateway_load_{condition}_completed"),
        value.clone(),
    )?;
    Ok(value)
}

#[tauri::command]
fn finish(app: tauri::AppHandle) -> Result<(), String> {
    complete_scenario_and_exit(&app, Value::Object(Default::default())).map(|_| ())
}

fn complete_scenario_and_exit<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    data: Value,
) -> Result<bool, String> {
    let reporter = REPORTER
        .get()
        .and_then(Option::as_ref)
        .ok_or_else(|| "benchmark mode is not enabled".to_string())?;
    let completed = reporter.complete_scenario(data)?;
    if completed {
        app.exit(0);
    }
    Ok(completed)
}

pub(crate) fn plugin() -> Option<tauri::plugin::TauriPlugin<tauri::Wry>> {
    let config = REPORTER.get()?.as_ref()?.config();
    let frontend_config = serde_json::json!({
        "schemaVersion": BENCHMARK_SCHEMA_VERSION,
        "runId": config.run_id,
        "scenario": config.scenario.as_str(),
        "durationMs": config.duration_ms,
    });
    let frontend_config = serde_json::to_string(&frontend_config).ok()?;
    let init_script = format!(
        "Object.defineProperty(window, '__AIO_BENCHMARK__', {{ value: Object.freeze({frontend_config}), configurable: false, enumerable: false, writable: false }});"
    );
    Some(
        tauri::plugin::Builder::new("benchmark")
            .js_init_script(init_script)
            .invoke_handler(tauri::generate_handler![
                record,
                request_logs,
                run_gateway_load,
                finish
            ])
            .build(),
    )
}
