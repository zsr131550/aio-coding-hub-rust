use std::sync::Arc;

use aio_platform::{
    AutostartService, CancellationToken, ClipboardService, DialogService, NotificationService,
    OpenerService, PlatformError, PlatformFuture, PlatformOperation, PlatformServices,
    UpdateService,
};

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn platform_contracts_are_object_safe() {
    fn use_clipboard(_: &dyn ClipboardService) {}
    fn use_dialog(_: &dyn DialogService) {}
    fn use_opener(_: &dyn OpenerService) {}
    fn use_notification(_: &dyn NotificationService) {}
    fn use_autostart(_: &dyn AutostartService) {}
    fn use_updater(_: &dyn UpdateService) {}
    fn use_services(_: &dyn PlatformServices) {}

    let _ = use_clipboard;
    let _ = use_dialog;
    let _ = use_opener;
    let _ = use_notification;
    let _ = use_autostart;
    let _ = use_updater;
    let _ = use_services;
}

#[test]
fn shared_contract_values_are_send_and_sync() {
    assert_send_sync::<Arc<dyn PlatformServices>>();
    assert_send_sync::<PlatformError>();
    assert_send_sync::<CancellationToken>();
}

#[test]
fn platform_future_can_borrow_from_its_caller() {
    fn borrowed(value: &u32) -> PlatformFuture<'_, u32> {
        Box::pin(async move { Ok(*value) })
    }

    let value = 7;
    let future: PlatformFuture<'_, u32> = borrowed(&value);

    drop(future);
}

#[test]
fn cancellation_token_is_shared_between_clones() {
    let token = CancellationToken::new();
    let clone = token.clone();

    assert!(!token.is_cancelled());
    clone.cancel();
    assert!(token.is_cancelled());
    token.cancel();
    assert!(clone.is_cancelled());
}

#[test]
fn platform_error_exposes_stable_machine_fields() {
    let error = PlatformError::new(
        "DIALOG_OPEN_FAILED",
        PlatformOperation::DialogOpen,
        "native dialog failed",
    );

    assert_eq!(error.code(), "DIALOG_OPEN_FAILED");
    assert_eq!(error.operation(), PlatformOperation::DialogOpen);
    assert_eq!(error.message(), "native dialog failed");
    assert_eq!(
        error.to_string(),
        "DIALOG_OPEN_FAILED: native dialog failed"
    );
}

#[test]
fn unscripted_error_identifies_the_missing_operation() {
    let error = PlatformError::unscripted(PlatformOperation::DialogOpen);

    assert_eq!(error.code(), "UNSCRIPTED_PLATFORM_CALL");
    assert_eq!(error.operation(), PlatformOperation::DialogOpen);
    assert!(error.message().contains("dialog_open"));
}
