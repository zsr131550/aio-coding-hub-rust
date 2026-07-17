use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{CancellationToken, PlatformFuture, PlatformResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct UpdateId(u32);

impl UpdateId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateMetadata {
    pub id: UpdateId,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdaterMetadata {
    pub rid: u32,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

impl From<UpdateMetadata> for DesktopUpdaterMetadata {
    fn from(metadata: UpdateMetadata) -> Self {
        Self {
            rid: metadata.id.get(),
            current_version: metadata.current_version,
            version: metadata.version,
            date: metadata.date,
            body: metadata.body,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateCheckRequest {
    timeout: Option<Duration>,
    cancellation: CancellationToken,
}

impl UpdateCheckRequest {
    pub fn new(timeout: Option<Duration>, cancellation: CancellationToken) -> Self {
        Self {
            timeout,
            cancellation,
        }
    }

    pub const fn timeout(&self) -> Option<Duration> {
        self.timeout
    }

    pub const fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }
}

#[derive(Debug, Clone)]
pub struct UpdateInstallRequest {
    id: UpdateId,
    timeout: Option<Duration>,
    cancellation: CancellationToken,
}

impl UpdateInstallRequest {
    pub fn new(id: UpdateId, timeout: Option<Duration>, cancellation: CancellationToken) -> Self {
        Self {
            id,
            timeout,
            cancellation,
        }
    }

    pub const fn id(&self) -> UpdateId {
        self.id
    }

    pub const fn timeout(&self) -> Option<Duration> {
        self.timeout
    }

    pub const fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateProgressEvent {
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Finished,
}

pub trait UpdateProgressSink: Send + Sync {
    fn publish(&self, event: UpdateProgressEvent) -> PlatformResult<()>;
}

pub trait UpdateService: Send + Sync {
    fn check(&self, request: UpdateCheckRequest) -> PlatformFuture<'_, Option<UpdateMetadata>>;

    fn download_and_install(
        &self,
        request: UpdateInstallRequest,
        progress: Arc<dyn UpdateProgressSink>,
    ) -> PlatformFuture<'_, ()>;
}
