//! Usage: Backend-owned desktop capability proxy commands.
//!
//! This module keeps sensitive or high-risk desktop capabilities behind one
//! handwritten IPC family so the renderer does not call plugin commands
//! directly.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aio_platform::{
    DesktopDialogOpenRequest, DesktopDialogSaveRequest, DesktopNotificationPayload,
    DesktopNotificationPermissionState, DesktopOpenPathRequest, DesktopOpenUrlRequest,
    DesktopRevealItemRequest, DesktopUpdaterMetadata,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{ResourceId, WebviewWindow};

use crate::shared::ipc_confirm::{RiskyIpcConfirm, RISKY_DESKTOP_UPDATER_INSTALL};

#[derive(Debug, Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopThemeMode {
    Light,
    Dark,
    System,
}

impl DesktopThemeMode {
    fn into_tauri_theme(self) -> Option<tauri::Theme> {
        match self {
            Self::Light => Some(tauri::Theme::Light),
            Self::Dark => Some(tauri::Theme::Dark),
            Self::System => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
#[allow(dead_code)] // Retained for the runtime-only Channel IPC compatibility surface.
pub(crate) enum DesktopUpdaterDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[cfg(test)]
fn normalize_existing_path(path: PathBuf) -> PathBuf {
    aio_platform::OpenPathPolicy::new([path]).roots()[0].clone()
}

fn desktop_open_allowed_roots<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<PathBuf>, String> {
    let home_dir = crate::infra::app_paths::home_dir(app).map_err(|error| error.to_string())?;
    let app_data_dir =
        crate::infra::app_paths::app_data_dir(app).map_err(|error| error.to_string())?;
    let user_default_codex_home_dir = crate::infra::codex_paths::codex_home_dir_user_default(app)
        .map_err(|error| error.to_string())?;
    let follow_codex_home_dir =
        crate::infra::codex_paths::codex_home_dir_follow_env_or_default(app)
            .map_err(|error| error.to_string())?;
    let effective_codex_home_dir =
        crate::infra::codex_paths::codex_home_dir(app).map_err(|error| error.to_string())?;
    let configured_codex_home_dir = crate::infra::codex_paths::configured_codex_home_dir(app);

    let mut roots = vec![
        app_data_dir,
        home_dir.join(".claude"),
        home_dir.join(".gemini"),
        user_default_codex_home_dir,
        follow_codex_home_dir,
        effective_codex_home_dir,
    ];
    if let Some(configured_codex_home_dir) = configured_codex_home_dir {
        roots.push(configured_codex_home_dir);
    }

    Ok(aio_platform::OpenPathPolicy::new(roots).roots().to_vec())
}

#[cfg(test)]
fn ensure_desktop_open_path_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
) -> Result<(), String> {
    let candidate = aio_platform::OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: path.display().to_string(),
        with: None,
    })
    .map_err(|error| error.to_string())?;
    aio_platform::OpenPathPolicy::new(desktop_open_allowed_roots(app)?)
        .authorize(candidate)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_clipboard_write_text(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    text: String,
) -> Result<bool, String> {
    desktop_clipboard_write_text_with(state.context().platform().as_ref(), text)
}

fn desktop_clipboard_write_text_with(
    platform: &dyn aio_platform::PlatformServices,
    text: String,
) -> Result<bool, String> {
    let text =
        aio_platform::ClipboardText::from_desktop_input(text).map_err(|error| error.to_string())?;
    platform
        .clipboard()
        .write_text(text)
        .map_err(|error| format!("failed to write clipboard text: {}", error.message()))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_dialog_open(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    options: DesktopDialogOpenRequest,
) -> Result<Option<Vec<String>>, String> {
    let platform = state.context().platform().clone();
    desktop_dialog_open_with(platform.as_ref(), options).await
}

async fn desktop_dialog_open_with(
    platform: &dyn aio_platform::PlatformServices,
    options: DesktopDialogOpenRequest,
) -> Result<Option<Vec<String>>, String> {
    let request =
        aio_platform::DialogOpenRequest::try_from(options).map_err(|error| error.to_string())?;
    platform
        .dialogs()
        .open(request)
        .await
        .map(|selection| {
            selection.map(|paths| {
                paths
                    .into_iter()
                    .map(aio_platform::DialogPath::into_string)
                    .collect()
            })
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_dialog_save(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    options: DesktopDialogSaveRequest,
) -> Result<Option<String>, String> {
    let platform = state.context().platform().clone();
    desktop_dialog_save_with(platform.as_ref(), options).await
}

async fn desktop_dialog_save_with(
    platform: &dyn aio_platform::PlatformServices,
    options: DesktopDialogSaveRequest,
) -> Result<Option<String>, String> {
    let request =
        aio_platform::DialogSaveRequest::try_from(options).map_err(|error| error.to_string())?;
    platform
        .dialogs()
        .save(request)
        .await
        .map(|selection| selection.map(aio_platform::DialogPath::into_string))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_window_set_theme(
    window: WebviewWindow,
    theme: DesktopThemeMode,
) -> Result<bool, String> {
    window
        .set_theme(theme.into_tauri_theme())
        .map_err(|error| format!("failed to set desktop window theme: {error}"))?;

    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_opener_open_url(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    input: DesktopOpenUrlRequest,
) -> Result<bool, String> {
    let platform = state.context().platform().clone();
    desktop_opener_open_url_with(platform.as_ref(), input).await
}

async fn desktop_opener_open_url_with(
    platform: &dyn aio_platform::PlatformServices,
    input: DesktopOpenUrlRequest,
) -> Result<bool, String> {
    let request =
        aio_platform::OpenUrlRequest::try_from(input).map_err(|error| error.to_string())?;
    platform
        .opener()
        .open_url(request)
        .await
        .map_err(|error| format!("failed to open desktop url: {}", error.message()))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_opener_open_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    input: DesktopOpenPathRequest,
) -> Result<bool, String> {
    let roots = desktop_open_allowed_roots(&app)?;
    let platform = state.context().platform().clone();
    desktop_opener_open_path_with(platform.as_ref(), input, roots).await
}

async fn desktop_opener_open_path_with(
    platform: &dyn aio_platform::PlatformServices,
    input: DesktopOpenPathRequest,
    roots: Vec<PathBuf>,
) -> Result<bool, String> {
    let candidate =
        aio_platform::OpenPathCandidate::try_from(input).map_err(|error| error.to_string())?;
    let request = aio_platform::OpenPathPolicy::new(roots)
        .authorize(candidate)
        .map_err(|error| error.to_string())?;
    platform
        .opener()
        .open_path(request)
        .await
        .map_err(|error| format!("failed to open desktop path: {}", error.message()))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_opener_reveal_item_in_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    input: DesktopRevealItemRequest,
) -> Result<bool, String> {
    let roots = desktop_open_allowed_roots(&app)?;
    let platform = state.context().platform().clone();
    desktop_opener_reveal_item_with(platform.as_ref(), input, roots).await
}

async fn desktop_opener_reveal_item_with(
    platform: &dyn aio_platform::PlatformServices,
    input: DesktopRevealItemRequest,
    roots: Vec<PathBuf>,
) -> Result<bool, String> {
    let candidate =
        aio_platform::RevealPathCandidate::try_from(input).map_err(|error| error.to_string())?;
    let request = aio_platform::OpenPathPolicy::new(roots)
        .authorize_reveal(candidate)
        .map_err(|error| error.to_string())?;
    platform
        .opener()
        .reveal_item(request)
        .await
        .map_err(|error| format!("failed to reveal desktop item: {}", error.message()))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_notification_is_permission_granted(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
) -> Result<bool, String> {
    desktop_notification_is_permission_granted_with(state.context().platform().as_ref())
}

fn desktop_notification_is_permission_granted_with(
    platform: &dyn aio_platform::PlatformServices,
) -> Result<bool, String> {
    platform
        .notifications()
        .permission_state()
        .map(|state| matches!(state, DesktopNotificationPermissionState::Granted))
        .map_err(|error| {
            format!(
                "failed to read notification permission: {}",
                error.message()
            )
        })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_notification_request_permission(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
) -> Result<DesktopNotificationPermissionState, String> {
    desktop_notification_request_permission_with(state.context().platform().as_ref())
}

fn desktop_notification_request_permission_with(
    platform: &dyn aio_platform::PlatformServices,
) -> Result<DesktopNotificationPermissionState, String> {
    platform
        .notifications()
        .request_permission()
        .map_err(|error| {
            format!(
                "failed to request notification permission: {}",
                error.message()
            )
        })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_notification_notify(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    options: DesktopNotificationPayload,
) -> Result<bool, String> {
    desktop_notification_notify_with(state.context().platform().as_ref(), options)
}

fn desktop_notification_notify_with(
    platform: &dyn aio_platform::PlatformServices,
    options: DesktopNotificationPayload,
) -> Result<bool, String> {
    let notification =
        aio_platform::Notification::try_from(options).map_err(|error| error.to_string())?;
    platform
        .notifications()
        .notify(notification)
        .map_err(|error| format!("failed to show desktop notification: {}", error.message()))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn desktop_notification_play_sound(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
) -> Result<bool, String> {
    desktop_notification_play_sound_with(state.context().platform().as_ref())
}

fn desktop_notification_play_sound_with(
    platform: &dyn aio_platform::PlatformServices,
) -> Result<bool, String> {
    platform
        .notifications()
        .play_sound()
        .map_err(|error| error.message().to_string())?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn desktop_updater_check(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    timeout: Option<u64>,
) -> Result<Option<DesktopUpdaterMetadata>, String> {
    let platform = state.context().platform().clone();
    desktop_updater_check_with(platform.as_ref(), timeout).await
}

async fn desktop_updater_check_with(
    platform: &dyn aio_platform::PlatformServices,
    timeout: Option<u64>,
) -> Result<Option<DesktopUpdaterMetadata>, String> {
    let request = aio_platform::UpdateCheckRequest::new(
        timeout.map(Duration::from_millis),
        aio_platform::CancellationToken::new(),
    );
    platform
        .updater()
        .check(request)
        .await
        .map(|metadata| metadata.map(DesktopUpdaterMetadata::from))
        .map_err(|error| error.to_string())
}

struct ChannelUpdateProgressSink {
    channel: Channel<DesktopUpdaterDownloadEvent>,
}

impl aio_platform::UpdateProgressSink for ChannelUpdateProgressSink {
    fn publish(
        &self,
        event: aio_platform::UpdateProgressEvent,
    ) -> aio_platform::PlatformResult<()> {
        let event = match event {
            aio_platform::UpdateProgressEvent::Started { content_length } => {
                DesktopUpdaterDownloadEvent::Started { content_length }
            }
            aio_platform::UpdateProgressEvent::Progress { chunk_length } => {
                DesktopUpdaterDownloadEvent::Progress { chunk_length }
            }
            aio_platform::UpdateProgressEvent::Finished => DesktopUpdaterDownloadEvent::Finished,
        };
        self.channel.send(event).map_err(|error| {
            aio_platform::PlatformError::new(
                "UPDATE_PROGRESS_CHANNEL_FAILED",
                aio_platform::PlatformOperation::UpdateProgress,
                format!("failed to send updater progress: {error}"),
            )
        })
    }
}

#[tauri::command]
pub(crate) async fn desktop_updater_download_and_install(
    state: tauri::State<'_, crate::app::core_runtime::ManagedCoreRuntimeState>,
    rid: ResourceId,
    on_event: Channel<DesktopUpdaterDownloadEvent>,
    timeout: Option<u64>,
    confirm: Option<RiskyIpcConfirm>,
) -> Result<bool, String> {
    let platform = state.context().platform().clone();
    desktop_updater_download_and_install_with(
        platform.as_ref(),
        rid,
        Arc::new(ChannelUpdateProgressSink { channel: on_event }),
        timeout,
        confirm,
    )
    .await
}

async fn desktop_updater_download_and_install_with(
    platform: &dyn aio_platform::PlatformServices,
    rid: ResourceId,
    progress: Arc<dyn aio_platform::UpdateProgressSink>,
    timeout: Option<u64>,
    confirm: Option<RiskyIpcConfirm>,
) -> Result<bool, String> {
    RISKY_DESKTOP_UPDATER_INSTALL.require(confirm, format!("updater:{rid}"))?;
    let request = aio_platform::UpdateInstallRequest::new(
        aio_platform::UpdateId::new(rid),
        timeout.map(Duration::from_millis),
        aio_platform::CancellationToken::new(),
    );
    platform
        .updater()
        .download_and_install(request, progress)
        .await
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        desktop_clipboard_write_text_with, desktop_dialog_open_with, desktop_dialog_save_with,
        desktop_notification_is_permission_granted_with, desktop_notification_notify_with,
        desktop_notification_play_sound_with, desktop_notification_request_permission_with,
        desktop_open_allowed_roots, desktop_opener_open_path_with, desktop_opener_open_url_with,
        desktop_opener_reveal_item_with, desktop_updater_check_with,
        desktop_updater_download_and_install_with, ensure_desktop_open_path_allowed,
        normalize_existing_path, DesktopDialogOpenRequest, DesktopDialogSaveRequest,
        DesktopOpenPathRequest, DesktopOpenUrlRequest, DesktopRevealItemRequest,
        DesktopUpdaterDownloadEvent,
    };
    use crate::infra::settings::{self, AppSettings, CodexHomeMode};
    use crate::shared::ipc_confirm::{IpcConfirm, RiskyIpcConfirm};
    use crate::test_support::{clear_settings_cache, test_env_lock};
    use aio_platform::fakes::{FakePlatformServices, PlatformCall};
    use aio_platform::{
        DesktopNotificationPayload, DesktopNotificationPermissionState, DialogPath, PlatformError,
        PlatformOperation, PlatformResult, UpdateProgressEvent, UpdateProgressSink,
    };
    use std::ffi::OsString;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ENV_SEQ: AtomicU64 = AtomicU64::new(1);

    #[derive(Default)]
    struct NoopProgressSink;

    impl UpdateProgressSink for NoopProgressSink {
        fn publish(&self, _event: UpdateProgressEvent) -> PlatformResult<()> {
            Ok(())
        }
    }

    fn valid_updater_confirm(rid: u32) -> RiskyIpcConfirm {
        RiskyIpcConfirm {
            confirm: IpcConfirm {
                action: "desktop_updater_download_and_install".to_string(),
                resource: format!("updater:{rid}"),
                nonce: "abcDEF1234567890".to_string(),
                issued_at_ms: crate::shared::time::now_unix_millis(),
                ttl_ms: 60_000,
            },
        }
    }

    #[tokio::test]
    async fn updater_check_calls_service_and_maps_none() {
        let platform = FakePlatformServices::new();
        platform.updater_fake().script_check_result(Ok(None));

        assert_eq!(
            desktop_updater_check_with(&platform, Some(0)).await,
            Ok(None)
        );
        assert!(matches!(
            platform.journal().snapshot()[0].call,
            PlatformCall::UpdateCheck {
                timeout_ms: Some(0),
                cancelled: false
            }
        ));
    }

    #[tokio::test]
    async fn updater_install_missing_confirm_never_calls_service() {
        let platform = FakePlatformServices::new();

        let error = desktop_updater_download_and_install_with(
            &platform,
            42,
            std::sync::Arc::new(NoopProgressSink),
            None,
            None,
        )
        .await
        .unwrap_err();

        assert!(error.starts_with("SEC_CONFIRM_REQUIRED:"));
        assert!(platform.journal().snapshot().is_empty());
    }

    #[tokio::test]
    async fn updater_install_valid_confirm_calls_service_once() {
        let platform = FakePlatformServices::new();
        platform
            .updater_fake()
            .script_install_result(Vec::new(), Ok(()));

        assert_eq!(
            desktop_updater_download_and_install_with(
                &platform,
                42,
                std::sync::Arc::new(NoopProgressSink),
                Some(0),
                Some(valid_updater_confirm(42)),
            )
            .await,
            Ok(true)
        );
        assert!(matches!(
            platform.journal().snapshot()[0].call,
            PlatformCall::UpdateDownloadAndInstall {
                id,
                timeout_ms: Some(0),
                cancelled: false
            } if id.get() == 42
        ));
    }

    #[tokio::test]
    async fn updater_install_returns_exact_disabled_error() {
        let platform = FakePlatformServices::new();
        platform.updater_fake().script_install_result(
            Vec::new(),
            Err(PlatformError::new(
                "UPDATE_CHANNEL_DISABLED",
                PlatformOperation::UpdateDownloadAndInstall,
                "update channel is disabled",
            )),
        );

        assert_eq!(
            desktop_updater_download_and_install_with(
                &platform,
                7,
                std::sync::Arc::new(NoopProgressSink),
                None,
                Some(valid_updater_confirm(7)),
            )
            .await
            .unwrap_err(),
            "UPDATE_CHANNEL_DISABLED: update channel is disabled"
        );
    }

    #[test]
    fn updater_progress_channel_json_is_unchanged() {
        assert_eq!(
            serde_json::to_value(DesktopUpdaterDownloadEvent::Started {
                content_length: Some(1_024),
            })
            .unwrap(),
            serde_json::json!({
                "event": "Started",
                "data": { "contentLength": 1_024 }
            })
        );
        assert_eq!(
            serde_json::to_value(DesktopUpdaterDownloadEvent::Progress { chunk_length: 128 })
                .unwrap(),
            serde_json::json!({
                "event": "Progress",
                "data": { "chunkLength": 128 }
            })
        );
        assert_eq!(
            serde_json::to_value(DesktopUpdaterDownloadEvent::Finished).unwrap(),
            serde_json::json!({ "event": "Finished" })
        );
    }

    fn raw_open_dialog_request() -> DesktopDialogOpenRequest {
        DesktopDialogOpenRequest {
            title: None,
            filters: None,
            default_path: None,
            multiple: None,
            directory: None,
            recursive: None,
            can_create_directories: None,
            picker_mode: None,
            file_access_mode: None,
        }
    }

    #[tokio::test]
    async fn dialog_open_maps_scripted_paths() {
        let platform = FakePlatformServices::new();
        platform.dialog_fake().script_open_result(Ok(Some(vec![
            DialogPath::new("first.txt"),
            DialogPath::new("second.txt"),
        ])));

        assert_eq!(
            desktop_dialog_open_with(&platform, raw_open_dialog_request())
                .await
                .unwrap(),
            Some(vec!["first.txt".to_string(), "second.txt".to_string()])
        );
        let records = platform.journal().snapshot();
        assert!(matches!(
            &records[0].call,
            PlatformCall::DialogOpen { request }
                if !request.multiple() && !request.directory()
        ));
    }

    #[tokio::test]
    async fn dialog_open_preserves_user_cancel_as_none() {
        let platform = FakePlatformServices::new();
        platform.dialog_fake().script_open_result(Ok(None));

        assert_eq!(
            desktop_dialog_open_with(&platform, raw_open_dialog_request())
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn dialog_open_preserves_channel_drop_error() {
        let platform = FakePlatformServices::new();
        platform
            .dialog_fake()
            .script_open_result(Err(PlatformError::new(
                "DESKTOP_DIALOG_OPEN_CANCELLED",
                PlatformOperation::DialogOpen,
                "dialog response channel dropped",
            )));

        assert_eq!(
            desktop_dialog_open_with(&platform, raw_open_dialog_request())
                .await
                .unwrap_err(),
            "DESKTOP_DIALOG_OPEN_CANCELLED: dialog response channel dropped"
        );
    }

    #[tokio::test]
    async fn dialog_save_preserves_user_cancel_as_none() {
        let platform = FakePlatformServices::new();
        platform.dialog_fake().script_save_result(Ok(None));

        assert_eq!(
            desktop_dialog_save_with(
                &platform,
                DesktopDialogSaveRequest {
                    title: None,
                    filters: None,
                    default_path: None,
                    can_create_directories: None,
                },
            )
            .await
            .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn opener_url_records_validated_url_and_program() {
        let platform = FakePlatformServices::new();
        platform.opener_fake().script_open_url_result(Ok(()));

        assert_eq!(
            desktop_opener_open_url_with(
                &platform,
                DesktopOpenUrlRequest {
                    url: "  https://example.com/path  ".to_string(),
                    with: Some("  browser  ".to_string()),
                },
            )
            .await,
            Ok(true)
        );
        let records = platform.journal().snapshot();
        assert!(matches!(
            &records[0].call,
            PlatformCall::OpenerOpenUrl { request }
                if request.url() == "https://example.com/path"
                    && request.program() == Some("browser")
        ));
    }

    #[tokio::test]
    async fn opener_path_rejects_sibling_prefix_before_service_call() {
        let platform = FakePlatformServices::new();
        let root = std::env::current_dir().unwrap().join("target/opener-root");
        let sibling = root.with_file_name("opener-root-other").join("file.txt");

        let error = desktop_opener_open_path_with(
            &platform,
            DesktopOpenPathRequest {
                path: sibling.to_string_lossy().into_owned(),
                with: None,
            },
            vec![root],
        )
        .await
        .unwrap_err();

        assert!(error.starts_with("DESKTOP_OPEN_PATH_DENIED:"));
        assert!(platform.journal().snapshot().is_empty());
    }

    #[tokio::test]
    async fn opener_reveal_records_authorized_path() {
        let platform = FakePlatformServices::new();
        platform.opener_fake().script_reveal_item_result(Ok(()));
        let root = std::env::current_dir()
            .unwrap()
            .join("target/opener-reveal-root");
        let child = root.join("nested/file.txt");

        assert_eq!(
            desktop_opener_reveal_item_with(
                &platform,
                DesktopRevealItemRequest {
                    path: child.to_string_lossy().into_owned(),
                },
                vec![root],
            )
            .await,
            Ok(true)
        );
        let records = platform.journal().snapshot();
        assert!(matches!(
            &records[0].call,
            PlatformCall::OpenerRevealItem { request } if request.path() == child
        ));
    }

    #[test]
    fn notification_permission_state_maps_all_four_variants() {
        let platform = FakePlatformServices::new();
        for state in [
            DesktopNotificationPermissionState::Granted,
            DesktopNotificationPermissionState::Denied,
            DesktopNotificationPermissionState::Prompt,
            DesktopNotificationPermissionState::PromptWithRationale,
        ] {
            platform
                .notification_fake()
                .script_permission_state_result(Ok(state));
        }

        assert_eq!(
            desktop_notification_is_permission_granted_with(&platform),
            Ok(true)
        );
        assert_eq!(
            desktop_notification_is_permission_granted_with(&platform),
            Ok(false)
        );
        assert_eq!(
            desktop_notification_is_permission_granted_with(&platform),
            Ok(false)
        );
        assert_eq!(
            desktop_notification_is_permission_granted_with(&platform),
            Ok(false)
        );
    }

    #[test]
    fn notification_request_permission_returns_scripted_state() {
        let platform = FakePlatformServices::new();
        platform
            .notification_fake()
            .script_request_permission_result(Ok(DesktopNotificationPermissionState::Prompt));

        assert_eq!(
            desktop_notification_request_permission_with(&platform),
            Ok(DesktopNotificationPermissionState::Prompt)
        );
    }

    #[test]
    fn notification_notify_records_normalized_payload() {
        let platform = FakePlatformServices::new();
        platform.notification_fake().script_notify_result(Ok(()));

        assert_eq!(
            desktop_notification_notify_with(
                &platform,
                DesktopNotificationPayload {
                    title: "  Title  ".to_string(),
                    body: "  Body  ".to_string(),
                    sound: Some("  ping  ".to_string()),
                },
            ),
            Ok(true)
        );
        let records = platform.journal().snapshot();
        assert!(matches!(
            &records[0].call,
            PlatformCall::NotificationNotify { notification }
                if notification.title() == "Title"
                    && notification.body() == "Body"
                    && notification.sound() == Some("ping")
        ));
    }

    #[test]
    fn notification_play_sound_uses_service() {
        let platform = FakePlatformServices::new();
        platform
            .notification_fake()
            .script_play_sound_result(Ok(()));

        assert_eq!(desktop_notification_play_sound_with(&platform), Ok(true));
        assert!(matches!(
            platform.journal().snapshot()[0].call,
            PlatformCall::NotificationPlaySound
        ));
    }

    #[test]
    fn notification_backend_prefixes_remain_stable() {
        let platform = FakePlatformServices::new();
        platform
            .notification_fake()
            .script_permission_state_result(Err(PlatformError::new(
                "NOTIFICATION_PERMISSION_READ_FAILED",
                PlatformOperation::NotificationPermissionState,
                "read detail",
            )));
        platform
            .notification_fake()
            .script_request_permission_result(Err(PlatformError::new(
                "NOTIFICATION_PERMISSION_REQUEST_FAILED",
                PlatformOperation::NotificationRequestPermission,
                "request detail",
            )));
        platform
            .notification_fake()
            .script_notify_result(Err(PlatformError::new(
                "NOTIFICATION_SHOW_FAILED",
                PlatformOperation::NotificationNotify,
                "show detail",
            )));
        platform
            .notification_fake()
            .script_play_sound_result(Err(PlatformError::new(
                "NOTIFICATION_SOUND_FAILED",
                PlatformOperation::NotificationPlaySound,
                "NOTIFICATION_SOUND_THREAD_SPAWN_FAILED: sound detail",
            )));

        assert_eq!(
            desktop_notification_is_permission_granted_with(&platform).unwrap_err(),
            "failed to read notification permission: read detail"
        );
        assert_eq!(
            desktop_notification_request_permission_with(&platform).unwrap_err(),
            "failed to request notification permission: request detail"
        );
        assert_eq!(
            desktop_notification_notify_with(
                &platform,
                DesktopNotificationPayload {
                    title: "Title".to_string(),
                    body: "Body".to_string(),
                    sound: None,
                },
            )
            .unwrap_err(),
            "failed to show desktop notification: show detail"
        );
        assert_eq!(
            desktop_notification_play_sound_with(&platform).unwrap_err(),
            "NOTIFICATION_SOUND_THREAD_SPAWN_FAILED: sound detail"
        );
    }

    #[test]
    fn clipboard_command_records_normalized_text_and_returns_true() {
        let platform = FakePlatformServices::new();
        platform.clipboard_fake().script_result(Ok(()));

        assert_eq!(
            desktop_clipboard_write_text_with(&platform, "  copied text  ".to_string()),
            Ok(true)
        );
        let records = platform.journal().snapshot();
        assert!(matches!(
            &records[0].call,
            PlatformCall::ClipboardWriteText { text } if text.as_str() == "copied text"
        ));
    }

    #[test]
    fn clipboard_command_preserves_empty_text_error() {
        let platform = FakePlatformServices::new();

        assert_eq!(
            desktop_clipboard_write_text_with(&platform, " \n ".to_string()).unwrap_err(),
            "CLIPBOARD_EMPTY_TEXT: text cannot be empty"
        );
        assert!(platform.journal().snapshot().is_empty());
    }

    #[test]
    fn clipboard_command_preserves_unprefixed_backend_error() {
        let platform = FakePlatformServices::new();
        platform
            .clipboard_fake()
            .script_result(Err(PlatformError::new(
                "CLIPBOARD_BACKEND_FAILED",
                PlatformOperation::ClipboardWriteText,
                "backend detail",
            )));

        assert_eq!(
            desktop_clipboard_write_text_with(&platform, "text".to_string()).unwrap_err(),
            "failed to write clipboard text: backend detail"
        );
    }

    #[derive(Default)]
    struct EnvRestore {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvRestore {
        fn save_once(&mut self, key: &'static str) {
            if self.saved.iter().any(|(saved_key, _)| *saved_key == key) {
                return;
            }
            self.saved.push((key, std::env::var_os(key)));
        }

        fn set_var(&mut self, key: &'static str, value: impl Into<OsString>) {
            self.save_once(key);
            std::env::set_var(key, value.into());
        }

        fn remove_var(&mut self, key: &'static str) {
            self.save_once(key);
            std::env::remove_var(key);
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.saved.drain(..).rev() {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    struct DesktopCommandTestApp {
        #[allow(dead_code)]
        env_restore: EnvRestore,
        #[allow(dead_code)]
        env_lock: std::sync::MutexGuard<'static, ()>,
        #[allow(dead_code)]
        home_dir: tempfile::TempDir,
        app: tauri::App<tauri::test::MockRuntime>,
    }

    impl DesktopCommandTestApp {
        fn new() -> Self {
            let env_lock = test_env_lock();
            let home_dir = tempfile::tempdir().expect("tempdir");
            let seq = TEST_ENV_SEQ.fetch_add(1, Ordering::Relaxed);
            let mut env_restore = EnvRestore::default();
            env_restore.set_var(
                "AIO_CODING_HUB_HOME_DIR",
                home_dir.path().as_os_str().to_os_string(),
            );
            env_restore.set_var(
                "AIO_CODING_HUB_DOTDIR_NAME",
                format!(".aio-coding-hub-desktop-test-{seq}"),
            );
            env_restore.remove_var("AIO_CODING_HUB_TEST_HOME");
            clear_settings_cache();

            Self {
                env_lock,
                env_restore,
                home_dir,
                app: tauri::test::mock_app(),
            }
        }

        fn handle(&self) -> tauri::AppHandle<tauri::test::MockRuntime> {
            self.app.handle().clone()
        }
    }

    fn write_custom_codex_home<R: tauri::Runtime>(app: &tauri::AppHandle<R>, custom_home: &Path) {
        let settings = AppSettings {
            codex_home_mode: CodexHomeMode::Custom,
            codex_home_override: custom_home.display().to_string(),
            ..AppSettings::default()
        };
        settings::write(app, &settings).expect("write settings");
    }

    #[test]
    fn desktop_open_allowed_roots_include_custom_codex_home() {
        let test_app = DesktopCommandTestApp::new();
        let app_handle = test_app.handle();
        let custom_home = test_app.home_dir.path().join("custom-codex-home");
        write_custom_codex_home(&app_handle, &custom_home);

        let allowed_roots = desktop_open_allowed_roots(&app_handle).expect("allowed roots");

        assert!(allowed_roots.contains(&normalize_existing_path(custom_home)));
    }

    #[test]
    fn desktop_open_path_allows_paths_under_custom_codex_home() {
        let test_app = DesktopCommandTestApp::new();
        let app_handle = test_app.handle();
        let custom_home = test_app.home_dir.path().join("custom-codex-home");
        write_custom_codex_home(&app_handle, &custom_home);

        let config_path = custom_home.join("config.toml");

        assert!(ensure_desktop_open_path_allowed(&app_handle, &config_path).is_ok());
    }
}
