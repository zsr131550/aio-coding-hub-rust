//! Usage: Shell-side gateway debug logging controlled by live Tauri settings.

pub(crate) fn emit_gateway_debug_log<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    message: String,
) {
    emit_gateway_debug_log_lazy(app, || message);
}

pub(crate) fn emit_gateway_debug_log_lazy<R, F>(app: &tauri::AppHandle<R>, build_message: F)
where
    R: tauri::Runtime,
    F: FnOnce() -> String,
{
    let enabled = crate::settings::read(app)
        .map(|cfg| cfg.enable_debug_log)
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let message = build_message();
    tracing::info!(target: "gateway_debug", "{message}");
}
