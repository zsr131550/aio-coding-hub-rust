use std::future::Future;
use std::pin::pin;
use std::sync::{Arc, Barrier, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;

use aio_platform::fakes::{FakePlatformServices, PlatformCall};
use aio_platform::{
    AutostartService, CancellationToken, ClipboardService, ClipboardText, DesktopDialogOpenRequest,
    DesktopNotificationPermissionState, DesktopOpenUrlRequest, DialogOpenRequest, DialogPath,
    DialogService, NotificationService, OpenUrlRequest, OpenerService, PlatformError,
    PlatformOperation, PlatformResult, UpdateCheckRequest, UpdateId, UpdateInstallRequest,
    UpdateProgressEvent, UpdateProgressSink, UpdateService,
};

struct ThreadWake(thread::Thread);

impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);

    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => thread::park(),
        }
    }
}

fn open_dialog_request() -> DialogOpenRequest {
    DialogOpenRequest::try_from(DesktopDialogOpenRequest {
        title: None,
        filters: None,
        default_path: None,
        multiple: None,
        directory: None,
        recursive: None,
        can_create_directories: None,
        picker_mode: None,
        file_access_mode: None,
    })
    .unwrap()
}

#[test]
fn unscripted_call_returns_typed_error_without_panicking() {
    let services = FakePlatformServices::new();
    let error = services
        .clipboard_fake()
        .write_text(ClipboardText::from_desktop_input("text".to_string()).unwrap())
        .unwrap_err();

    assert_eq!(error.code(), "UNSCRIPTED_PLATFORM_CALL");
    assert_eq!(error.operation(), PlatformOperation::ClipboardWriteText);
    assert_eq!(services.journal().snapshot().len(), 1);
}

#[test]
fn scripted_results_are_consumed_fifo() {
    let services = FakePlatformServices::new();
    services
        .clipboard_fake()
        .script_result(Err(PlatformError::new(
            "FIRST",
            PlatformOperation::ClipboardWriteText,
            "first result",
        )));
    services.clipboard_fake().script_result(Ok(()));

    let first = services
        .clipboard_fake()
        .write_text(ClipboardText::from_desktop_input("one".to_string()).unwrap())
        .unwrap_err();
    let second = services
        .clipboard_fake()
        .write_text(ClipboardText::from_desktop_input("two".to_string()).unwrap());

    assert_eq!(first.code(), "FIRST");
    assert!(second.is_ok());
}

