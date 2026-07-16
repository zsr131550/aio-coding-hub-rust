mod app;
mod benchmark;
mod commands;
mod compatibility_contract;
mod domain;
mod gateway;
mod infra;
mod shared;
pub mod test_support;

// Cargo's tests linker directive covers integration tests, but the library's
// unit-test harness retains native archives only when the crate references one.
#[cfg(all(test, target_os = "windows", target_env = "msvc"))]
#[link(name = "resource", kind = "static")]
unsafe extern "C" {}

#[cfg(test)]
mod benchmark_contract_tests;
#[cfg(test)]
mod egui_fixture_contract;

pub const EXTENSION_HOST_WORKER_ARGUMENT: &str = "--extension-host-worker";
pub const BENCHMARK_INITIALIZATION_EXIT_CODE: i32 = 78;

pub fn initialize_benchmark() -> Result<(), String> {
    match benchmark::initialize_from_env() {
        Ok(true) => {
            benchmark::milestone(
                "process_entry",
                benchmark::process_entry_data(std::process::id()),
            );
            Ok(())
        }
        Ok(false) => Ok(()),
        Err(err) => Err(format!("benchmark initialization failed: {err}")),
    }
}

pub(crate) use app::{
    app_state, gateway_control, gateway_runtime_access, notice, resident, task_runtime,
};
pub(crate) use domain::{
    claude_model_validation, claude_model_validation_history, claude_plugins, cli_sessions, cost,
    cost_stats, mcp, plugins, prompts, provider_limit_usage, providers, skills, sort_modes, usage,
    usage_stats, workspace_switch, workspaces,
};
pub(crate) use gateway::session_manager;
pub(crate) use infra::{
    app_paths, base_url_probe, claude_hooks, claude_settings, cli_manager, cli_proxy, cli_update,
    codex_config, codex_model_catalog, codex_paths, data_management, db, env_conflicts,
    gemini_config, mcp_sync, model_price_aliases, model_prices, model_prices_sync, prompt_sync,
    provider_circuit_breakers, request_attempt_logs, request_logs, settings, wsl,
};
pub(crate) use shared::{blocking, circuit_breaker};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    const RUNTIME_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    let runtime_owner = aio_core::RuntimeOwner::new("aio-coding-hub-runtime")
        .expect("failed to create process task runtime");
    task_runtime::install(runtime_owner.task_runtime())
        .expect("failed to install process task runtime");

    // Must run before Tauri initialises WebKitGTK to prevent EGL display
    // creation failure on Wayland (AppImage bundled-lib conflict, issue #93).
    crate::app::linux_webkit_compat::apply();

    let mut context = tauri::generate_context!();
    benchmark::configure_tauri_context(&mut context, benchmark::test_home());

    let app = commands::registry::register_runtime_commands(
        crate::app::plugin_registry::create_builder(),
    )
    .on_window_event(resident::on_window_event)
    .setup(crate::app::bootstrap::setup)
    .build(context)
    .expect("error while building tauri application");

    let restart_env = tauri::Manager::env(&app);
    let exit_code = app.run_return(crate::app::lifecycle::handle_run_event);
    runtime_owner.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);

    if exit_code == tauri::RESTART_EXIT_CODE {
        tauri::process::restart(&restart_env);
    }
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

pub fn run_extension_host_worker() {
    crate::app::plugins::extension_host_worker::run_stdio_worker();
}

/// 导出前端使用的 TypeScript IPC 绑定。
pub fn export_typescript_bindings(output_path: &str) -> Result<(), String> {
    commands::registry::export_typescript_bindings(output_path)
}

pub use compatibility_contract::export_compatibility_contract;

/// Specta type export smoke test.
///
/// 仅用于手动重新导出前端 bindings：
/// `cargo test export_bindings -- --ignored`
#[cfg(test)]
#[test]
#[ignore = "run manually: cargo test export_bindings -- --ignored"]
fn export_bindings() {
    export_typescript_bindings("../src/generated/bindings.ts")
        .expect("failed to export specta TypeScript bindings");
}

#[cfg(test)]
mod runtime_ownership_tests {
    #[test]
    fn process_runtime_outlives_tauri_and_shuts_down_after_event_loop() {
        let source = std::fs::read_to_string(file!()).expect("read library source");
        let owner = source
            .find("RuntimeOwner::new")
            .expect("run must create RuntimeOwner");
        let install = source
            .find("task_runtime::install")
            .expect("run must install process task runtime");
        let event_loop = source
            .find("app.run_return(")
            .expect("run must use a returning Tauri event loop");
        let shutdown = source
            .find("runtime_owner.shutdown_timeout")
            .expect("run must shut down owned runtime");
        let restart = source
            .find("tauri::process::restart")
            .expect("restart must be owned after runtime shutdown");

        assert!(owner < install);
        assert!(install < event_loop);
        assert!(event_loop < shutdown);
        assert!(shutdown < restart);
    }
}
