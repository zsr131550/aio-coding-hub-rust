use crate::app_paths;
use crate::codex_paths;
use crate::domain::skills::types::SkillsPaths;
use std::path::PathBuf;

pub(super) fn validate_cli_key(cli_key: &str) -> crate::shared::error::AppResult<()> {
    crate::shared::cli_key::validate_cli_key(cli_key)
}

fn home_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    crate::app_paths::home_dir(app)
}

pub(super) fn ssot_skills_root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(app_paths::get(app)?.skills_root())
}

pub(super) fn repos_root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<PathBuf> {
    Ok(app_paths::get(app)?.skill_repos_root())
}

pub(super) fn cli_skills_root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cli_key: &str,
) -> crate::shared::error::AppResult<PathBuf> {
    validate_cli_key(cli_key)?;
    let home = home_dir(app)?;
    match cli_key {
        "claude" => Ok(home.join(".claude").join("skills")),
        "codex" => codex_paths::codex_skills_dir(app),
        "gemini" => Ok(home.join(".gemini").join("skills")),
        _ => Err(format!("SEC_INVALID_INPUT: unknown cli_key={cli_key}").into()),
    }
}

pub(super) fn ensure_skills_roots<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> crate::shared::error::AppResult<()> {
    std::fs::create_dir_all(ssot_skills_root(app)?)
        .map_err(|e| format!("failed to create ssot skills dir: {e}"))?;
    std::fs::create_dir_all(repos_root(app)?)
        .map_err(|e| format!("failed to create repos dir: {e}"))?;
    Ok(())
}

pub fn paths_get<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cli_key: &str,
) -> crate::shared::error::AppResult<SkillsPaths> {
    validate_cli_key(cli_key)?;
    let ssot = ssot_skills_root(app)?;
    let repos = repos_root(app)?;
    let cli = cli_skills_root(app, cli_key)?;

    Ok(SkillsPaths {
        ssot_dir: ssot.to_string_lossy().to_string(),
        repos_dir: repos.to_string_lossy().to_string(),
        cli_dir: cli.to_string_lossy().to_string(),
    })
}
