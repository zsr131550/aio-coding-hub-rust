//! Usage: Shared Tauri builder setup (managed state + plugin wiring).

use super::{
    app_state::DbInitState, gateway_state::GatewayState, resident, startup_state::StartupState,
};

#[cfg(desktop)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DesktopPluginPolicy {
    single_instance: bool,
    window_state: bool,
}

#[cfg(desktop)]
const fn desktop_plugin_policy(benchmark_enabled: bool) -> DesktopPluginPolicy {
    DesktopPluginPolicy {
        single_instance: !benchmark_enabled,
        window_state: !benchmark_enabled,
    }
}

pub(crate) fn create_builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        .manage(DbInitState::default())
        .manage(GatewayState::default())
        .manage(resident::ResidentState::default())
        .manage(StartupState::default())
        .manage(crate::app::heartbeat_watchdog::HeartbeatWatchdogState::default())
        .manage(crate::app::plugins::extension_host_registry::ExtensionHostRuntimeState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init());

    let builder = match crate::benchmark::plugin() {
        Some(plugin) => builder.plugin(plugin),
        None => builder,
    };

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    let policy = desktop_plugin_policy(crate::benchmark::is_enabled());

    #[cfg(desktop)]
    let builder = if policy.single_instance {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            resident::show_main_window(app);
        }))
    } else {
        builder
    };

    #[cfg(desktop)]
    let builder = if policy.window_state {
        builder.plugin(tauri_plugin_window_state::Builder::default().build())
    } else {
        builder
    };

    builder
}

#[cfg(test)]
mod tests {
    #[cfg(desktop)]
    #[test]
    fn benchmark_desktop_policy_skips_global_instance_and_persisted_window_state() {
        let normal = super::desktop_plugin_policy(false);
        assert!(normal.single_instance);
        assert!(normal.window_state);

        let benchmark = super::desktop_plugin_policy(true);
        assert!(!benchmark.single_instance);
        assert!(!benchmark.window_state);
    }

    #[test]
    fn desktop_builder_keeps_single_instance_registration() {
        let source = std::fs::read_to_string(file!()).expect("read plugin registry source");
        let needle = ["tauri_plugin_", "single_", "instance::", "init"].concat();

        assert!(
            source.contains("#[cfg(desktop)]") && source.contains(&needle),
            "startup request-log reconciliation relies on desktop single-instance ownership"
        );
    }
}
