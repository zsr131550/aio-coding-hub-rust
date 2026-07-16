//! Usage: Tauri run-event lifecycle hooks extracted from `lib.rs`.

use super::resident;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static EXIT_CLEANUP_SPAWNED: AtomicBool = AtomicBool::new(false);
static EXIT_CLEANUP_COMPLETED: AtomicBool = AtomicBool::new(false);

fn exit_requires_cleanup(code: Option<i32>, cleanup_completed: bool) -> bool {
    code != Some(tauri::RESTART_EXIT_CODE) && !cleanup_completed
}

pub(crate) fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
        if exit_requires_cleanup(*code, EXIT_CLEANUP_COMPLETED.load(Ordering::Acquire)) {
            app_handle.state::<resident::ResidentState>().begin_exit();
            api.prevent_exit();

            if EXIT_CLEANUP_SPAWNED.swap(true, Ordering::SeqCst) {
                return;
            }

            tracing::info!("exit requested, starting cleanup...");
            let app_handle = app_handle.clone();
            crate::task_runtime::spawn(async move {
                crate::app::cleanup::cleanup_before_exit(&app_handle).await;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                EXIT_CLEANUP_COMPLETED.store(true, Ordering::Release);
                app_handle.exit(0);
            });
        }
    }

    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows,
        ..
    } = event
    {
        if !has_visible_windows {
            resident::show_main_window(app_handle);
        }
    }
}

pub(crate) fn request_restart<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.exit(tauri::RESTART_EXIT_CODE);
}

#[cfg(test)]
mod tests {
    use super::exit_requires_cleanup;

    #[test]
    fn normal_exit_waits_for_cleanup_but_restart_and_completed_cleanup_can_exit() {
        assert!(exit_requires_cleanup(None, false));
        assert!(exit_requires_cleanup(Some(0), false));
        assert!(!exit_requires_cleanup(Some(0), true));
        assert!(!exit_requires_cleanup(
            Some(tauri::RESTART_EXIT_CODE),
            false
        ));
    }

    #[test]
    fn cleanup_releases_the_event_loop_instead_of_terminating_the_process() {
        let source = std::fs::read_to_string(file!()).expect("read lifecycle source");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source");

        assert!(!production.contains("std::process::exit(0)"));
        assert!(production.contains("app_handle.exit(0)"));
    }
}
