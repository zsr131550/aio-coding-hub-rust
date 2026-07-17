use aio_platform::{
    DesktopNotificationPermissionState, Notification, NotificationService, PlatformError,
    PlatformOperation, PlatformResult,
};
use tauri_plugin_notification::NotificationExt;

pub(crate) struct TauriNotificationService<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriNotificationService<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

fn permission_state(
    state: tauri_plugin_notification::PermissionState,
) -> DesktopNotificationPermissionState {
    match state {
        tauri_plugin_notification::PermissionState::Granted => {
            DesktopNotificationPermissionState::Granted
        }
        tauri_plugin_notification::PermissionState::Denied => {
            DesktopNotificationPermissionState::Denied
        }
        tauri_plugin_notification::PermissionState::Prompt => {
            DesktopNotificationPermissionState::Prompt
        }
        tauri_plugin_notification::PermissionState::PromptWithRationale => {
            DesktopNotificationPermissionState::PromptWithRationale
        }
    }
}

impl<R: tauri::Runtime> NotificationService for TauriNotificationService<R> {
    fn permission_state(&self) -> PlatformResult<DesktopNotificationPermissionState> {
        self.app
            .notification()
            .permission_state()
            .map(permission_state)
            .map_err(|error| {
                PlatformError::new(
                    "NOTIFICATION_PERMISSION_READ_FAILED",
                    PlatformOperation::NotificationPermissionState,
                    error.to_string(),
                )
            })
    }

    fn request_permission(&self) -> PlatformResult<DesktopNotificationPermissionState> {
        self.app
            .notification()
            .request_permission()
            .map(permission_state)
            .map_err(|error| {
                PlatformError::new(
                    "NOTIFICATION_PERMISSION_REQUEST_FAILED",
                    PlatformOperation::NotificationRequestPermission,
                    error.to_string(),
                )
            })
    }

    fn notify(&self, notification: Notification) -> PlatformResult<()> {
        let mut builder = self
            .app
            .notification()
            .builder()
            .title(notification.title().to_string())
            .body(notification.body().to_string());
        if let Some(sound) = notification.sound() {
            builder = builder.sound(sound.to_string());
        }

        builder.show().map_err(|error| {
            PlatformError::new(
                "NOTIFICATION_SHOW_FAILED",
                PlatformOperation::NotificationNotify,
                error.to_string(),
            )
        })
    }

    fn play_sound(&self) -> PlatformResult<()> {
        crate::app::notification_sound::play_notification_sound().map_err(|error| {
            PlatformError::new(
                "NOTIFICATION_SOUND_FAILED",
                PlatformOperation::NotificationPlaySound,
                error,
            )
        })
    }
}
