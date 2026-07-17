use std::path::Path;

use aio_platform::{
    DesktopDialogFileAccessMode, DesktopDialogPickerMode, DialogOpenRequest, DialogPath,
    DialogSaveRequest, DialogService, PlatformError, PlatformFuture, PlatformOperation,
    PlatformResult,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FileAccessMode, FileDialogBuilder, FilePath, PickerMode};

const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) struct TauriDialogService<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriDialogService<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> DialogService for TauriDialogService<R> {
    fn open(&self, request: DialogOpenRequest) -> PlatformFuture<'_, Option<Vec<DialogPath>>> {
        let app = self.app.clone();
        Box::pin(async move { open_dialog(app, request).await })
    }

    fn save(&self, request: DialogSaveRequest) -> PlatformFuture<'_, Option<DialogPath>> {
        let app = self.app.clone();
        Box::pin(async move { save_dialog(app, request).await })
    }
}

fn picker_mode(mode: DesktopDialogPickerMode) -> PickerMode {
    match mode {
        DesktopDialogPickerMode::Document => PickerMode::Document,
        DesktopDialogPickerMode::Media => PickerMode::Media,
        DesktopDialogPickerMode::Image => PickerMode::Image,
        DesktopDialogPickerMode::Video => PickerMode::Video,
    }
}

fn file_access_mode(mode: DesktopDialogFileAccessMode) -> FileAccessMode {
    match mode {
        DesktopDialogFileAccessMode::Copy => FileAccessMode::Copy,
        DesktopDialogFileAccessMode::Scoped => FileAccessMode::Scoped,
    }
}

fn apply_default_path<R: tauri::Runtime>(
    mut dialog: FileDialogBuilder<R>,
    default_path: Option<&Path>,
) -> FileDialogBuilder<R> {
    let Some(path) = default_path else {
        return dialog;
    };

    if path.is_file() || !path.exists() {
        if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
            if parent.components().count() > 0 {
                dialog = dialog.set_directory(parent);
            }
            dialog = dialog.set_file_name(file_name.to_string_lossy());
            return dialog;
        }
    }

    dialog.set_directory(path)
}

fn main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    operation: PlatformOperation,
) -> PlatformResult<tauri::WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        PlatformError::new(
            "DESKTOP_DIALOG_WINDOW_UNAVAILABLE",
            operation,
            "main window is unavailable",
        )
    })
}

fn file_path(path: FilePath) -> DialogPath {
    DialogPath::new(path.to_string())
}

async fn open_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: DialogOpenRequest,
) -> PlatformResult<Option<Vec<DialogPath>>> {
    let window = main_window(&app, PlatformOperation::DialogOpen)?;
    let mut dialog = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    {
        dialog = dialog.set_parent(&window);
    }

    if let Some(title) = request.title() {
        dialog = dialog.set_title(title);
    }
    dialog = apply_default_path(dialog, request.default_path());
    if let Some(can_create_directories) = request.can_create_directories() {
        dialog = dialog.set_can_create_directories(can_create_directories);
    }
    if let Some(mode) = request.picker_mode() {
        dialog = dialog.set_picker_mode(picker_mode(mode));
    }
    if let Some(mode) = request.file_access_mode() {
        dialog = dialog.set_file_access_mode(file_access_mode(mode));
    }
    for filter in request.filters() {
        let extensions = filter
            .extensions()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(filter.name(), &extensions);
    }
    let _ = request.recursive();

    let (sender, receiver) = tokio::sync::oneshot::channel();
    match (request.directory(), request.multiple()) {
        (true, true) => dialog.pick_folders(move |selection| {
            let _ = sender
                .send(selection.map(|paths| paths.into_iter().map(file_path).collect::<Vec<_>>()));
        }),
        (true, false) => dialog.pick_folder(move |selection| {
            let _ = sender.send(selection.map(|path| vec![file_path(path)]));
        }),
        (false, true) => dialog.pick_files(move |selection| {
            let _ = sender
                .send(selection.map(|paths| paths.into_iter().map(file_path).collect::<Vec<_>>()));
        }),
        (false, false) => dialog.pick_file(move |selection| {
            let _ = sender.send(selection.map(|path| vec![file_path(path)]));
        }),
    }

    receiver.await.map_err(|_| {
        PlatformError::new(
            "DESKTOP_DIALOG_OPEN_CANCELLED",
            PlatformOperation::DialogOpen,
            "dialog response channel dropped",
        )
    })
}

async fn save_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: DialogSaveRequest,
) -> PlatformResult<Option<DialogPath>> {
    let window = main_window(&app, PlatformOperation::DialogSave)?;
    let mut dialog = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    {
        dialog = dialog.set_parent(&window);
    }

    if let Some(title) = request.title() {
        dialog = dialog.set_title(title);
    }
    dialog = apply_default_path(dialog, request.default_path());
    if let Some(can_create_directories) = request.can_create_directories() {
        dialog = dialog.set_can_create_directories(can_create_directories);
    }
    for filter in request.filters() {
        let extensions = filter
            .extensions()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(filter.name(), &extensions);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |selection| {
        let _ = sender.send(selection.map(file_path));
    });

    receiver.await.map_err(|_| {
        PlatformError::new(
            "DESKTOP_DIALOG_SAVE_CANCELLED",
            PlatformOperation::DialogSave,
            "dialog response channel dropped",
        )
    })
}
