use std::sync::Arc;

use crate::{
    AuthorizedOpenPath, AuthorizedRevealPath, OpenUrlRequest, OpenerService, PlatformFuture,
    PlatformOperation, PlatformResult,
};

use super::{CallJournal, PlatformCall, Script};

pub struct FakeOpenerService {
    journal: Arc<CallJournal>,
    open_url_results: Script<()>,
    open_path_results: Script<()>,
    reveal_item_results: Script<()>,
}

impl FakeOpenerService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            open_url_results: Script::new(PlatformOperation::OpenerOpenUrl),
            open_path_results: Script::new(PlatformOperation::OpenerOpenPath),
            reveal_item_results: Script::new(PlatformOperation::OpenerRevealItem),
        }
    }

    pub fn script_open_url_result(&self, result: PlatformResult<()>) {
        self.open_url_results.push(result);
    }

    pub fn script_open_path_result(&self, result: PlatformResult<()>) {
        self.open_path_results.push(result);
    }

    pub fn script_reveal_item_result(&self, result: PlatformResult<()>) {
        self.reveal_item_results.push(result);
    }
}

impl OpenerService for FakeOpenerService {
    fn open_url(&self, request: OpenUrlRequest) -> PlatformFuture<'_, ()> {
        self.journal.record(PlatformCall::OpenerOpenUrl { request });
        let result = self.open_url_results.pop();
        Box::pin(async move { result })
    }

    fn open_path(&self, request: AuthorizedOpenPath) -> PlatformFuture<'_, ()> {
        self.journal
            .record(PlatformCall::OpenerOpenPath { request });
        let result = self.open_path_results.pop();
        Box::pin(async move { result })
    }

    fn reveal_item(&self, request: AuthorizedRevealPath) -> PlatformFuture<'_, ()> {
        self.journal
            .record(PlatformCall::OpenerRevealItem { request });
        let result = self.reveal_item_results.pop();
        Box::pin(async move { result })
    }
}