#[test]
fn all_capabilities_share_one_monotonic_journal() {
    let services = FakePlatformServices::new();
    services.clipboard_fake().script_result(Ok(()));
    services.dialog_fake().script_open_result(Ok(None));
    services.opener_fake().script_open_url_result(Ok(()));
    services
        .notification_fake()
        .script_permission_state_result(Ok(DesktopNotificationPermissionState::Granted));
    services.autostart_fake().script_result(Ok(()));
    services.updater_fake().script_check_result(Ok(None));

    services
        .clipboard_fake()
        .write_text(ClipboardText::from_desktop_input("text".to_string()).unwrap())
        .unwrap();
    block_on(services.dialog_fake().open(open_dialog_request())).unwrap();
    block_on(
        services.opener_fake().open_url(
            OpenUrlRequest::try_from(DesktopOpenUrlRequest {
                url: "https://example.com".to_string(),
                with: None,
            })
            .unwrap(),
        ),
    )
    .unwrap();
    services.notification_fake().permission_state().unwrap();
    services.autostart_fake().set_enabled(true).unwrap();
    block_on(
        services
            .updater_fake()
            .check(UpdateCheckRequest::new(None, CancellationToken::new())),
    )
    .unwrap();

    let records = services.journal().snapshot();
    assert_eq!(
        records
            .iter()
            .map(|record| record.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert!(matches!(
        records[0].call,
        PlatformCall::ClipboardWriteText { .. }
    ));
    assert!(matches!(records[1].call, PlatformCall::DialogOpen { .. }));
    assert!(matches!(
        records[2].call,
        PlatformCall::OpenerOpenUrl { .. }
    ));
    assert!(matches!(
        records[3].call,
        PlatformCall::NotificationPermissionState
    ));
    assert!(matches!(
        records[4].call,
        PlatformCall::AutostartSetEnabled { enabled: true }
    ));
    assert!(matches!(records[5].call, PlatformCall::UpdateCheck { .. }));
}

#[test]
fn dialog_cancel_is_distinct_from_dialog_error() {
    let services = FakePlatformServices::new();
    services.dialog_fake().script_open_result(Ok(None));
    services
        .dialog_fake()
        .script_open_result(Err(PlatformError::new(
            "DESKTOP_DIALOG_OPEN_CANCELLED",
            PlatformOperation::DialogOpen,
            "dialog response channel dropped",
        )));

    assert_eq!(
        block_on(services.dialog_fake().open(open_dialog_request())).unwrap(),
        None
    );
    let error = block_on(services.dialog_fake().open(open_dialog_request())).unwrap_err();
    assert_eq!(error.code(), "DESKTOP_DIALOG_OPEN_CANCELLED");
}

#[derive(Default)]
struct RecordingProgressSink {
    events: Mutex<Vec<UpdateProgressEvent>>,
}

impl UpdateProgressSink for RecordingProgressSink {
    fn publish(&self, event: UpdateProgressEvent) -> PlatformResult<()> {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(event);
        Ok(())
    }
}

#[test]
fn updater_publishes_scripted_progress_before_final_result() {
    let services = FakePlatformServices::new();
    let expected = vec![
        UpdateProgressEvent::Started {
            content_length: Some(512),
        },
        UpdateProgressEvent::Progress { chunk_length: 128 },
        UpdateProgressEvent::Finished,
    ];
    services.updater_fake().script_install_result(
        expected.clone(),
        Err(PlatformError::disabled(
            PlatformOperation::UpdateDownloadAndInstall,
        )),
    );
    let sink = Arc::new(RecordingProgressSink::default());

    let result = block_on(services.updater_fake().download_and_install(
        UpdateInstallRequest::new(UpdateId::new(7), None, CancellationToken::new()),
        sink.clone(),
    ));

    assert_eq!(result.unwrap_err().code(), "PLATFORM_OPERATION_DISABLED");
    assert_eq!(
        *sink
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        expected
    );
}

#[test]
fn poisoned_script_and_journal_locks_recover() {
    let services = FakePlatformServices::new();
    services.clipboard_fake().script_result(Ok(()));
    services.clipboard_fake().poison_script_for_test();
    services.journal().poison_for_test();

    services
        .clipboard_fake()
        .write_text(ClipboardText::from_desktop_input("text".to_string()).unwrap())
        .unwrap();

    assert_eq!(services.journal().snapshot().len(), 1);
}

#[test]
fn concurrent_calls_have_unique_sequences_and_consume_each_result_once() {
    const CALLS: usize = 16;

    let services = Arc::new(FakePlatformServices::new());
    for index in 0..CALLS {
        services
            .dialog_fake()
            .script_open_result(Ok(Some(vec![DialogPath::new(index.to_string())])));
    }
    let barrier = Arc::new(Barrier::new(CALLS));
    let mut threads = Vec::new();
    for _ in 0..CALLS {
        let services = services.clone();
        let barrier = barrier.clone();
        threads.push(thread::spawn(move || {
            barrier.wait();
            block_on(services.dialog_fake().open(open_dialog_request()))
                .unwrap()
                .unwrap()[0]
                .as_str()
                .parse::<usize>()
                .unwrap()
        }));
    }

    let mut returned = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    returned.sort_unstable();
    assert_eq!(returned, (0..CALLS).collect::<Vec<_>>());

    let mut records = services.journal().snapshot();
    records.sort_by_key(|record| record.sequence);
    assert_eq!(records.len(), CALLS);
    assert_eq!(
        records
            .iter()
            .map(|record| record.sequence)
            .collect::<Vec<_>>(),
        (1..=CALLS as u64).collect::<Vec<_>>()
    );
}
