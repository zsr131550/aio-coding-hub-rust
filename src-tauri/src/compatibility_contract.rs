//! Usage: Export the stable Tauri/React compatibility surface for migration checks.

use serde_json::{json, Value};
use std::path::{Component, Path};

const EGUI_FIXTURE_ROOT_REPO_PATH: &str = "src-tauri/tests/fixtures/egui-migration";
const EGUI_FIXTURE_MANIFEST_REPO_PATH: &str =
    "src-tauri/tests/fixtures/egui-migration/manifest.json";

fn compatibility_fixture_artifact_paths() -> Result<Vec<String>, String> {
    let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("egui-migration")
        .join("manifest.json");
    let manifest_bytes = std::fs::read(&manifest_path).map_err(|error| {
        format!(
            "failed to read egui fixture manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        format!(
            "failed to parse egui fixture manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("egui fixture manifest schemaVersion must be 1".to_string());
    }
    let artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_object)
        .ok_or_else(|| "egui fixture manifest artifacts must be an object".to_string())?;
    if artifacts.is_empty() {
        return Err("egui fixture manifest artifacts must not be empty".to_string());
    }

    let mut paths = Vec::with_capacity(artifacts.len() + 1);
    for (fixture_path, metadata) in artifacts {
        let normalized = Path::new(fixture_path);
        if fixture_path.is_empty()
            || fixture_path.contains('\\')
            || fixture_path
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
            || normalized.is_absolute()
            || normalized
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!(
                "egui fixture manifest artifact path must be normalized and relative: {fixture_path}"
            ));
        }
        let sha256 = metadata
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!("egui fixture manifest artifact is missing sha256: {fixture_path}")
            })?;
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!(
                "egui fixture manifest artifact has invalid sha256: {fixture_path}"
            ));
        }
        paths.push(format!("{EGUI_FIXTURE_ROOT_REPO_PATH}/{fixture_path}"));
    }
    paths.push(EGUI_FIXTURE_MANIFEST_REPO_PATH.to_string());
    paths.sort();
    Ok(paths)
}

fn event(
    id: &str,
    name: &str,
    payload_type: &str,
    fixture_path: &str,
    delivery: &str,
    coalescing: &str,
    resync_command: Option<&str>,
) -> Value {
    json!({
        "id": id,
        "name": name,
        "payloadType": payload_type,
        "fixturePath": fixture_path,
        "delivery": delivery,
        "coalescing": coalescing,
        "resyncCommand": resync_command,
    })
}

