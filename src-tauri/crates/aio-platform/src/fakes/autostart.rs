use std::sync::Arc;

use crate::{AutostartService, PlatformOperation, PlatformResult};

use super::{CallJournal, PlatformCall, Script};

pub struct FakeAutostartService {
    journal: Arc<CallJournal>,
    results: Script<()>,
}

impl FakeAutostartService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            results: Script::new(PlatformOperation::AutostartSetEnabled),
        }
    }

    pub fn script_result(&self, result: PlatformResult<()>) {
        self.results.push(result);
    }

    pub fn remaining_results(&self) -> usize {
        self.results.len()
    }
}

impl AutostartService for FakeAutostartService {
    fn set_enabled(&self, enabled: bool) -> PlatformResult<()> {
        self.journal
            .record(PlatformCall::AutostartSetEnabled { enabled });
        self.results.pop()
    }
}
