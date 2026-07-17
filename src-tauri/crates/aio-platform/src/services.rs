use std::sync::Arc;

use crate::{
    AutostartService, ClipboardService, DialogService, NotificationService, OpenerService,
    UpdateService,
};

pub trait PlatformServices: Send + Sync {
    fn clipboard(&self) -> &dyn ClipboardService;

    fn dialogs(&self) -> &dyn DialogService;

    fn opener(&self) -> &dyn OpenerService;

    fn notifications(&self) -> &dyn NotificationService;

    fn autostart(&self) -> &dyn AutostartService;

    fn updater(&self) -> &dyn UpdateService;
}

#[derive(Clone)]
pub struct PlatformServiceSet {
    clipboard: Arc<dyn ClipboardService>,
    dialogs: Arc<dyn DialogService>,
    opener: Arc<dyn OpenerService>,
    notifications: Arc<dyn NotificationService>,
    autostart: Arc<dyn AutostartService>,
    updater: Arc<dyn UpdateService>,
}

impl PlatformServiceSet {
    pub fn new(
        clipboard: Arc<dyn ClipboardService>,
        dialogs: Arc<dyn DialogService>,
        opener: Arc<dyn OpenerService>,
        notifications: Arc<dyn NotificationService>,
        autostart: Arc<dyn AutostartService>,
        updater: Arc<dyn UpdateService>,
    ) -> Self {
        Self {
            clipboard,
            dialogs,
            opener,
            notifications,
            autostart,
            updater,
        }
    }
}

impl PlatformServices for PlatformServiceSet {
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
