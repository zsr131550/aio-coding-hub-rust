use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type PlatformResult<T> = Result<T, PlatformError>;

pub type PlatformFuture<'a, T> = Pin<Box<dyn Future<Output = PlatformResult<T>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformOperation {
    ClipboardWriteText,
    DialogOpen,
    DialogSave,
    OpenerOpenUrl,
    OpenerOpenPath,
    OpenerRevealItem,
    NotificationPermissionState,
    NotificationRequestPermission,
    NotificationNotify,
    NotificationPlaySound,
    AutostartSetEnabled,
    UpdateCheck,
    UpdateDownloadAndInstall,
    UpdateProgress,
}

impl PlatformOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClipboardWriteText => "clipboard_write_text",
            Self::DialogOpen => "dialog_open",
            Self::DialogSave => "dialog_save",
            Self::OpenerOpenUrl => "opener_open_url",
            Self::OpenerOpenPath => "opener_open_path",
            Self::OpenerRevealItem => "opener_reveal_item",
            Self::NotificationPermissionState => "notification_permission_state",
            Self::NotificationRequestPermission => "notification_request_permission",
            Self::NotificationNotify => "notification_notify",
            Self::NotificationPlaySound => "notification_play_sound",
            Self::AutostartSetEnabled => "autostart_set_enabled",
            Self::UpdateCheck => "update_check",
            Self::UpdateDownloadAndInstall => "update_download_and_install",
            Self::UpdateProgress => "update_progress",
        }
    }
}

impl fmt::Display for PlatformOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct PlatformError {
    code: &'static str,
    operation: PlatformOperation,
    message: String,
    #[source]
    source: Option<Arc<dyn Error + Send + Sync>>,
}

impl PlatformError {
    pub fn new(
        code: &'static str,
        operation: PlatformOperation,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            operation,
            message: message.into(),
            source: None,
        }
    }

    pub fn backend<E>(
        code: &'static str,
        operation: PlatformOperation,
        message: impl Into<String>,
        source: E,
    ) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            code,
            operation,
            message: message.into(),
            source: Some(Arc::new(source)),
        }
    }

    pub fn cancelled(operation: PlatformOperation) -> Self {
        Self::new(
            "PLATFORM_OPERATION_CANCELLED",
            operation,
            format!("{operation} was cancelled"),
        )
    }

    pub fn timeout(operation: PlatformOperation) -> Self {
        Self::new(
            "PLATFORM_OPERATION_TIMEOUT",
            operation,
            format!("{operation} timed out"),
        )
    }

    pub fn disabled(operation: PlatformOperation) -> Self {
        Self::new(
            "PLATFORM_OPERATION_DISABLED",
            operation,
            format!("{operation} is disabled"),
        )
    }

    pub fn unscripted(operation: PlatformOperation) -> Self {
        Self::new(
            "UNSCRIPTED_PLATFORM_CALL",
            operation,
            format!("no scripted result for {operation}"),
        )
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub const fn operation(&self) -> PlatformOperation {
        self.operation
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}
