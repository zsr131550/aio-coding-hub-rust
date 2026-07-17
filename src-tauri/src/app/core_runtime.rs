//! Usage: Concrete legacy-shell adapter for the headless application runtime state.

use super::plugins::extension_host_registry::ExtensionHostInstanceRegistry;
use crate::gateway::manager::GatewayManager;
use crate::shared::error::AppError;
use std::sync::Arc;
use tauri::Manager;

pub(crate) type CoreRuntimeState = aio_core::AppRuntimeState<
    crate::db::Db,
    GatewayManager,
    Arc<ExtensionHostInstanceRegistry>,
    AppError,
>;
pub(crate) type ManagedCoreRuntimeState = Arc<CoreRuntimeState>;

pub(crate) fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    paths: Arc<aio_core::AppPaths>,
    instance: Arc<aio_core::InstanceGuard>,
) -> Result<ManagedCoreRuntimeState, std::io::Error> {
    let platform = super::platform::create_platform_services(app.clone());
    let context = Arc::new(aio_core::AppContext::new(
        paths,
        platform,
        crate::task_runtime::current(),
        Arc::new(super::tauri_event_sink::TauriEventSink::new(app.clone())),
        Arc::new(aio_core::StartupState::default()),
        instance,
    ));
    let state = Arc::new(CoreRuntimeState::new(context, GatewayManager::default()));
    if !app.manage(Arc::clone(&state)) {
        return Err(std::io::Error::other(
            "failed to install application runtime state",
        ));
    }
    Ok(state)
}

pub(crate) fn event_sink<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Arc<dyn aio_core::EventSink> {
    app.state::<ManagedCoreRuntimeState>()
        .context()
        .events()
        .clone()
}

pub(crate) fn try_event_sink<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<Arc<dyn aio_core::EventSink>> {
    app.try_state::<ManagedCoreRuntimeState>()
        .map(|state| state.context().events().clone())
}

pub(crate) fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: aio_contract::AppEvent) {
    event_sink(app).publish(event);
}
