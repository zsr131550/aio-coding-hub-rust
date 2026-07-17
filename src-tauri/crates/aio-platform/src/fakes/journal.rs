use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::{
    AuthorizedOpenPath, AuthorizedRevealPath, ClipboardText, DialogOpenRequest, DialogSaveRequest,
    Notification, OpenUrlRequest, UpdateId,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformCall {
    ClipboardWriteText {
        text: ClipboardText,
    },
    DialogOpen {
        request: DialogOpenRequest,
    },
    DialogSave {
        request: DialogSaveRequest,
    },
    OpenerOpenUrl {
        request: OpenUrlRequest,
    },
    OpenerOpenPath {
        request: AuthorizedOpenPath,
    },
    OpenerRevealItem {
        request: AuthorizedRevealPath,
    },
    NotificationPermissionState,
    NotificationRequestPermission,
    NotificationNotify {
        notification: Notification,
    },
    NotificationPlaySound,
    AutostartSetEnabled {
        enabled: bool,
    },
    UpdateCheck {
        timeout_ms: Option<u64>,
        cancelled: bool,
    },
    UpdateDownloadAndInstall {
        id: UpdateId,
        timeout_ms: Option<u64>,
        cancelled: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformCallRecord {
    pub sequence: u64,
    pub call: PlatformCall,
}

#[derive(Debug)]
pub struct CallJournal {
    next: AtomicU64,
    records: Mutex<Vec<PlatformCallRecord>>,
}

impl Default for CallJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl CallJournal {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            records: Mutex::new(Vec::new()),
        }
    }

    pub fn record(&self, call: PlatformCall) -> u64 {
        let sequence = self.next.fetch_add(1, Ordering::SeqCst);
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(PlatformCallRecord { sequence, call });
        sequence
    }

    pub fn snapshot(&self) -> Vec<PlatformCallRecord> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn clear(&self) {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    #[doc(hidden)]
    pub fn poison_for_test(self: &Arc<Self>) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            panic!("poison fake platform call journal");
        }));
    }
}
