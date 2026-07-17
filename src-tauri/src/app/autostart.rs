//! Usage: Auto-start reconciliation policy shared by settings-related flows.

pub(crate) fn reconcile_auto_start(
    autostart: &dyn aio_platform::AutostartService,
    previous_auto_start: bool,
    desired_auto_start: bool,
    force_sync: bool,
) -> bool {
    if !force_sync && previous_auto_start == desired_auto_start {
        return desired_auto_start;
    }

    match autostart.set_enabled(desired_auto_start) {
        Ok(()) => desired_auto_start,
        Err(error) => {
            tracing::warn!(error = %error.message(), "auto-start sync failed");
            previous_auto_start
        }
    }
}

pub(crate) fn restore_auto_start_best_effort(
    autostart: &dyn aio_platform::AutostartService,
    auto_start: bool,
) {
    if let Err(error) = autostart.set_enabled(auto_start) {
        tracing::warn!(error = %error.message(), "auto-start rollback failed");
    }
}

#[cfg(test)]
mod tests {
    use super::{reconcile_auto_start, restore_auto_start_best_effort};
    use aio_platform::fakes::{FakePlatformServices, PlatformCall};
    use aio_platform::{PlatformError, PlatformOperation};

    #[test]
    fn reconcile_skips_unchanged_value_without_consuming_script() {
        let platform = FakePlatformServices::new();

        assert!(reconcile_auto_start(
            platform.autostart_fake(),
            true,
            true,
            false
        ));
        assert!(platform.journal().snapshot().is_empty());
    }

    #[test]
    fn reconcile_forced_sync_records_one_call() {
        let platform = FakePlatformServices::new();
        platform.autostart_fake().script_result(Ok(()));

        assert!(reconcile_auto_start(
            platform.autostart_fake(),
            true,
            true,
            true
        ));
        assert!(matches!(
            platform.journal().snapshot()[0].call,
            PlatformCall::AutostartSetEnabled { enabled: true }
        ));
    }

    #[test]
    fn reconcile_failure_returns_previous_value() {
        let platform = FakePlatformServices::new();
        platform
            .autostart_fake()
            .script_result(Err(PlatformError::new(
                "AUTOSTART_ENABLE_FAILED",
                PlatformOperation::AutostartSetEnabled,
                "failed to enable autostart: backend detail",
            )));

        assert!(!reconcile_auto_start(
            platform.autostart_fake(),
            false,
            true,
            true
        ));
    }

    #[test]
    fn rollback_attempts_restore_and_swallows_failure() {
        let platform = FakePlatformServices::new();
        platform
            .autostart_fake()
            .script_result(Err(PlatformError::new(
                "AUTOSTART_DISABLE_FAILED",
                PlatformOperation::AutostartSetEnabled,
                "failed to disable autostart: backend detail",
            )));

        restore_auto_start_best_effort(platform.autostart_fake(), false);
        assert!(matches!(
            platform.journal().snapshot()[0].call,
            PlatformCall::AutostartSetEnabled { enabled: false }
        ));
    }
}
