use super::benchmark::{
    configure_tauri_context, load_request_log_fixture, native_idle_completion_delay,
    parse_gateway_upstream_url, process_entry_data, upsert_benchmark_provider, validate_real_home,
    window_measurement, BenchmarkConfig, BenchmarkReporter, BenchmarkScenario, IsolationMarker,
    SseEventParser, BENCHMARK_SCHEMA_VERSION,
};
use super::BENCHMARK_INITIALIZATION_EXIT_CODE;
use serde_json::Value;
use sha2::Digest;
use std::ffi::OsString;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

fn write_marker(home: &std::path::Path, run_id: &str) {
    fs::create_dir_all(home).expect("create benchmark home");
    fs::write(
        home.join(".aio-benchmark-home.json"),
        serde_json::to_vec(&IsolationMarker {
            schema_version: BENCHMARK_SCHEMA_VERSION,
            run_id: run_id.to_string(),
        })
        .expect("serialize marker"),
    )
    .expect("write marker");
}

fn enabled_config(temp: &tempfile::TempDir, scenario: &str) -> BenchmarkConfig {
    let home = temp.path().join("home");
    write_marker(&home, "run-001");
    let report = home.join("reports").join("milestones.jsonl");
    BenchmarkConfig::from_values(
        Some(report.into_os_string()),
        Some(home.into_os_string()),
        Some(OsString::from("run-001")),
        Some(OsString::from(scenario)),
        None,
        None,
        None,
    )
    .expect("valid benchmark config")
    .expect("benchmark enabled")
}

#[test]
fn benchmark_config_is_disabled_when_report_is_absent() {
    let config = BenchmarkConfig::from_values(
        None,
        Some(OsString::from("ignored")),
        Some(OsString::from("ignored")),
        Some(OsString::from("ignored")),
        None,
        None,
        None,
    )
    .expect("missing report disables benchmark mode");

    assert!(config.is_none());
}

#[test]
fn benchmark_initialization_is_fail_closed_and_reports_the_compiled_version() {
    assert_eq!(BENCHMARK_INITIALIZATION_EXIT_CODE, 78);
    assert_eq!(
        process_entry_data(42),
        serde_json::json!({
            "pid": 42,
            "appVersion": env!("CARGO_PKG_VERSION"),
        })
    );

    let main_source = fs::read_to_string("src/main.rs").expect("read main source");
    assert!(main_source.contains("if let Err(err) = aio_coding_hub_lib::initialize_benchmark()"));
    assert!(main_source.contains("std::process::exit("));
    assert!(main_source.contains("BENCHMARK_INITIALIZATION_EXIT_CODE"));
}

#[test]
fn benchmark_config_rejects_relative_or_unmarked_home() {
    let temp = tempfile::tempdir().expect("tempdir");
    let relative = BenchmarkConfig::from_values(
        Some(OsString::from("report.jsonl")),
        Some(temp.path().join("home").into_os_string()),
        Some(OsString::from("run-001")),
        Some(OsString::from("visible-idle")),
        None,
        None,
        None,
    )
    .expect_err("relative report must be rejected");
    assert!(relative.contains("absolute"));

    let home = temp.path().join("home");
    fs::create_dir_all(&home).expect("home");
    let unmarked = BenchmarkConfig::from_values(
        Some(home.join("report.jsonl").into_os_string()),
        Some(home.into_os_string()),
        Some(OsString::from("run-001")),
        Some(OsString::from("visible-idle")),
        None,
        None,
        None,
    )
    .expect_err("unmarked home must be rejected");
    assert!(unmarked.contains("marker"));
}

#[test]
fn benchmark_config_rejects_marker_or_scenario_mismatch() {
    let temp = tempfile::tempdir().expect("tempdir");
    let home = temp.path().join("home");
    write_marker(&home, "another-run");

    let mismatch = BenchmarkConfig::from_values(
        Some(home.join("report.jsonl").into_os_string()),
        Some(home.clone().into_os_string()),
        Some(OsString::from("run-001")),
        Some(OsString::from("visible-idle")),
        None,
        None,
        None,
    )
    .expect_err("marker mismatch must be rejected");
    assert!(mismatch.contains("runId"));

    write_marker(&home, "run-001");
    let unknown = BenchmarkConfig::from_values(
        Some(home.join("report.jsonl").into_os_string()),
        Some(home.into_os_string()),
        Some(OsString::from("run-001")),
        Some(OsString::from("unknown")),
        None,
        None,
        None,
    )
    .expect_err("unknown scenario must be rejected");
    assert!(unknown.contains("scenario"));
}

