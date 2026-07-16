//! Usage: Adapt Tauri platform roots to the headless application path owner.

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

pub use aio_core::{AppPaths, APP_DOTDIR_NAME};

#[cfg(test)]
const APP_DOTDIR_NAME_ENV: &str = aio_core::APP_DOTDIR_NAME_ENV;
#[cfg(test)]
const TEST_HOME_DIR_ENV: &str = aio_core::TEST_HOME_DIR_ENV;

fn resolve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<AppPaths> {
    let platform_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve home dir: {error}"))?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve resource dir: {error}"))?;

    AppPaths::resolve(
        aio_core::AppPathRoots {
            platform_home,
            resource_dir,
        },
        aio_core::AppPathOverrides::from_env(),
    )
    .map_err(|error| error.to_string().into())
}

pub(crate) fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<Arc<AppPaths>> {
    if let Some(paths) = app.try_state::<Arc<AppPaths>>() {
        return Ok(Arc::clone(paths.inner()));
    }

    let paths = Arc::new(resolve(app)?);
    if app.manage(Arc::clone(&paths)) {
        return Ok(paths);
    }

    app.try_state::<Arc<AppPaths>>()
        .map(|state| Arc::clone(state.inner()))
        .ok_or_else(|| "failed to install application paths state".into())
}

pub(crate) fn get<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<Arc<AppPaths>> {
    install(app)
}

pub fn home_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(get(app)?.home().to_path_buf())
}

pub fn app_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(get(app)?.data_dir().to_path_buf())
}

pub(crate) fn plugin_id_path_segment(plugin_id: &str) -> crate::shared::error::AppResult<&str> {
    aio_core::plugin_id_path_segment(plugin_id).map_err(|error| error.to_string().into())
}

pub(crate) fn plugins_installed_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(get(app)?.plugins_installed_dir())
}

pub(crate) fn plugins_cache_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(get(app)?.plugins_cache_dir())
}

pub(crate) fn plugins_logs_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(get(app)?.plugins_logs_dir())
}

pub(crate) fn plugin_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
) -> crate::shared::error::AppResult<PathBuf> {
    get(app)?
        .plugin_data_dir(plugin_id)
        .map_err(|error| error.to_string().into())
}

#[cfg(test)]
mod plugin_path_tests {
    struct EnvGuard {
        key: &'static str,
        value: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self {
                key,
                value: previous,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.value.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn plugin_id_path_segment_rejects_traversal() {
        assert!(super::plugin_id_path_segment("../evil").is_err());
        assert!(super::plugin_id_path_segment("official/evil").is_err());
        assert!(super::plugin_id_path_segment("official\\evil").is_err());
        assert!(super::plugin_id_path_segment(".").is_err());
        assert!(super::plugin_id_path_segment("community.prompt-helper").is_ok());
    }

    #[test]
    fn installed_app_paths_are_stable_after_environment_changes() {
        let _env_lock = crate::test_support::test_env_lock();
        let home = tempfile::tempdir().expect("test home");
        let _test_home = EnvGuard::set(super::TEST_HOME_DIR_ENV, home.path());
        let _dotdir = EnvGuard::set(super::APP_DOTDIR_NAME_ENV, ".aio-paths-first");
        let app = tauri::test::mock_app();

        let installed = super::install(app.handle()).expect("install app paths");
        std::env::set_var(super::APP_DOTDIR_NAME_ENV, ".aio-paths-second");

        assert_eq!(
            super::app_data_dir(app.handle()).expect("managed app data dir"),
            installed.data_dir()
        );
        assert!(installed.data_dir().ends_with(".aio-paths-first"));
    }
}
