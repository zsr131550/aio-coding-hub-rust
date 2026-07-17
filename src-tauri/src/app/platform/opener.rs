use aio_platform::{
    AuthorizedOpenPath, AuthorizedRevealPath, OpenUrlRequest, OpenerService, PlatformError,
    PlatformFuture, PlatformOperation,
};
use tauri_plugin_opener::OpenerExt;

pub(crate) struct TauriOpenerService<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriOpenerService<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

fn backend_error(
    error: crate::shared::error::AppError,
    operation: PlatformOperation,
) -> PlatformError {
    let formatted = error.to_string();
    let detail = formatted
        .strip_prefix("PLATFORM_BACKEND: ")
        .unwrap_or(&formatted)
        .to_string();
    PlatformError::new("OPENER_BACKEND_FAILED", operation, detail)
}

impl<R: tauri::Runtime> OpenerService for TauriOpenerService<R> {
    fn open_url(&self, request: OpenUrlRequest) -> PlatformFuture<'_, ()> {
        let app = self.app.clone();
        let url = request.url().to_string();
        let program = request.program().map(str::to_string);
        Box::pin(async move {
            crate::shared::blocking::run("platform_opener_open_url", move || {
                app.opener()
                    .open_url(url, program.as_deref())
                    .map_err(|error| {
                        crate::shared::error::AppError::new("PLATFORM_BACKEND", error.to_string())
                    })
            })
            .await
            .map_err(|error| backend_error(error, PlatformOperation::OpenerOpenUrl))
        })
    }

    fn open_path(&self, request: AuthorizedOpenPath) -> PlatformFuture<'_, ()> {
        let app = self.app.clone();
        let path = request.path().display().to_string();
        let program = request.program().map(str::to_string);
        Box::pin(async move {
            crate::shared::blocking::run("platform_opener_open_path", move || {
                app.opener()
                    .open_path(path, program.as_deref())
                    .map_err(|error| {
                        crate::shared::error::AppError::new("PLATFORM_BACKEND", error.to_string())
                    })
            })
            .await
            .map_err(|error| backend_error(error, PlatformOperation::OpenerOpenPath))
        })
    }

    fn reveal_item(&self, request: AuthorizedRevealPath) -> PlatformFuture<'_, ()> {
        let app = self.app.clone();
        let path = request.path().to_path_buf();
        Box::pin(async move {
            crate::shared::blocking::run("platform_opener_reveal_item", move || {
                app.opener().reveal_item_in_dir(path).map_err(|error| {
                    crate::shared::error::AppError::new("PLATFORM_BACKEND", error.to_string())
                })
            })
            .await
            .map_err(|error| backend_error(error, PlatformOperation::OpenerRevealItem))
        })
    }
}