#[test]
fn benchmark_real_home_validation_uses_preserved_runner_value() {
    let temp = tempfile::tempdir().expect("tempdir");
    let real_home = temp.path().join("real-home");
    let isolated_home = temp.path().join("isolated-home");
    fs::create_dir_all(&real_home).expect("real home");
    fs::create_dir_all(&isolated_home).expect("isolated home");
    let real_home = real_home.canonicalize().expect("canonical real home");
    let isolated_home = isolated_home
        .canonicalize()
        .expect("canonical isolated home");

    assert!(
        validate_real_home(&real_home, Some(real_home.clone().into_os_string()))
            .expect_err("real home must be rejected")
            .contains("real user home")
    );
    validate_real_home(&isolated_home, Some(real_home.into_os_string()))
        .expect("isolated home is accepted");
    assert!(validate_real_home(&isolated_home, None)
        .expect_err("preserved real home is required")
        .contains("BENCHMARK_REAL_HOME"));
}

#[test]
fn benchmark_context_uses_fixed_isolated_window_without_affecting_normal_mode() {
    let mut normal_context = tauri::generate_context!();
    normal_context.config_mut().app.windows[0].width = 1234.0;
    normal_context.config_mut().app.windows[0].data_directory =
        Some(std::path::PathBuf::from("normal-webview-data"));
    configure_tauri_context(&mut normal_context, None);
    assert_eq!(normal_context.config().app.windows[0].width, 1234.0);
    assert_eq!(
        normal_context.config().app.windows[0].data_directory,
        Some(std::path::PathBuf::from("normal-webview-data"))
    );

    let temp = tempfile::tempdir().expect("tempdir");
    let benchmark_home = temp.path().canonicalize().expect("canonical home");
    let mut benchmark_context = tauri::generate_context!();
    configure_tauri_context(&mut benchmark_context, Some(&benchmark_home));
    let window = &benchmark_context.config().app.windows[0];
    assert_eq!((window.width, window.height), (1500.0, 900.0));
    assert!(!window.maximized);
    assert!(!window.fullscreen);
    assert!(!window.incognito);
    assert_eq!(
        window.data_directory.as_deref(),
        Some(
            benchmark_home
                .join(".aio-benchmark")
                .join("webview")
                .as_path()
        )
    );
}

#[test]
fn benchmark_window_measurement_reports_physical_logical_and_scale_values() {
    assert_eq!(
        window_measurement(2250, 1350, 1.5, false),
        serde_json::json!({
            "startMinimized": false,
            "physicalWidth": 2250,
            "physicalHeight": 1350,
            "logicalWidth": 1500.0,
            "logicalHeight": 900.0,
            "scaleFactor": 1.5,
        })
    );
}

#[test]
fn reporter_writes_ordered_jsonl_and_refuses_overwrite() {
    let temp = tempfile::tempdir().expect("tempdir");
    let config = enabled_config(&temp, "visible-idle");
    let report_path = config.report_path.clone();
    let reporter = Arc::new(BenchmarkReporter::create(config.clone()).expect("create reporter"));

    reporter
        .record("process_entry", serde_json::json!({"pid": 42}))
        .expect("first milestone");
    let mut workers = Vec::new();
    for worker in 0..4 {
        let reporter = reporter.clone();
        workers.push(std::thread::spawn(move || {
            reporter
                .record("sample", serde_json::json!({"worker": worker}))
                .expect("concurrent milestone");
        }));
    }
    for worker in workers {
        worker.join().expect("join worker");
    }
    drop(reporter);

    let rows = fs::read_to_string(&report_path)
        .expect("read report")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid JSONL row"))
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 5);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["schemaVersion"], BENCHMARK_SCHEMA_VERSION);
        assert_eq!(row["runId"], "run-001");
        assert_eq!(row["scenario"], "visible-idle");
        assert_eq!(row["seq"], (index + 1) as u64);
        assert!(row["elapsedMs"].as_f64().is_some());
        assert!(row["wallClockUnixMs"].as_u64().is_some());
    }

    let overwrite = BenchmarkReporter::create(config).expect_err("report is create-new only");
    assert!(overwrite.contains("create benchmark report"));
}

