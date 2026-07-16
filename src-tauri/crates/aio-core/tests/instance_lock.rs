use aio_core::{
    AppPathOverrides, AppPathRoots, AppPaths, InstanceGuard, InstanceLockError,
    INSTANCE_LOCK_FILE_NAME,
};
use std::path::Path;

fn paths(home: &Path, dotdir: &str) -> AppPaths {
    AppPaths::resolve(
        AppPathRoots {
            platform_home: home.to_path_buf(),
            resource_dir: home.join("resources"),
        },
        AppPathOverrides {
            dotdir_name: Some(dotdir.to_string()),
            ..AppPathOverrides::default()
        },
    )
    .expect("resolve test app paths")
}

fn assert_already_running(error: InstanceLockError, expected_data_dir: &Path) {
    match error {
        InstanceLockError::AlreadyRunning { data_dir } => {
            assert_eq!(data_dir, expected_data_dir);
        }
        other => panic!("expected already-running error, got {other:?}"),
    }
}

#[test]
fn same_data_directory_allows_only_one_owner() {
    let home = tempfile::tempdir().expect("home tempdir");
    let paths = paths(home.path(), ".same-owner");
    let first = InstanceGuard::try_acquire(&paths).expect("first owner");

    let error = InstanceGuard::try_acquire(&paths).expect_err("second owner must be rejected");
    assert_already_running(error, first.data_dir());
    assert_eq!(
        first.lock_path(),
        first.data_dir().join(INSTANCE_LOCK_FILE_NAME)
    );
}

#[test]
fn distinct_data_directories_can_run_concurrently() {
    let home = tempfile::tempdir().expect("home tempdir");
    let first_paths = paths(home.path(), ".first-owner");
    let second_paths = paths(home.path(), ".second-owner");

    let first = InstanceGuard::try_acquire(&first_paths).expect("first directory owner");
    let second = InstanceGuard::try_acquire(&second_paths).expect("second directory owner");

    assert_ne!(first.data_dir(), second.data_dir());
}

#[test]
fn canonical_aliases_contend_for_the_same_lock() {
    let home = tempfile::tempdir().expect("home tempdir");
    let canonical_paths = paths(home.path(), ".canonical-owner");
    let alias_home = canonical_paths.data_dir().join("..");
    let alias_paths = paths(&alias_home, ".canonical-owner");
    let first = InstanceGuard::try_acquire(&canonical_paths).expect("canonical owner");

    let error = InstanceGuard::try_acquire(&alias_paths).expect_err("alias owner must conflict");
    assert_already_running(error, first.data_dir());
}

#[test]
fn dropping_guard_releases_the_lock() {
    let home = tempfile::tempdir().expect("home tempdir");
    let paths = paths(home.path(), ".drop-owner");

    let first = InstanceGuard::try_acquire(&paths).expect("first owner");
    drop(first);

    InstanceGuard::try_acquire(&paths).expect("owner after drop");
}
