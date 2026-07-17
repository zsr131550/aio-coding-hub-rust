use std::sync::Arc;

use crate::{
    DesktopNotificationPermissionState, Notification, NotificationService, PlatformOperation,
    PlatformResult,
};

use super::{CallJournal, PlatformCall, Script};

pub struct FakeNotificationService {
    journal: Arc<CallJournal>,
    permission_state_results: Script<DesktopNotificationPermissionState>,
    request_permission_results: Script<DesktopNotificationPermissionState>,
    notify_results: Script<()>,
    play_sound_results: Script<()>,
}

impl FakeNotificationService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            permission_state_results: Script::new(PlatformOperation::NotificationPermissionState),
            request_permission_results: Script::new(
                PlatformOperation::NotificationRequestPermission,
            ),
            notify_results: Script::new(PlatformOperation::NotificationNotify),
            play_sound_results: Script::new(PlatformOperation::NotificationPlaySound),
        }
    }

    pub fn script_permission_state_result(
        &self,
        result: PlatformResult<DesktopNotificationPermissionState>,
    ) {
        self.permission_state_results.push(result);
    }

    pub fn script_request_permission_result(
        &self,
        result: PlatformResult<DesktopNotificationPermissionState>,
    ) {
        self.request_permission_results.push(result);
    }

    pub fn script_notify_result(&self, result: PlatformResult<()>) {
        self.notify_results.push(result);
    }

    pub fn script_play_sound_result(&self, result: PlatformResult<()>) {
        self.play_sound_results.push(result);
    }
}

impl NotificationService for FakeNotificationService {
    fn permission_state(&self) -> PlatformResult<DesktopNotificationPermissionState> {
        self.journal
            .record(PlatformCall::NotificationPermissionState);
        self.permission_state_results.pop()
    }

    fn request_permission(&self) -> PlatformResult<DesktopNotificationPermissionState> {
        self.journal
            .record(PlatformCall::NotificationRequestPermission);
        self.request_permission_results.pop()
    }

    fn notify(&self, notification: Notification) -> PlatformResult<()> {
        self.journal
            .record(PlatformCall::NotificationNotify { notification });
        self.notify_results.pop()
    }

    fn play_sound(&self) -> PlatformResult<()> {
        self.journal.record(PlatformCall::NotificationPlaySound);
        self.play_sound_results.pop()
    }
}
