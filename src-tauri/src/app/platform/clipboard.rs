use std::borrow::Cow;

use aio_platform::{
    ClipboardService, ClipboardText, PlatformError, PlatformOperation, PlatformResult,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub(crate) struct TauriClipboardService<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriClipboardService<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> ClipboardService for TauriClipboardService<R> {
    fn write_text(&self, text: ClipboardText) -> PlatformResult<()> {
        self.app
            .clipboard()
            .write_text(Cow::Owned(text.into_string()))
            .map_err(|error| {
                PlatformError::new(
                    "CLIPBOARD_BACKEND_FAILED",
                    PlatformOperation::ClipboardWriteText,
                    error.to_string(),
                )
            })
    }
}
