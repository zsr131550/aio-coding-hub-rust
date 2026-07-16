//! Usage: Startup pipeline state shared between backend bootstrap and frontend status UI.

use super::core_runtime::ManagedCoreRuntimeState;

pub use aio_contract::{AppStartupStage, AppStartupStatus, APP_STARTUP_STATUS_EVENT_NAME};

fn emit_snapshot(events: &dyn aio_core::EventSink, snapshot: &AppStartupStatus) {
    events.publish(aio_contract::AppEvent::StartupStatusChanged(
        snapshot.clone(),
    ));
}

pub(crate) fn startup_status_snapshot(state: &ManagedCoreRuntimeState) -> AppStartupStatus {
    state.context().startup().snapshot()
}

pub(crate) fn try_begin_startup_run(state: &ManagedCoreRuntimeState) -> bool {
    if let Some(snapshot) = state.context().startup().try_begin_run() {
        emit_snapshot(state.context().events().as_ref(), &snapshot);
        true
    } else {
        false
    }
}

pub(crate) fn set_startup_stage(
    state: &ManagedCoreRuntimeState,
    stage: AppStartupStage,
) -> AppStartupStatus {
    let snapshot = state.context().startup().set_stage(stage);
    emit_snapshot(state.context().events().as_ref(), &snapshot);
    snapshot
}

pub(crate) fn fail_startup_run(
    state: &ManagedCoreRuntimeState,
    stage: AppStartupStage,
    message: impl Into<String>,
) -> AppStartupStatus {
    let snapshot = state.context().startup().fail(stage, message);
    emit_snapshot(state.context().events().as_ref(), &snapshot);
    snapshot
}

pub(crate) fn finish_startup_run(state: &ManagedCoreRuntimeState) -> AppStartupStatus {
    let snapshot = state.context().startup().finish();
    emit_snapshot(state.context().events().as_ref(), &snapshot);
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use aio_core::RecordingEventSink;

    #[test]
    fn emit_snapshot_publishes_typed_startup_event() {
        let events = RecordingEventSink::default();
        let snapshot = AppStartupStatus {
            running: false,
            current_stage: AppStartupStage::Ready,
            failed_stage: None,
            error_message: None,
            can_retry: false,
        };

        emit_snapshot(&events, &snapshot);

        let published = events.events();
        assert_eq!(published.len(), 1);
        let aio_contract::AppEvent::StartupStatusChanged(actual) = &published[0] else {
            panic!("expected typed startup status event");
        };
        assert_eq!(actual, &snapshot);
    }

    #[test]
    fn begin_run_resets_failure_and_sets_initial_stage() {
        let state = aio_core::StartupState::default();
        let _ = state.try_begin_run().expect("first run starts");
        let _ = state.fail(AppStartupStage::StartingGateway, "boom");
        let status = state.try_begin_run().expect("retry starts");
        assert!(status.running);
        assert_eq!(status.current_stage, AppStartupStage::InitializingDb);
        assert_eq!(status.failed_stage, None);
        assert_eq!(status.error_message, None);
        assert!(!status.can_retry);
    }

    #[test]
    fn begin_run_rejects_parallel_start() {
        let state = aio_core::StartupState::default();
        assert!(state.try_begin_run().is_some());
        assert!(state.try_begin_run().is_none());
        assert!(state.snapshot().running);
    }

    #[test]
    fn set_failed_marks_retryable_failure() {
        let state = aio_core::StartupState::default();
        let _ = state.try_begin_run();
        let status = state.fail(
            AppStartupStage::StartingGateway,
            "gateway failed".to_string(),
        );

        assert!(!status.running);
        assert_eq!(status.current_stage, AppStartupStage::Failed);
        assert_eq!(status.failed_stage, Some(AppStartupStage::StartingGateway));
        assert_eq!(status.error_message.as_deref(), Some("gateway failed"));
        assert!(status.can_retry);
    }

    #[test]
    fn set_ready_clears_failure_details() {
        let state = aio_core::StartupState::default();
        let _ = state.try_begin_run();
        let _ = state.fail(AppStartupStage::ReadingSettings, "bad settings");
        let _ = state.try_begin_run();
        let status = state.finish();

        assert!(!status.running);
        assert_eq!(status.current_stage, AppStartupStage::Ready);
        assert_eq!(status.failed_stage, None);
        assert_eq!(status.error_message, None);
        assert!(!status.can_retry);
    }
}