#[test]
fn native_idle_completion_selects_only_idle_scenarios_and_honors_duration_override() {
    assert_eq!(
        native_idle_completion_delay(BenchmarkScenario::VisibleIdle, None),
        Some(Duration::from_secs(60))
    );
    assert_eq!(
        native_idle_completion_delay(BenchmarkScenario::HiddenTray, None),
        Some(Duration::from_secs(600))
    );
    assert_eq!(
        native_idle_completion_delay(BenchmarkScenario::VisibleIdle, Some(37)),
        Some(Duration::from_millis(37))
    );

    for scenario in [
        BenchmarkScenario::StartupColdProcess,
        BenchmarkScenario::StartupWarmProcess,
        BenchmarkScenario::FirstInteractive,
        BenchmarkScenario::Logs10k,
        BenchmarkScenario::GatewayLoad,
    ] {
        assert_eq!(native_idle_completion_delay(scenario, Some(1)), None);
    }
}

#[test]
fn native_idle_task_and_scenario_completion_are_each_claimed_once() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut config = enabled_config(&temp, "visible-idle");
    config.duration_ms = Some(5);
    let report_path = config.report_path.clone();
    let reporter = BenchmarkReporter::create(config).expect("create reporter");

    assert_eq!(
        reporter.claim_native_idle_completion(),
        Some(Duration::from_millis(5))
    );
    assert_eq!(reporter.claim_native_idle_completion(), None);
    assert!(reporter
        .complete_scenario(serde_json::json!({ "completionSource": "native_idle_timer" }))
        .expect("first completion"));
    assert!(!reporter
        .complete_scenario(serde_json::json!({ "completionSource": "duplicate" }))
        .expect("duplicate completion is ignored"));
    drop(reporter);

    let rows = fs::read_to_string(report_path)
        .expect("read report")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid JSONL row"))
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["milestone"], "scenario_completed");
    assert_eq!(rows[0]["data"]["completionSource"], "native_idle_timer");
}

#[test]
fn request_log_fixture_requires_logs_scenario_hash_and_exact_row_count() {
    let temp = tempfile::tempdir().expect("tempdir");
    let fixture_path = temp.path().join("logs.jsonl");
    fs::write(&fixture_path, "{\"id\":1}\n").expect("fixture");
    let partial_hash = format!("{:x}", sha2::Sha256::digest(b"{\"id\":1}\n"));

    let mut config = enabled_config(&temp, "logs-10k");
    config.fixture_path = Some(fixture_path.clone());
    config.fixture_sha256 = Some(partial_hash);
    config.fixture_row_count = Some(1);
    let error =
        load_request_log_fixture(&config).expect_err("partial row must fail typed DTO parsing");
    assert!(error.contains("RequestLogSummary"));

    let valid_row = serde_json::json!({
        "id": 1,
        "trace_id": "fixture-trace",
        "cli_key": "codex",
        "session_id": null,
        "method": "POST",
        "path": "/v1/chat/completions",
        "excluded_from_stats": false,
        "special_settings_json": null,
        "requested_model": "benchmark-model",
        "status": 200,
        "error_code": null,
        "is_interrupted": false,
        "duration_ms": 10,
        "ttfb_ms": 2,
        "attempt_count": 1,
        "has_failover": false,
        "start_provider_id": 1,
        "start_provider_name": "Fixture Provider",
        "final_provider_id": 1,
        "final_provider_name": "Fixture Provider",
        "final_provider_source_id": null,
        "final_provider_source_name": null,
        "route": [],
        "session_reuse": false,
        "input_tokens": 1,
        "output_tokens": 1,
        "total_tokens": 2,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_creation_5m_input_tokens": 0,
        "cache_creation_1h_input_tokens": 0,
        "effective_input_tokens": 1,
        "cost_usd": 0.0,
        "provider_chain_json": "[1]",
        "error_details_json": null,
        "cost_multiplier": 1.0,
        "created_at_ms": 1_700_000_000_000_i64,
        "last_activity_ms": null,
        "activity_details_json": null,
        "created_at": 1_700_000_000_i64
    });
    let encoded = format!(
        "{}\n",
        serde_json::to_string(&valid_row).expect("encode typed fixture")
    );
    fs::write(&fixture_path, &encoded).expect("replace fixture");
    let typed_hash = format!("{:x}", sha2::Sha256::digest(encoded.as_bytes()));
    config.fixture_sha256 = Some(typed_hash.clone());
    let rows = load_request_log_fixture(&config).expect("validated typed fixture");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].trace_id, "fixture-trace");

    config.fixture_sha256 = Some("0".repeat(64));
    assert!(load_request_log_fixture(&config)
        .expect_err("hash drift")
        .contains("SHA-256"));

    config.fixture_sha256 = Some(typed_hash);
    config.fixture_row_count = Some(2);
    assert!(load_request_log_fixture(&config)
        .expect_err("row count drift")
        .contains("row count"));

    config.scenario = BenchmarkScenario::VisibleIdle;
    assert!(load_request_log_fixture(&config)
        .expect_err("wrong scenario")
        .contains("logs-10k"));
}

