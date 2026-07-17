use std::sync::Arc;

use aio_platform::{
    PlatformError, PlatformFuture, PlatformOperation, UpdateCheckRequest, UpdateInstallRequest,
    UpdateMetadata, UpdateProgressSink, UpdateService,
};

pub(crate) struct DisabledTauriUpdateService;

impl UpdateService for DisabledTauriUpdateService {
    fn check(&self, _request: UpdateCheckRequest) -> PlatformFuture<'_, Option<UpdateMetadata>> {
        Box::pin(async { Ok(None) })
    }

    fn download_and_install(
        &self,
        _request: UpdateInstallRequest,
        _progress: Arc<dyn UpdateProgressSink>,
    ) -> PlatformFuture<'_, ()> {
        Box::pin(async {
            Err(PlatformError::new(
                "UPDATE_CHANNEL_DISABLED",
                PlatformOperation::UpdateDownloadAndInstall,
                "update channel is disabled",
            ))
        })
    }
}
