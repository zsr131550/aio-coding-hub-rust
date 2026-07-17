use std::sync::Arc;

use aio_platform::{PlatformServiceSet, PlatformServices};

pub(crate) fn create_platform_services<R>(app: tauri::AppHandle<R>) -> Arc<dyn PlatformServices>
where
    R: tauri::Runtime,
{
    Arc::new(PlatformServiceSet::new(
        Arc::new(super::clipboard::TauriClipboardService::new(app.clone())),
        Arc::new(super::dialog::TauriDialogService::new(app.clone())),
        Arc::new(super::opener::TauriOpenerService::new(app.clone())),
        Arc::new(super::notification::TauriNotificationService::new(
            app.clone(),
        )),
        Arc::new(super::autostart::TauriAutostartService::new(app)),
        Arc::new(super::updater::DisabledTauriUpdateService),
    ))
}
