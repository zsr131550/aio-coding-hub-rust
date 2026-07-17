use std::sync::Arc;

use crate::{
    PlatformFuture, PlatformOperation, PlatformResult, UpdateCheckRequest, UpdateInstallRequest,
    UpdateMetadata, UpdateProgressEvent, UpdateProgressSink, UpdateService,
};

use super::{CallJournal, PlatformCall, Script};

fn timeout_millis(timeout: Option<std::time::Duration>) -> Option<u64> {
    timeout.map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
}

pub struct ScriptedUpdateInstall {
    progress: Vec<UpdateProgressEvent>,
    result: PlatformResult<()>,
}

pub struct FakeUpdateService {
    journal: Arc<CallJournal>,
    check_results: Script<Option<UpdateMetadata>>,
    install_results: Script<ScriptedUpdateInstall>,
}

impl FakeUpdateService {
    pub fn new(journal: Arc<CallJournal>) -> Self {
        Self {
            journal,
            check_results: Script::new(PlatformOperation::UpdateCheck),
            install_results: Script::new(PlatformOperation::UpdateDownloadAndInstall),
        }
    }

    pub fn script_check_result(&self, result: PlatformResult<Option<UpdateMetadata>>) {
        self.check_results.push(result);
    }

    pub fn script_install_result(
        &self,
        progress: Vec<UpdateProgressEvent>,
        result: PlatformResult<()>,
    ) {
        self.install_results
            .push(Ok(ScriptedUpdateInstall { progress, result }));
    }

    pub fn script_install_error(&self, error: crate::PlatformError) {
        self.install_results.push(Err(error));
    }
}

impl UpdateService for FakeUpdateService {
    fn check(&self, request: UpdateCheckRequest) -> PlatformFuture<'_, Option<UpdateMetadata>> {
        self.journal.record(PlatformCall::UpdateCheck {
            timeout_ms: timeout_millis(request.timeout()),
            cancelled: request.cancellation().is_cancelled(),
        });
        let result = self.check_results.pop();
        Box::pin(async move { result })
    }

    fn download_and_install(
        &self,
        request: UpdateInstallRequest,
        progress: Arc<dyn UpdateProgressSink>,
    ) -> PlatformFuture<'_, ()> {
        self.journal.record(PlatformCall::UpdateDownloadAndInstall {
            id: request.id(),
            timeout_ms: timeout_millis(request.timeout()),
            cancelled: request.cancellation().is_cancelled(),
        });
        let scripted = self.install_results.pop();

        Box::pin(async move {
            let scripted = scripted?;
            for event in scripted.progress {
                progress.publish(event)?;
            }
            scripted.result
        })
    }
}
