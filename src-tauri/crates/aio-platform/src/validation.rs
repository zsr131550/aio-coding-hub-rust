use std::path::PathBuf;

pub(crate) fn trim_to_non_empty(input: &str, max_len: usize) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.chars().take(max_len).collect())
}

pub(crate) fn simplify_path(path: PathBuf) -> PathBuf {
    path.components().collect()
}

pub(crate) fn normalize_existing_path(path: PathBuf) -> PathBuf {
    if path.exists() {
        return std::fs::canonicalize(&path)
            .map(simplify_path)
            .unwrap_or_else(|_| simplify_path(path));
    }

    simplify_path(path)
}
