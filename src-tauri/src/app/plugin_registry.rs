//! Usage: Shared Tauri builder setup (managed state + plugin wiring).

use super::resident;

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
        .manage(resident::ResidentState::default())
        .manage(crate::app::heartbeat_watchdog::HeartbeatWatchdogState::default())
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
            if let Some(events) = super::core_runtime::try_event_sink(app) {
                events.publish(aio_contract::AppEvent::PlatformActivationRequested);
            }
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

    #[test]
    fn single_instance_publishes_activation_before_showing_window() {
        let source = std::fs::read_to_string(file!()).expect("read plugin registry source");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source");
        let activation = production
            .find("PlatformActivationRequested")
            .expect("single-instance callback publishes typed activation");
        let show = production[activation..]
            .find("resident::show_main_window(app)")
            .map(|offset| activation + offset)
            .expect("single-instance callback keeps the existing show/focus action");

        assert!(
            activation < show,
            "activation must publish before show/focus"
        );
    }

    #[test]
    fn builder_does_not_manage_fragmented_core_state() {
        let source = std::fs::read_to_string(file!()).expect("read plugin registry source");

        let legacy_states = [
            ["Db", "InitState::default"].concat(),
            ["Gateway", "State::default"].concat(),
            ["Startup", "State::default"].concat(),
            ["ExtensionHostRuntime", "State::default"].concat(),
            ["Clipboard", "State"].concat(),
            ["Dialog", "State"].concat(),
            ["Opener", "State"].concat(),
            ["Notification", "State"].concat(),
            ["Autostart", "State"].concat(),
            ["Updater", "State"].concat(),
        ];
        for legacy_state in legacy_states {
            assert!(
                !source.contains(&legacy_state),
                "{legacy_state} must be owned by the unified runtime state"
            );
        }
    }
}
