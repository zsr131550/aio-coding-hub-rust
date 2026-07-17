use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{PlatformError, PlatformOperation, PlatformResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DesktopNotificationPayload {
    pub title: String,
    pub body: String,
    pub sound: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopNotificationPermissionState {
    Granted,
    Denied,
    Prompt,
    PromptWithRationale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    title: String,
    body: String,
    sound: Option<String>,
}

impl Notification {
    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn sound(&self) -> Option<&str> {
        self.sound.as_deref()
    }
}

impl TryFrom<DesktopNotificationPayload> for Notification {
    type Error = PlatformError;

    fn try_from(payload: DesktopNotificationPayload) -> PlatformResult<Self> {
        let title = crate::validation::trim_to_non_empty(&payload.title, 256).ok_or_else(|| {
            PlatformError::new(
                "NOTICE_INVALID_TITLE",
                PlatformOperation::NotificationNotify,
                "title cannot be empty",
            )
        })?;
        let body = crate::validation::trim_to_non_empty(&payload.body, 4_096).ok_or_else(|| {
            PlatformError::new(
                "NOTICE_INVALID_BODY",
                PlatformOperation::NotificationNotify,
                "body cannot be empty",
            )
        })?;
        let sound = payload
            .sound
            .and_then(|value| crate::validation::trim_to_non_empty(&value, 128));

        Ok(Self { title, body, sound })
    }
}

pub trait NotificationService: Send + Sync {
    fn permission_state(&self) -> PlatformResult<DesktopNotificationPermissionState>;

    fn request_permission(&self) -> PlatformResult<DesktopNotificationPermissionState>;

    fn notify(&self, notification: Notification) -> PlatformResult<()>;

    fn play_sound(&self) -> PlatformResult<()>;
}