fn compatibility_contract_value() -> Result<Value, String> {
    use crate::app::plugins::extension_host_worker;
    use crate::commands::registry;
    use crate::gateway::events;
    use crate::shared::ipc_confirm;

    let generated_commands = registry::generated_command_names();
    if generated_commands.len() != 195 {
        return Err(format!(
            "compatibility command count drifted: expected 195 generated commands, received {}",
            generated_commands.len()
        ));
    }
    if registry::HANDWRITTEN_RUNTIME_ONLY_COMMANDS != ["desktop_updater_download_and_install"] {
        return Err("runtime-only command exception list drifted".to_string());
    }

    let event_contracts = vec![
        event(
            "gateway-status",
            events::GATEWAY_STATUS_EVENT_NAME,
            "GatewayStatus",
            "src/services/gateway/__fixtures__/gatewayEvents/status.json",
            "snapshot",
            "latest-wins",
            Some("gateway_status"),
        ),
        event(
            "gateway-request-start",
            events::GATEWAY_REQUEST_START_EVENT_NAME,
            "GatewayRequestStartEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/request_start.json",
            "realtime",
            "none",
            Some("request_logs_list"),
        ),
        event(
            "gateway-attempt",
            events::GATEWAY_ATTEMPT_EVENT_NAME,
            "GatewayAttemptEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/attempt.json",
            "realtime",
            "none",
            Some("request_logs_list"),
        ),
        event(
            "gateway-request",
            events::GATEWAY_REQUEST_EVENT_NAME,
            "GatewayRequestEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/request.json",
            "durable-projection",
            "none",
            Some("request_logs_list"),
        ),
        event(
            "gateway-request-signal",
            events::GATEWAY_REQUEST_SIGNAL_EVENT_NAME,
            "GatewayRequestSignalEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/request_signal.json",
            "realtime",
            "same-trace-phase-latest-wins",
            None,
        ),
        event(
            "gateway-log",
            events::GATEWAY_LOG_EVENT_NAME,
            "GatewayLogEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/log.json",
            "best-effort",
            "none",
            None,
        ),
        event(
            "gateway-circuit",
            events::GATEWAY_CIRCUIT_EVENT_NAME,
            "GatewayCircuitEvent",
            "src/services/gateway/__fixtures__/gatewayEvents/circuit.json",
            "realtime",
            "provider-latest-wins",
            Some("gateway_circuit_status"),
        ),
        event(
            "app-startup-status",
            crate::app::startup_state::APP_STARTUP_STATUS_EVENT_NAME,
            "AppStartupStatus",
            "src/services/app/__fixtures__/startupStatus/ready.json",
            "snapshot",
            "latest-wins",
            Some("app_startup_status_get"),
        ),
        event(
            "app-heartbeat",
            crate::app::heartbeat_watchdog::HEARTBEAT_EVENT_NAME,
            "HeartbeatPayload",
            "src/services/app/__fixtures__/heartbeat.json",
            "watchdog-signal",
            "latest-wins",
            None,
        ),
        event(
            "app-notice",
            crate::app::notice::NOTICE_EVENT_NAME,
            "NoticeEventPayload",
            "src/services/app/__fixtures__/notice.json",
            "best-effort",
            "none",
            None,
        ),
    ];

    let artifact_paths = compatibility_fixture_artifact_paths()?;

    Ok(json!({
        "schemaVersion": 1,
        "ipc": {
            "generatedCommands": generated_commands,
            "runtimeOnlyCommands": [{
                "name": registry::HANDWRITTEN_RUNTIME_ONLY_COMMANDS[0],
                "reason": registry::HANDWRITTEN_RUNTIME_ONLY_REASON,
            }],
            "runtimeCommandCount": generated_commands.len()
                + registry::HANDWRITTEN_RUNTIME_ONLY_COMMANDS.len(),
            "bindingsPath": "src/generated/bindings.ts",
            "riskyOperations": ipc_confirm::RISKY_IPC_OPERATIONS,
            "confirmErrorCodes": ipc_confirm::CONFIRM_ERROR_CODES,
            "confirmLimits": {
                "maxTtlMs": ipc_confirm::MAX_TTL_MS,
                "maxFutureSkewMs": ipc_confirm::MAX_FUTURE_SKEW_MS,
                "minNonceLen": ipc_confirm::MIN_NONCE_LEN,
                "maxNonceLen": ipc_confirm::MAX_NONCE_LEN,
            },
        },
        "events": event_contracts,
        "data": {
            "dotdirName": crate::app_paths::APP_DOTDIR_NAME,
            "databaseFileName": crate::db::DB_FILE_NAME,
            "settingsFileName": crate::settings::SETTINGS_FILE_NAME,
            "sqlite": {
                "minimum": crate::db::MIN_SUPPORTED_SCHEMA_VERSION,
                "current": crate::db::LATEST_SCHEMA_VERSION,
                "maximumCompatible": crate::db::MAX_COMPAT_SCHEMA_VERSION,
            },
            "settingsSchemaVersion": crate::settings::SCHEMA_VERSION,
            "configBundleSchemaVersions": [
                crate::infra::config_migrate::CONFIG_BUNDLE_SCHEMA_VERSION_V1,
                crate::infra::config_migrate::CONFIG_BUNDLE_SCHEMA_VERSION,
            ],
        },
        "extensionHost": {
            "workerArgument": crate::EXTENSION_HOST_WORKER_ARGUMENT,
            "configArgument": extension_host_worker::EXTENSION_HOST_CONFIG_ARGUMENT,
            "runtime": "rquickjs",
            "transport": "json-rpc-2.0-jsonl-stdio",
            "workerVersion": extension_host_worker::WORKER_VERSION,
            "methods": extension_host_worker::EXTENSION_HOST_METHODS,
            "notifications": extension_host_worker::EXTENSION_HOST_NOTIFICATIONS,
        },
        "artifactPaths": artifact_paths,
    }))
}

