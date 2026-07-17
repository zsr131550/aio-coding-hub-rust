use std::sync::Arc;

use crate::{ClipboardService, ClipboardText, PlatformOperation, PlatformResult};

use super::{CallJournal, PlatformCall, Script};

pub struct FakeClipboardService {
    journal: Arc<CallJournal>,
    results: Script<()>,
}

impl FakeClipboardService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            results: Script::new(PlatformOperation::ClipboardWriteText),
        }
    }

    pub fn script_result(&self, result: PlatformResult<()>) {
        self.results.push(result);
    }

    pub fn remaining_results(&self) -> usize {
        self.results.len()
    }

    #[doc(hidden)]
    pub fn poison_script_for_test(&self) {
        self.results.poison_for_test();
    }
}

impl ClipboardService for FakeClipboardService {
    fn write_text(&self, text: ClipboardText) -> PlatformResult<()> {
        self.journal
            .record(PlatformCall::ClipboardWriteText { text });
        self.results.pop()
    }
}