#[test]
fn committed_10k_fixture_deserializes_as_production_request_log_summaries() {
    let temp = tempfile::tempdir().expect("tempdir");
    let fixture_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("egui-migration")
        .join("request-logs");
    let metadata: Value = serde_json::from_slice(
        &fs::read(fixture_root.join("metadata.json")).expect("read request-log metadata"),
    )
    .expect("parse request-log metadata");
    let mut config = enabled_config(&temp, "logs-10k");
    config.fixture_path = Some(fixture_root.join("request-logs-10000.jsonl"));
    config.fixture_sha256 = Some(
        metadata["sha256"]
            .as_str()
            .expect("metadata sha256")
            .to_string(),
    );
    config.fixture_row_count =
        Some(metadata["rowCount"].as_u64().expect("metadata rowCount") as usize);

    let rows = load_request_log_fixture(&config).expect("load committed typed fixture");
    assert_eq!(rows.len(), 10_000);
    assert_eq!(rows.first().map(|row| row.id), Some(1));
    assert_eq!(rows.last().map(|row| row.id), Some(10_000));
}

#[test]
fn gateway_upstream_accepts_only_plain_loopback_http_origins() {
    for value in [
        "http://127.0.0.1:43123",
        "http://[::1]:43123",
        "http://localhost:43123",
    ] {
        assert_eq!(
            parse_gateway_upstream_url(value)
                .expect("loopback benchmark upstream")
                .as_str(),
            format!("{value}/")
        );
    }

    for value in [
        "https://127.0.0.1:43123",
        "http://192.0.2.1:43123",
        "http://user@127.0.0.1:43123",
        "http://127.0.0.1:43123/path",
        "http://127.0.0.1",
    ] {
        assert!(
            parse_gateway_upstream_url(value).is_err(),
            "unexpected accepted upstream: {value}"
        );
    }
}

#[test]
fn gateway_benchmark_provider_respects_provider_persistence_contract() {
    let temp = tempfile::tempdir().expect("tempdir");
    let db = crate::db::init_for_tests(&temp.path().join("gateway-provider.db"))
        .expect("initialize provider database");

    let provider = upsert_benchmark_provider(
        &db,
        "egui-baseline-contract-idle".to_string(),
        "http://127.0.0.1:43123/".to_string(),
    )
    .expect("benchmark provider must satisfy production validation");

    assert_eq!(provider.stream_idle_timeout_seconds, Some(60));
    let selection = crate::providers::list_enabled_for_gateway_using_active_mode(&db, "codex")
        .expect("select benchmark provider for gateway");
    assert_eq!(
        selection
            .providers
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>(),
        vec![provider.id]
    );
}

#[test]
fn sse_event_parser_emits_two_events_from_one_transport_chunk() {
    let mut parser = SseEventParser::default();

    let events = parser
        .push(b"data: {\"index\":0}\n\ndata: {\"index\":1}\n\n")
        .expect("parse merged transport chunk");

    assert_eq!(events, ["{\"index\":0}", "{\"index\":1}"]);
    parser.finish().expect("complete event stream");
}

#[test]
fn sse_event_parser_waits_for_an_event_split_across_transport_chunks() {
    let mut parser = SseEventParser::default();

    assert!(parser
        .push(b"data: {\"index\"")
        .expect("parse first transport chunk")
        .is_empty());
    assert!(parser
        .push(b":2}\n")
        .expect("parse second transport chunk")
        .is_empty());
    assert_eq!(
        parser
            .push(b"\n")
            .expect("parse completing transport chunk"),
        ["{\"index\":2}"]
    );
    parser.finish().expect("complete event stream");
}

