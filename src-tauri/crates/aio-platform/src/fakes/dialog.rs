use std::sync::Arc;

use crate::{
    DialogOpenRequest, DialogPath, DialogSaveRequest, DialogService, PlatformFuture,
    PlatformOperation, PlatformResult,
};

use super::{CallJournal, PlatformCall, Script};

pub struct FakeDialogService {
    journal: Arc<CallJournal>,
    open_results: Script<Option<Vec<DialogPath>>>,
    save_results: Script<Option<DialogPath>>,
}

impl FakeDialogService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            open_results: Script::new(PlatformOperation::DialogOpen),
            save_results: Script::new(PlatformOperation::DialogSave),
        }
    }

    pub fn script_open_result(&self, result: PlatformResult<Option<Vec<DialogPath>>>) {
        self.open_results.push(result);
    }

    pub fn script_save_result(&self, result: PlatformResult<Option<DialogPath>>) {
        self.save_results.push(result);
    }

    pub fn remaining_open_results(&self) -> usize {
        self.open_results.len()
    }

    pub fn remaining_save_results(&self) -> usize {
        self.save_results.len()
    }
}

impl DialogService for FakeDialogService {
    fn open(&self, request: DialogOpenRequest) -> PlatformFuture<'_, Option<Vec<DialogPath>>> {
        self.journal.record(PlatformCall::DialogOpen { request });
        let result = self.open_results.pop();
        Box::pin(async move { result })
    }

    fn save(&self, request: DialogSaveRequest) -> PlatformFuture<'_, Option<DialogPath>> {
        self.journal.record(PlatformCall::DialogSave { request });
        let result = self.save_results.pop();
        Box::pin(async move { result })
    }
}
