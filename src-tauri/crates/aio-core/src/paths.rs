use std::path::{Path, PathBuf};

pub const APP_DOTDIR_NAME: &str = ".aio-coding-hub";
pub const APP_DOTDIR_NAME_ENV: &str = "AIO_CODING_HUB_DOTDIR_NAME";
pub const TEST_HOME_DIR_ENV: &str = "AIO_CODING_HUB_TEST_HOME";
pub const HOME_DIR_OVERRIDE_ENV: &str = "AIO_CODING_HUB_HOME_DIR";

pub const DATABASE_FILE_NAME: &str = "aio-coding-hub.db";
pub const DATABASE_OPTIMIZE_STAMP_FILE_NAME: &str = "db_optimize.stamp";
pub const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPathRoots {
    pub platform_home: PathBuf,
    pub resource_dir: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppPathOverrides {
    pub test_home: Option<PathBuf>,
    pub home_dir: Option<PathBuf>,
    pub dotdir_name: Option<String>,
}

impl AppPathOverrides {
    pub fn from_env() -> Self {
        Self {
            test_home: std::env::var_os(TEST_HOME_DIR_ENV).map(PathBuf::from),
            home_dir: std::env::var_os(HOME_DIR_OVERRIDE_ENV).map(PathBuf::from),
            dotdir_name: std::env::var(APP_DOTDIR_NAME_ENV).ok(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppPathsError {
    #[error("failed to create app dir: {source}")]
    CreateDataDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SEC_INVALID_INPUT: invalid plugin id path segment")]
    InvalidPluginId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    home: PathBuf,
    data: PathBuf,
    resources: PathBuf,
}

impl AppPaths {
    pub fn resolve(
        roots: AppPathRoots,
        overrides: AppPathOverrides,
    ) -> Result<Self, AppPathsError> {
        let home = overrides
            .test_home
            .filter(|path| path.is_absolute())
            .or_else(|| {
                overrides
                    .home_dir
                    .filter(|path| !path.as_os_str().is_empty())
            })
            .unwrap_or(roots.platform_home);
        let dotdir_name = overrides
            .dotdir_name
            .map(|value| value.trim().to_string())
            .filter(|value| is_safe_dotdir_name(value))
            .unwrap_or_else(|| APP_DOTDIR_NAME.to_string());
        let data = home.join(dotdir_name);

        std::fs::create_dir_all(&data).map_err(|source| AppPathsError::CreateDataDir {
            path: data.clone(),
            source,
        })?;

        Ok(Self {
            home,
            data,
            resources: roots.resource_dir,
        })
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn data_dir(&self) -> &Path {
        &self.data
    }

    pub fn resource_dir(&self) -> &Path {
        &self.resources
    }

    pub fn database_file(&self) -> PathBuf {
        self.data.join(DATABASE_FILE_NAME)
    }

    pub fn database_optimize_stamp(&self) -> PathBuf {
        self.data.join(DATABASE_OPTIMIZE_STAMP_FILE_NAME)
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data.join(SETTINGS_FILE_NAME)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data.join("logs")
    }

    pub fn skills_root(&self) -> PathBuf {
        self.data.join("skills")
    }

    pub fn skill_repos_root(&self) -> PathBuf {
        self.data.join("skill-repos")
    }

    pub fn mcp_sync_root(&self, cli_key: &str) -> PathBuf {
        self.data.join("mcp-sync").join(cli_key)
    }

    pub fn model_prices_dir(&self) -> PathBuf {
        self.data.join("model-prices")
    }

    pub fn plugins_root(&self) -> PathBuf {
        self.data.join("plugins")
    }

    pub fn plugins_installed_dir(&self) -> PathBuf {
        self.plugins_root().join("installed")
    }

    pub fn plugins_cache_dir(&self) -> PathBuf {
        self.plugins_root().join("cache")
    }

    pub fn plugins_data_dir(&self) -> PathBuf {
        self.plugins_root().join("data")
    }

    pub fn plugins_logs_dir(&self) -> PathBuf {
        self.plugins_root().join("logs")
    }

    pub fn plugin_data_dir(&self, plugin_id: &str) -> Result<PathBuf, AppPathsError> {
        Ok(self
            .plugins_data_dir()
            .join(plugin_id_path_segment(plugin_id)?))
    }

    pub fn official_plugins_bundled_root(&self) -> PathBuf {
        self.resources.join("resources/plugins/official")
    }

    pub fn official_plugins_dev_root(&self) -> PathBuf {
        self.resources.join("plugins/official")
    }
}

fn is_safe_dotdir_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || !name.starts_with('.') {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    name.chars()
        .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
}

pub fn plugin_id_path_segment(plugin_id: &str) -> Result<&str, AppPathsError> {
    let value = plugin_id.trim();
    if value.is_empty() || value == "." || value == ".." {
        return Err(AppPathsError::InvalidPluginId);
    }
    if value.contains('/') || value.contains('\\') || value.contains("..") {
        return Err(AppPathsError::InvalidPluginId);
    }
    if value.split('.').any(str::is_empty) {
        return Err(AppPathsError::InvalidPluginId);
    }
    if !value.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || "-.".contains(character)
    }) {
        return Err(AppPathsError::InvalidPluginId);
    }
    Ok(value)
}
