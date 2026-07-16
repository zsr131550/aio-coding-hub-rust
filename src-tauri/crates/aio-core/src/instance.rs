use crate::AppPaths;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

pub const INSTANCE_LOCK_FILE_NAME: &str = ".instance.lock";

#[derive(Debug, thiserror::Error)]
pub enum InstanceLockError {
    #[error("failed to canonicalize application data directory {path}: {source}")]
    CanonicalizeDataDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open application instance lock {path}: {source}")]
    OpenLockFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("APP_ALREADY_RUNNING: application data directory is already owned: {data_dir}")]
    AlreadyRunning { data_dir: PathBuf },
    #[error("failed to acquire application instance lock {path}: {source}")]
    AcquireLock {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug)]
pub struct InstanceGuard {
    _file: File,
    data_dir: PathBuf,
    lock_path: PathBuf,
}

impl InstanceGuard {
    pub fn try_acquire(paths: &AppPaths) -> Result<Self, InstanceLockError> {
        let data_dir = std::fs::canonicalize(paths.data_dir()).map_err(|source| {
            InstanceLockError::CanonicalizeDataDir {
                path: paths.data_dir().to_path_buf(),
                source,
            }
        })?;
        let lock_path = data_dir.join(INSTANCE_LOCK_FILE_NAME);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|source| InstanceLockError::OpenLockFile {
                path: lock_path.clone(),
                source,
            })?;

        match file.try_lock() {
            Ok(()) => Ok(Self {
                _file: file,
                data_dir,
                lock_path,
            }),
            Err(TryLockError::WouldBlock) => Err(InstanceLockError::AlreadyRunning { data_dir }),
            Err(TryLockError::Error(source)) => Err(InstanceLockError::AcquireLock {
                path: lock_path,
                source,
            }),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}
