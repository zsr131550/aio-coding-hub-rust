//! Runtime-neutral contracts for desktop platform capabilities.

mod autostart;
mod cancellation;
mod clipboard;
mod dialog;
mod error;
pub mod fakes;
mod notification;
mod opener;
mod services;
mod updater;
mod validation;

pub use autostart::AutostartService;
pub use cancellation::CancellationToken;
pub use clipboard::{ClipboardService, ClipboardText};
pub use dialog::{
    DesktopDialogFileAccessMode, DesktopDialogFilter, DesktopDialogOpenRequest,
    DesktopDialogPickerMode, DesktopDialogSaveRequest, DialogFilter, DialogOpenRequest, DialogPath,
    DialogSaveRequest, DialogService,
};
pub use error::{PlatformError, PlatformFuture, PlatformOperation, PlatformResult};
pub use notification::{
    DesktopNotificationPayload, DesktopNotificationPermissionState, Notification,
    NotificationService,
};
pub use opener::{
    AuthorizedOpenPath, AuthorizedRevealPath, DesktopOpenPathRequest, DesktopOpenUrlRequest,
    DesktopRevealItemRequest, OpenPathCandidate, OpenPathPolicy, OpenUrlRequest, OpenerService,
    RevealPathCandidate,
};
pub use services::{PlatformServiceSet, PlatformServices};
pub use updater::{
    DesktopUpdaterMetadata, UpdateCheckRequest, UpdateId, UpdateInstallRequest, UpdateMetadata,
    UpdateProgressEvent, UpdateProgressSink, UpdateService,
};
