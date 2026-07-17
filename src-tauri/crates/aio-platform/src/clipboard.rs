use std::fmt;

use crate::{PlatformError, PlatformOperation, PlatformResult};

const MAX_DESKTOP_CLIPBOARD_CHARS: usize = 1_000_000;

#[derive(Clone, PartialEq, Eq)]
pub struct ClipboardText(String);

impl ClipboardText {
    pub fn from_desktop_input(input: String) -> PlatformResult<Self> {
        let text = crate::validation::trim_to_non_empty(&input, MAX_DESKTOP_CLIPBOARD_CHARS)
            .ok_or_else(|| {
                PlatformError::new(
                    "CLIPBOARD_EMPTY_TEXT",
                    PlatformOperation::ClipboardWriteText,
                    "text cannot be empty",
                )
            })?;
        Ok(Self(text))
    }

    pub fn from_prevalidated(input: String) -> PlatformResult<Self> {
        if input.trim().is_empty() {
            return Err(PlatformError::new(
                "CLIPBOARD_EMPTY_TEXT",
                PlatformOperation::ClipboardWriteText,
                "text cannot be empty",
            ));
        }

        Ok(Self(input))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Debug for ClipboardText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClipboardText")
            .field("chars", &self.0.chars().count())
            .finish_non_exhaustive()
    }
}

pub trait ClipboardService: Send + Sync {
    fn write_text(&self, text: ClipboardText) -> PlatformResult<()>;
}
