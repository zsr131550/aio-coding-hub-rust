//! Usage: Async startup task pipeline extracted from bootstrap setup.

use super::app_state::{ensure_db_ready, ManagedCoreRuntimeState};
use super::startup_state::{
    fail_startup_run, finish_startup_run, set_startup_stage, try_begin_startup_run, AppStartupStage,
};
use tauri::Manager;

pub(crate) fn spawn(app_handle: tauri::AppHandle) -> bool {
    let core_state = app_handle
        .state::<ManagedCoreRuntimeState>()
        .inner()
        .clone();
    if !try_begin_startup_run(&core_state) {
        return false;
    }
    crate::benchmark::milestone("startup_run_started", serde_json::json!({}));

    crate::task_runtime::spawn(async move {
        run(app_handle).await;
    });
    true
}

async fn run(app_handle: tauri::AppHandle) {
    let core_state = app_handle
        .state::<ManagedCoreRuntimeState>()
        .inner()
        .clone();
    let db = match ensure_db_ready(app_handle.clone(), &core_state).await {
        Ok(db) => db,
        Err(err) => {
            tracing::error!("database initialization failed: {}", err);
            fail_startup_run(
                &core_state,
                AppStartupStage::InitializingDb,
                format!("数据库初始化失败：{err}"),
            );
            return;
        }
    };
    crate::benchmark::milestone("db_ready", serde_json::json!({}));

    match crate::request_logs::reconcile_unresolved_pending(
        &db,
        crate::request_logs::RequestLogReconcileReason::StartupRecovery,
        crate::shared::time::now_unix_millis(),
    ) {
        Ok(count) => {
            if count > 0 {
                tracing::info!(
                    reconciled_count = count,
                    "startup reconciled previous-process pending request logs"
                );
            }
        }
        Err(err) => {
            tracing::error!("startup request-log reconciliation failed: {}", err);
            fail_startup_run(
                &core_state,
                AppStartupStage::InitializingDb,
                format!("请求日志恢复失败：{err}"),
            );
            return;
        }
    }

    crate::request_logs::spawn_retention_task(app_handle.clone(), db.clone());

    set_startup_stage(&core_state, AppStartupStage::ReadingSettings);
    let settings = match crate::app::startup_settings::read(&app_handle).await {
        Ok(settings) => settings,
        Err(err) => {
            fail_startup_run(&core_state, AppStartupStage::ReadingSettings, err);
            return;
        }
    };
    crate::benchmark::milestone("settings_ready", serde_json::json!({}));

    crate::app::startup_settings::apply_window_state(&app_handle, &settings);
    crate::benchmark::record_window_visibility(&app_handle, settings.start_minimized);

    set_startup_stage(&core_state, AppStartupStage::StartingGateway);
    let status = match crate::app::startup_gateway::start(&app_handle, db.clone(), &settings).await
    {
        Ok(status) => status,
        Err(err) => {
            fail_startup_run(&core_state, AppStartupStage::StartingGateway, err);
            return;
        }
    };
    crate::benchmark::milestone(
        "gateway_bound",
        serde_json::json!({
            "port": status.port,
            "listenAddr": status.listen_addr,
        }),
    );
    crate::benchmark::record_gateway_ready(&status).await;

    set_startup_stage(&core_state, AppStartupStage::SyncingCliProxy);
    crate::app::startup_gateway::sync_cli_proxy_after_autostart(&app_handle, &status).await;

    set_startup_stage(&core_state, AppStartupStage::FinalizingWsl);
    crate::app::startup_wsl::finalize(&app_handle, db, status.port, settings).await;
    finish_startup_run(&core_state);
    crate::benchmark::milestone("startup_ready", serde_json::json!({}));
    crate::benchmark::schedule_native_idle_completion(app_handle);
}
