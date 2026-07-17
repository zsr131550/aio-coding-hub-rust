mod autostart;
mod clipboard;
mod dialog;
mod journal;
mod notification;
mod opener;
mod script;
mod updater;

use std::sync::Arc;

use crate::{
    AutostartService, ClipboardService, DialogService, NotificationService, OpenerService,
    PlatformServices, UpdateService,
};

pub use autostart::FakeAutostartService;
pub use clipboard::FakeClipboardService;
pub use dialog::FakeDialogService;
pub use journal::{CallJournal, PlatformCall, PlatformCallRecord};
pub use notification::FakeNotificationService;
pub use opener::FakeOpenerService;
pub use script::Script;
pub use updater::{FakeUpdateService, ScriptedUpdateInstall};

pub struct FakePlatformServices {
    journal: Arc<CallJournal>,
    clipboard: Arc<FakeClipboardService>,
    dialogs: Arc<FakeDialogService>,
    opener: Arc<FakeOpenerService>,
    notifications: Arc<FakeNotificationService>,
    autostart: Arc<FakeAutostartService>,
    updater: Arc<FakeUpdateService>,
}

impl Default for FakePlatformServices {
    fn default() -> Self {
        Self::new()
    }
}

impl FakePlatformServices {
    pub fn new() -> Self {
        let journal = Arc::new(CallJournal::new());
        Self {
            clipboard: Arc::new(FakeClipboardService::new(journal.clone())),
            dialogs: Arc::new(FakeDialogService::new(journal.clone())),
            opener: Arc::new(FakeOpenerService::new(journal.clone())),
            notifications: Arc::new(FakeNotificationService::new(journal.clone())),
            autostart: Arc::new(FakeAutostartService::new(journal.clone())),
            updater: Arc::new(FakeUpdateService::new(journal.clone())),
            journal,
        }
    }

    pub fn journal(&self) -> &Arc<CallJournal> {
        &self.journal
    }

    pub fn clipboard_fake(&self) -> &FakeClipboardService {
        self.clipboard.as_ref()
    }

    pub fn dialog_fake(&self) -> &FakeDialogService {
        self.dialogs.as_ref()
    }

    pub fn opener_fake(&self) -> &FakeOpenerService {
        self.opener.as_ref()
    }

    pub fn notification_fake(&self) -> &FakeNotificationService {
        self.notifications.as_ref()
    }

    pub fn autostart_fake(&self) -> &FakeAutostartService {
        self.autostart.as_ref()
    }

    pub fn updater_fake(&self) -> &FakeUpdateService {
        self.updater.as_ref()
    }
}

impl PlatformServices for FakePlatformServices {
    fn clipboard(&self) -> &dyn ClipboardService {
        self.clipboard.as_ref()
    }

    fn dialogs(&self) -> &dyn DialogService {
        self.dialogs.as_ref()
    }

    fn opener(&self) -> &dyn OpenerService {
        self.opener.as_ref()
    }

    fn notifications(&self) -> &dyn NotificationService {
        self.notifications.as_ref()
    }

    fn autostart(&self) -> &dyn AutostartService {
        self.autostart.as_ref()
    }

    fn updater(&self) -> &dyn UpdateService {
        self.updater.as_ref()
    }
}
