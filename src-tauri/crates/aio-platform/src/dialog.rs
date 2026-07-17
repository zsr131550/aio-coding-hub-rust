use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{PlatformError, PlatformFuture, PlatformOperation, PlatformResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DesktopDialogPickerMode {
    Document,
    Media,
    Image,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DesktopDialogFileAccessMode {
    Copy,
    Scoped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDialogOpenRequest {
    pub title: Option<String>,
    pub filters: Option<Vec<DesktopDialogFilter>>,
    pub default_path: Option<String>,
    pub multiple: Option<bool>,
    pub directory: Option<bool>,
    pub recursive: Option<bool>,
    pub can_create_directories: Option<bool>,
    pub picker_mode: Option<DesktopDialogPickerMode>,
    pub file_access_mode: Option<DesktopDialogFileAccessMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDialogSaveRequest {
    pub title: Option<String>,
    pub filters: Option<Vec<DesktopDialogFilter>>,
    pub default_path: Option<String>,
    pub can_create_directories: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

impl DialogFilter {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn extensions(&self) -> &[String] {
        &self.extensions
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogOpenRequest {
    title: Option<String>,
    filters: Vec<DialogFilter>,
    default_path: Option<PathBuf>,
    multiple: bool,
    directory: bool,
    recursive: Option<bool>,
    can_create_directories: Option<bool>,
    picker_mode: Option<DesktopDialogPickerMode>,
    file_access_mode: Option<DesktopDialogFileAccessMode>,
}

impl DialogOpenRequest {
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn filters(&self) -> &[DialogFilter] {
        &self.filters
    }

    pub fn default_path(&self) -> Option<&Path> {
        self.default_path.as_deref()
    }

    pub const fn multiple(&self) -> bool {
        self.multiple
    }

    pub const fn directory(&self) -> bool {
        self.directory
    }

    pub const fn recursive(&self) -> Option<bool> {
        self.recursive
    }

    pub const fn can_create_directories(&self) -> Option<bool> {
        self.can_create_directories
    }

    pub const fn picker_mode(&self) -> Option<DesktopDialogPickerMode> {
        self.picker_mode
    }

    pub const fn file_access_mode(&self) -> Option<DesktopDialogFileAccessMode> {
        self.file_access_mode
    }
}

impl TryFrom<DesktopDialogOpenRequest> for DialogOpenRequest {
    type Error = PlatformError;

    fn try_from(request: DesktopDialogOpenRequest) -> PlatformResult<Self> {
        Ok(Self {
            title: normalize_title(request.title),
            filters: normalize_filters(request.filters, PlatformOperation::DialogOpen)?,
            default_path: normalize_default_path(
                request.default_path,
                PlatformOperation::DialogOpen,
            )?,
            multiple: request.multiple.unwrap_or(false),
            directory: request.directory.unwrap_or(false),
            recursive: request.recursive,
            can_create_directories: request.can_create_directories,
            picker_mode: request.picker_mode,
            file_access_mode: request.file_access_mode,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogSaveRequest {
    title: Option<String>,
    filters: Vec<DialogFilter>,
    default_path: Option<PathBuf>,
    can_create_directories: Option<bool>,
}

impl DialogSaveRequest {
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn filters(&self) -> &[DialogFilter] {
        &self.filters
    }

    pub fn default_path(&self) -> Option<&Path> {
        self.default_path.as_deref()
    }

    pub const fn can_create_directories(&self) -> Option<bool> {
        self.can_create_directories
    }
}

impl TryFrom<DesktopDialogSaveRequest> for DialogSaveRequest {
    type Error = PlatformError;

    fn try_from(request: DesktopDialogSaveRequest) -> PlatformResult<Self> {
        Ok(Self {
            title: normalize_title(request.title),
            filters: normalize_filters(request.filters, PlatformOperation::DialogSave)?,
            default_path: normalize_default_path(
                request.default_path,
                PlatformOperation::DialogSave,
            )?,
            can_create_directories: request.can_create_directories,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogPath(String);

impl DialogPath {
    pub fn new(path: impl Into<String>) -> Self {
        Self(path.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

fn normalize_title(title: Option<String>) -> Option<String> {
    title.and_then(|value| crate::validation::trim_to_non_empty(&value, 256))
}

fn normalize_filters(
    filters: Option<Vec<DesktopDialogFilter>>,
    operation: PlatformOperation,
) -> PlatformResult<Vec<DialogFilter>> {
    let mut normalized = Vec::new();
    for filter in filters.unwrap_or_default() {
        let name = crate::validation::trim_to_non_empty(&filter.name, 128).ok_or_else(|| {
            PlatformError::new(
                "DESKTOP_DIALOG_INVALID_FILTER_NAME",
                operation,
                "filter name cannot be empty",
            )
        })?;
        let extensions = filter
            .extensions
            .into_iter()
            .filter_map(|extension| crate::validation::trim_to_non_empty(&extension, 64))
            .map(|extension| extension.trim_start_matches('.').to_string())
            .filter(|extension| !extension.is_empty())
            .collect::<Vec<_>>();

        if extensions.is_empty() {
            return Err(PlatformError::new(
                "DESKTOP_DIALOG_INVALID_FILTER",
                operation,
                "filter extensions cannot be empty",
            ));
        }

        normalized.push(DialogFilter { name, extensions });
    }

    Ok(normalized)
}

fn normalize_default_path(
    default_path: Option<String>,
    operation: PlatformOperation,
) -> PlatformResult<Option<PathBuf>> {
    default_path
        .map(|path| {
            crate::validation::trim_to_non_empty(&path, 4_096)
                .map(PathBuf::from)
                .map(crate::validation::simplify_path)
                .ok_or_else(|| {
                    PlatformError::new(
                        "DESKTOP_DIALOG_INVALID_DEFAULT_PATH",
                        operation,
                        "defaultPath cannot be empty",
                    )
                })
        })
        .transpose()
}

pub trait DialogService: Send + Sync {
    fn open(&self, request: DialogOpenRequest) -> PlatformFuture<'_, Option<Vec<DialogPath>>>;

    fn save(&self, request: DialogSaveRequest) -> PlatformFuture<'_, Option<DialogPath>>;
}