pub fn export_compatibility_contract(output_path: impl AsRef<Path>) -> Result<(), String> {
    let output_path = output_path.as_ref();
    if !output_path.is_absolute() {
        return Err("compatibility contract output path must be absolute".to_string());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create contract output directory: {error}"))?;
    }
    let mut content = serde_json::to_string_pretty(&compatibility_contract_value()?)
        .map_err(|error| format!("failed to serialize compatibility contract: {error}"))?;
    content.push('\n');
    std::fs::write(output_path, content)
        .map_err(|error| format!("failed to write compatibility contract: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        compatibility_contract_value, EGUI_FIXTURE_MANIFEST_REPO_PATH, EGUI_FIXTURE_ROOT_REPO_PATH,
    };
    use serde_json::Value;
    use std::path::Path;

    #[test]
    fn exports_frozen_command_event_and_data_counts() {
        let value = compatibility_contract_value().expect("build compatibility contract");
        assert_eq!(
            value["ipc"]["generatedCommands"]
                .as_array()
                .expect("generated commands")
                .len(),
            195
        );
        assert_eq!(value["ipc"]["runtimeCommandCount"], 196);
        assert_eq!(
            value["ipc"]["riskyOperations"]
                .as_array()
                .expect("risky operations")
                .len(),
            6
        );
        assert_eq!(
            value["ipc"]["confirmErrorCodes"]
                .as_array()
                .expect("confirm errors")
                .len(),
            7
        );
        assert_eq!(value["events"].as_array().expect("events").len(), 10);
        assert_eq!(value["data"]["sqlite"]["current"], 35);
        assert_eq!(value["data"]["settingsSchemaVersion"], 34);
    }

    #[test]
    fn exports_every_versioned_fixture_manifest_artifact_for_compatibility_hashing() {
        let value = compatibility_contract_value().expect("build compatibility contract");
        let artifact_paths = value["artifactPaths"]
            .as_array()
            .expect("artifact paths")
            .iter()
            .map(|path| path.as_str().expect("artifact path"))
            .collect::<std::collections::BTreeSet<_>>();
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("egui-migration")
            .join("manifest.json");
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(manifest_path).expect("read egui fixture manifest"),
        )
        .expect("parse egui fixture manifest");
        let manifest_artifacts = manifest["artifacts"]
            .as_object()
            .expect("fixture manifest artifacts");

        assert_eq!(artifact_paths.len(), manifest_artifacts.len() + 1);
        assert!(artifact_paths.contains(EGUI_FIXTURE_MANIFEST_REPO_PATH));
        for fixture_path in manifest_artifacts.keys() {
            let repo_path = format!("{EGUI_FIXTURE_ROOT_REPO_PATH}/{fixture_path}");
            assert!(
                artifact_paths.contains(repo_path.as_str()),
                "fixture artifact must be compatibility hashed: {repo_path}"
            );
        }

        let required_paths = [
            "plugins/plugin-api-v1/representative/plugin.json",
            "plugins/manifest-corpus/cases.json",
            "plugins/transcripts/valid-lifecycle.jsonl",
            "plugins/transcripts/invalid-handshake.jsonl",
            "updater/valid/latest.json",
            "updater/valid/fixture-asset.bin",
            "updater/valid/fixture-asset.bin.sig",
            "updater/valid/test-public-key.txt",
            "updater/invalid/cases.json",
        ];
        for fixture_path in required_paths {
            let repo_path = format!("{EGUI_FIXTURE_ROOT_REPO_PATH}/{fixture_path}");
            assert!(
                artifact_paths.contains(repo_path.as_str()),
                "required compatibility fixture is missing: {repo_path}"
            );
        }
        assert_eq!(
            artifact_paths
                .iter()
                .filter(|path| path.contains("/plugins/transcripts/"))
                .count(),
            2
        );
    }
}
