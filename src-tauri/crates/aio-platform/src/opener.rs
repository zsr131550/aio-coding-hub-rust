use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{PlatformError, PlatformFuture, PlatformOperation, PlatformResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenUrlRequest {
    pub url: String,
    pub with: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenPathRequest {
    pub path: String,
    pub with: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRevealItemRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenUrlRequest {
    url: String,
    program: Option<String>,
}

impl OpenUrlRequest {
    pub fn from_oauth(url: String) -> PlatformResult<Self> {
        validate_url(&url)?;
        Ok(Self { url, program: None })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn program(&self) -> Option<&str> {
        self.program.as_deref()
    }
}

impl TryFrom<DesktopOpenUrlRequest> for OpenUrlRequest {
    type Error = PlatformError;

    fn try_from(request: DesktopOpenUrlRequest) -> PlatformResult<Self> {
        let url = crate::validation::trim_to_non_empty(&request.url, 2_048).ok_or_else(|| {
            PlatformError::new(
                "DESKTOP_OPEN_URL_EMPTY",
                PlatformOperation::OpenerOpenUrl,
                "url cannot be empty",
            )
        })?;
        validate_url(&url)?;

        Ok(Self {
            url,
            program: normalize_program(request.with),
        })
    }
}

fn validate_url(input: &str) -> PlatformResult<()> {
    if input.trim().is_empty() {
        return Err(PlatformError::new(
            "DESKTOP_OPEN_URL_EMPTY",
            PlatformOperation::OpenerOpenUrl,
            "url cannot be empty",
        ));
    }

    let parsed = url::Url::parse(input).map_err(|error| {
        PlatformError::new(
            "DESKTOP_OPEN_URL_INVALID",
            PlatformOperation::OpenerOpenUrl,
            format!("invalid url: {error}"),
        )
    })?;
    match parsed.scheme() {
        "http" | "https" | "mailto" | "tel" => Ok(()),
        scheme => Err(PlatformError::new(
            "DESKTOP_OPEN_URL_SCHEME_DENIED",
            PlatformOperation::OpenerOpenUrl,
            format!("unsupported url scheme: {scheme}"),
        )),
    }
}

fn normalize_program(program: Option<String>) -> Option<String> {
    program.and_then(|value| crate::validation::trim_to_non_empty(&value, 256))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPathCandidate {
    path: PathBuf,
    program: Option<String>,
}

impl OpenPathCandidate {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn program(&self) -> Option<&str> {
        self.program.as_deref()
    }
}

impl TryFrom<DesktopOpenPathRequest> for OpenPathCandidate {
    type Error = PlatformError;

    fn try_from(request: DesktopOpenPathRequest) -> PlatformResult<Self> {
        Ok(Self {
            path: normalize_open_path(request.path, PlatformOperation::OpenerOpenPath)?,
            program: normalize_program(request.with),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealPathCandidate {
    path: PathBuf,
}

impl RevealPathCandidate {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl TryFrom<DesktopRevealItemRequest> for RevealPathCandidate {
    type Error = PlatformError;

    fn try_from(request: DesktopRevealItemRequest) -> PlatformResult<Self> {
        Ok(Self {
            path: normalize_open_path(request.path, PlatformOperation::OpenerRevealItem)?,
        })
    }
}

fn normalize_open_path(input: String, operation: PlatformOperation) -> PlatformResult<PathBuf> {
    let path = crate::validation::trim_to_non_empty(&input, 4_096).ok_or_else(|| {
        PlatformError::new("DESKTOP_OPEN_PATH_EMPTY", operation, "path cannot be empty")
    })?;
    Ok(crate::validation::normalize_existing_path(PathBuf::from(
        path,
    )))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedOpenPath(OpenPathCandidate);

impl AuthorizedOpenPath {
    pub fn path(&self) -> &Path {
        self.0.path()
    }

    pub fn program(&self) -> Option<&str> {
        self.0.program()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedRevealPath(RevealPathCandidate);

impl AuthorizedRevealPath {
    pub fn path(&self) -> &Path {
        self.0.path()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPathPolicy {
    roots: Vec<PathBuf>,
}

impl OpenPathPolicy {
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut normalized = Vec::new();
        for root in roots {
            let root = crate::validation::normalize_existing_path(root);
            if !normalized.iter().any(|existing| existing == &root) {
                normalized.push(root);
            }
        }
        Self { roots: normalized }
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn authorize(&self, candidate: OpenPathCandidate) -> PlatformResult<AuthorizedOpenPath> {
        self.ensure_allowed(candidate.path(), PlatformOperation::OpenerOpenPath)?;
        Ok(AuthorizedOpenPath(candidate))
    }

    pub fn authorize_reveal(
        &self,
        candidate: RevealPathCandidate,
    ) -> PlatformResult<AuthorizedRevealPath> {
        self.ensure_allowed(candidate.path(), PlatformOperation::OpenerRevealItem)?;
        Ok(AuthorizedRevealPath(candidate))
    }

    fn ensure_allowed(&self, path: &Path, operation: PlatformOperation) -> PlatformResult<()> {
        if self
            .roots
            .iter()
            .any(|root| path == root || path.starts_with(root))
        {
            return Ok(());
        }

        Err(PlatformError::new(
            "DESKTOP_OPEN_PATH_DENIED",
            operation,
            format!("path is outside allowed desktop roots: {}", path.display()),
        ))
    }
}

pub trait OpenerService: Send + Sync {
    fn open_url(&self, request: OpenUrlRequest) -> PlatformFuture<'_, ()>;

    fn open_path(&self, request: AuthorizedOpenPath) -> PlatformFuture<'_, ()>;

    fn reveal_item(&self, request: AuthorizedRevealPath) -> PlatformFuture<'_, ()>;
}