#[test]
fn sse_event_parser_accepts_lf_and_crlf_event_boundaries() {
    let mut parser = SseEventParser::default();

    let events = parser
        .push(b"data: {\"lineEnding\":\"lf\"}\n\ndata: {\"lineEnding\":\"crlf\"}\r\n\r\n")
        .expect("parse mixed line endings");

    assert_eq!(
        events,
        ["{\"lineEnding\":\"lf\"}", "{\"lineEnding\":\"crlf\"}"]
    );
    parser.finish().expect("complete event stream");
}

#[test]
fn sse_event_parser_preserves_the_done_event() {
    let mut parser = SseEventParser::default();

    let events = parser
        .push(b"data: [DONE]\r\n\r\n")
        .expect("parse done event");

    assert_eq!(events, ["[DONE]"]);
    parser.finish().expect("complete event stream");
}

#[test]
fn startup_and_shutdown_milestone_call_sites_are_present() {
    let expectations = [
        ("src/main.rs", "initialize_benchmark"),
        ("src/app/plugin_registry.rs", "benchmark::plugin"),
        ("src/app/bootstrap.rs", "tauri_setup_started"),
        ("src/app/bootstrap.rs", "tauri_setup_completed"),
        ("src/app/startup_tasks.rs", "startup_run_started"),
        ("src/app/startup_tasks.rs", "db_ready"),
        ("src/app/startup_tasks.rs", "settings_ready"),
        ("src/app/startup_tasks.rs", "gateway_bound"),
        ("src/app/startup_tasks.rs", "gateway_ready"),
        ("src/app/startup_tasks.rs", "startup_ready"),
        (
            "src/app/startup_tasks.rs",
            "schedule_native_idle_completion",
        ),
        ("src/app/cleanup.rs", "shutdown_started"),
        ("src/app/cleanup.rs", "shutdown_completed"),
        (
            "src/app/plugin_registry.rs",
            "desktop_plugin_policy(crate::benchmark::is_enabled())",
        ),
    ];
    for (path, needle) in expectations {
        let source = fs::read_to_string(path).unwrap_or_else(|err| panic!("read {path}: {err}"));
        assert!(source.contains(needle), "missing {needle} in {path}");
    }

    let startup_source =
        fs::read_to_string("src/app/startup_tasks.rs").expect("read startup tasks");
    let ready = startup_source
        .find("\"startup_ready\"")
        .expect("startup ready");
    let schedule = startup_source
        .find("schedule_native_idle_completion")
        .expect("native idle schedule");
    assert!(
        ready < schedule,
        "native idle timer must start after startup_ready"
    );

    let bootstrap_source = fs::read_to_string("src/app/bootstrap.rs").expect("read app bootstrap");
    let setup_completed = bootstrap_source
        .find("\"tauri_setup_completed\"")
        .expect("setup completed milestone");
    let startup_spawn = bootstrap_source
        .find("startup_tasks::spawn")
        .expect("startup task spawn");
    assert!(
        setup_completed < startup_spawn,
        "tauri setup must complete before the startup run is scheduled"
    );
}

#[tauri::command]
fn record() -> &'static str {
    "recorded"
}

fn benchmark_acl_request() -> tauri::webview::InvokeRequest {
    tauri::webview::InvokeRequest {
        cmd: "plugin:benchmark|record".into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "http://tauri.localhost".parse().expect("local Tauri URL"),
        body: tauri::ipc::InvokeBody::default(),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

#[test]
fn benchmark_plugin_acl_allows_only_the_main_window() {
    let context: tauri::Context<tauri::test::MockRuntime> = tauri::generate_context!();
    let plugin = tauri::plugin::Builder::<tauri::test::MockRuntime>::new("benchmark")
        .invoke_handler(tauri::generate_handler![record])
        .build();
    let app = tauri::test::mock_builder()
        .plugin(plugin)
        .build(context)
        .expect("build mock app with production ACL");

    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build main webview");
    let main_response = tauri::test::get_ipc_response(&main, benchmark_acl_request())
        .expect("main capability allows benchmark command")
        .deserialize::<String>()
        .expect("deserialize benchmark response");
    assert_eq!(main_response, "recorded");

    let untrusted = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .expect("build untrusted webview");
    let rejection = tauri::test::get_ipc_response(&untrusted, benchmark_acl_request())
        .expect_err("benchmark command must be rejected outside main capability");
    assert!(
        rejection
            .as_str()
            .is_some_and(|message| message.contains("not allowed")),
        "unexpected ACL rejection: {rejection}"
    );
}
