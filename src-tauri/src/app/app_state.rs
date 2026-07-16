//! Usage: DB access adapter backed by the unified headless runtime state.

pub(crate) use super::core_runtime::ManagedCoreRuntimeState;
use crate::shared::error::{AppError, AppResult};
use crate::{blocking, db};

pub(crate) async fn ensure_db_ready<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: &ManagedCoreRuntimeState,
) -> AppResult<db::Db> {
    ensure_db_ready_with(app, state.database()).await
}

pub(crate) async fn prepare_db_reset<'a>(
    state: &'a ManagedCoreRuntimeState,
) -> aio_core::AsyncInitResetGuard<'a, db::Db, AppError> {
    // Hold the cache lock through file deletion so no concurrent command can
    // recreate the pool midway through a destructive reset.
    state.database().begin_reset().await
}

pub(crate) async fn ensure_db_ready_with<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: &aio_core::AsyncInitState<db::Db, AppError>,
) -> AppResult<db::Db> {
    state
        .get_or_try_init(|| async move { blocking::run("db_init", move || db::init(&app)).await })
        .await
}
