use aio_platform::{AutostartService, PlatformError, PlatformOperation, PlatformResult};

pub(crate) struct TauriAutostartService<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriAutostartService<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> AutostartService for TauriAutostartService<R> {
    fn set_enabled(&self, enabled: bool) -> PlatformResult<()> {
        sync_autostart(&self.app, enabled)
    }
}

#[cfg(desktop)]
fn sync_autostart<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    enabled: bool,
) -> PlatformResult<()> {
    use tauri::Manager;
    use tauri_plugin_autostart::ManagerExt;

    if app
        .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
        .is_none()
    {
        tracing::debug!("auto-start plugin not initialized, skipping sync");
        return Ok(());
    }

    if enabled {
        app.autolaunch().enable().map_err(|error| {
            PlatformError::new(
                "AUTOSTART_ENABLE_FAILED",
                PlatformOperation::AutostartSetEnabled,
                format!("failed to enable autostart: {error}"),
            )
        })
    } else {
        app.autolaunch().disable().map_err(|error| {
            PlatformError::new(
                "AUTOSTART_DISABLE_FAILED",
                PlatformOperation::AutostartSetEnabled,
                format!("failed to disable autostart: {error}"),
            )
        })
    }
}

#[cfg(not(desktop))]
fn sync_autostart<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _enabled: bool,
) -> PlatformResult<()> {
    Ok(())
}
