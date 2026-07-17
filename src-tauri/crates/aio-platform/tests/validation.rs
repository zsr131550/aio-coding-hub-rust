use std::path::PathBuf;
use std::time::Duration;

use aio_platform::{
    CancellationToken, ClipboardText, DesktopDialogFileAccessMode, DesktopDialogFilter,
    DesktopDialogOpenRequest, DesktopDialogPickerMode, DesktopDialogSaveRequest,
    DesktopNotificationPayload, DesktopNotificationPermissionState, DesktopOpenPathRequest,
    DesktopOpenUrlRequest, DesktopUpdaterMetadata, DialogOpenRequest, DialogSaveRequest,
    Notification, OpenPathCandidate, OpenPathPolicy, OpenUrlRequest, PlatformOperation,
    UpdateCheckRequest, UpdateId, UpdateInstallRequest, UpdateMetadata, UpdateProgressEvent,
};

#[test]
fn desktop_clipboard_text_trims_and_truncates_by_character() {
    let input = format!("  {}tail  ", "界".repeat(1_000_000));
    let text = ClipboardText::from_desktop_input(input).unwrap();

    assert_eq!(text.as_str().chars().count(), 1_000_000);
    assert!(text.as_str().chars().all(|character| character == '界'));
}

#[test]
fn desktop_clipboard_rejects_blank_text() {
    let error = ClipboardText::from_desktop_input(" \r\n ".to_string()).unwrap_err();

    assert_eq!(error.code(), "CLIPBOARD_EMPTY_TEXT");
    assert_eq!(error.operation(), PlatformOperation::ClipboardWriteText);
    assert_eq!(error.message(), "text cannot be empty");
}

#[test]
fn prevalidated_clipboard_text_preserves_original_bytes() {
    let original = "  secret-key-with-significant-space  ".to_string();
    let text = ClipboardText::from_prevalidated(original.clone()).unwrap();

    assert_eq!(text.as_str(), original);
}

fn dialog_open_request() -> DesktopDialogOpenRequest {
    DesktopDialogOpenRequest {
        title: Some("  Pick a file  ".to_string()),
        filters: Some(vec![DesktopDialogFilter {
            name: "  JSON  ".to_string(),
            extensions: vec![" .json ".to_string(), "..json".to_string()],
        }]),
        default_path: Some("  folder/../file.json  ".to_string()),
        multiple: None,
        directory: Some(true),
        recursive: Some(true),
        can_create_directories: Some(false),
        picker_mode: Some(DesktopDialogPickerMode::Document),
        file_access_mode: Some(DesktopDialogFileAccessMode::Scoped),
    }
}

#[test]
fn dialog_open_request_normalizes_without_tauri_types() {
    let request = DialogOpenRequest::try_from(dialog_open_request()).unwrap();

    assert_eq!(request.title(), Some("Pick a file"));
    assert_eq!(request.filters()[0].name(), "JSON");
    assert_eq!(request.filters()[0].extensions(), ["json", "json"]);
    assert_eq!(
        request.default_path(),
        Some(PathBuf::from("folder/../file.json").as_path())
    );
    assert!(!request.multiple());
    assert!(request.directory());
    assert_eq!(request.recursive(), Some(true));
    assert_eq!(request.can_create_directories(), Some(false));
    assert_eq!(
        request.picker_mode(),
        Some(DesktopDialogPickerMode::Document)
    );
    assert_eq!(
        request.file_access_mode(),
        Some(DesktopDialogFileAccessMode::Scoped)
    );
}

#[test]
fn dialog_filter_errors_keep_existing_codes() {
    let mut request = dialog_open_request();
    request.filters = Some(vec![DesktopDialogFilter {
        name: "  ".to_string(),
        extensions: vec!["json".to_string()],
    }]);
    let error = DialogOpenRequest::try_from(request).unwrap_err();
    assert_eq!(error.code(), "DESKTOP_DIALOG_INVALID_FILTER_NAME");

    let mut request = dialog_open_request();
    request.filters = Some(vec![DesktopDialogFilter {
        name: "JSON".to_string(),
        extensions: vec![" . ".to_string(), "  ".to_string()],
    }]);
    let error = DialogOpenRequest::try_from(request).unwrap_err();
    assert_eq!(error.code(), "DESKTOP_DIALOG_INVALID_FILTER");
}

#[test]
fn dialog_limits_are_unicode_character_based() {
    let mut request = dialog_open_request();
    request.title = Some(format!("  {}tail  ", "界".repeat(256)));
    request.default_path = Some(format!("{}tail", "路".repeat(4_096)));
    request.filters = Some(vec![DesktopDialogFilter {
        name: format!("{}tail", "名".repeat(128)),
        extensions: vec![format!(".{}tail", "扩".repeat(64))],
    }]);

    let request = DialogOpenRequest::try_from(request).unwrap();
    assert_eq!(request.title().unwrap().chars().count(), 256);
    assert_eq!(
        request
            .default_path()
            .unwrap()
            .to_string_lossy()
            .chars()
            .count(),
        4_096
    );
    assert_eq!(request.filters()[0].name().chars().count(), 128);
    assert_eq!(request.filters()[0].extensions()[0].chars().count(), 63);
}

#[test]
fn dialog_save_rejects_blank_default_path() {
    let error = DialogSaveRequest::try_from(DesktopDialogSaveRequest {
        title: None,
        filters: None,
        default_path: Some("  ".to_string()),
        can_create_directories: None,
    })
    .unwrap_err();

    assert_eq!(error.code(), "DESKTOP_DIALOG_INVALID_DEFAULT_PATH");
}

#[test]
fn dialog_input_dto_keeps_camel_case_wire_fields() {
    let request: DesktopDialogOpenRequest = serde_json::from_value(serde_json::json!({
        "title": null,
        "filters": null,
        "defaultPath": "file.txt",
        "multiple": true,
        "directory": false,
        "recursive": null,
        "canCreateDirectories": true,
        "pickerMode": "image",
        "fileAccessMode": "copy"
    }))
    .unwrap();

    let normalized = DialogOpenRequest::try_from(request).unwrap();
    assert!(normalized.multiple());
    assert!(!normalized.directory());
    assert_eq!(normalized.can_create_directories(), Some(true));
    assert_eq!(
        normalized.picker_mode(),
        Some(DesktopDialogPickerMode::Image)
    );
    assert_eq!(
        normalized.file_access_mode(),
        Some(DesktopDialogFileAccessMode::Copy)
    );
}

#[test]
fn desktop_url_keeps_existing_truncation_and_scheme_rules() {
    let long_url = format!("https://example.com/{}", "x".repeat(3_000));
    let request = OpenUrlRequest::try_from(DesktopOpenUrlRequest {
        url: format!("  {long_url}  "),
        with: Some(format!("  {}  ", "p".repeat(300))),
    })
    .unwrap();

    assert_eq!(request.url().chars().count(), 2_048);
    assert_eq!(request.program().unwrap().chars().count(), 256);

    let error = OpenUrlRequest::try_from(DesktopOpenUrlRequest {
        url: "file:///tmp/example".to_string(),
        with: None,
    })
    .unwrap_err();
    assert_eq!(error.code(), "DESKTOP_OPEN_URL_SCHEME_DENIED");

    let error = OpenUrlRequest::try_from(DesktopOpenUrlRequest {
        url: "not a url".to_string(),
        with: None,
    })
    .unwrap_err();
    assert_eq!(error.code(), "DESKTOP_OPEN_URL_INVALID");
}

#[test]
fn desktop_url_rejects_empty_input_with_existing_code() {
    let error = OpenUrlRequest::try_from(DesktopOpenUrlRequest {
        url: " \r\n ".to_string(),
        with: None,
    })
    .unwrap_err();

    assert_eq!(error.code(), "DESKTOP_OPEN_URL_EMPTY");
}

#[test]
fn oauth_url_validation_does_not_add_desktop_truncation() {
    let long_url = format!("https://example.com/{}", "x".repeat(3_000));
    let request = OpenUrlRequest::from_oauth(long_url.clone()).unwrap();

    assert_eq!(request.url(), long_url);
    assert_eq!(request.program(), None);
}

#[test]
fn open_path_policy_authorizes_only_configured_roots() {
    let root = std::env::current_dir().unwrap().join("target/policy-root");
    let child = root.join("nested/file.txt");
    let sibling = root.with_file_name("policy-root-other").join("file.txt");
    let policy = OpenPathPolicy::new([root.clone()]);

    let root_candidate = OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: root.to_string_lossy().into_owned(),
        with: None,
    })
    .unwrap();
    assert!(policy.authorize(root_candidate).is_ok());

    let child_candidate = OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: child.to_string_lossy().into_owned(),
        with: Some(" explorer ".to_string()),
    })
    .unwrap();
    let authorized = policy.authorize(child_candidate).unwrap();
    assert_eq!(authorized.program(), Some("explorer"));

    let sibling_candidate = OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: sibling.to_string_lossy().into_owned(),
        with: None,
    })
    .unwrap();
    let error = policy.authorize(sibling_candidate).unwrap_err();
    assert_eq!(error.code(), "DESKTOP_OPEN_PATH_DENIED");
}

#[test]
fn open_path_normalizes_existing_and_missing_paths() {
    let current = std::env::current_dir().unwrap();
    let existing = OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: current.to_string_lossy().into_owned(),
        with: None,
    })
    .unwrap();
    assert_eq!(existing.path(), std::fs::canonicalize(&current).unwrap());

    let missing_input = current.join("target/aio-platform-missing/./child.txt");
    let expected: PathBuf = missing_input.components().collect();
    let missing = OpenPathCandidate::try_from(DesktopOpenPathRequest {
        path: missing_input.to_string_lossy().into_owned(),
        with: None,
    })
    .unwrap();
    assert_eq!(missing.path(), expected);
}

#[test]
fn notification_validation_keeps_existing_limits_and_codes() {
    let notification = Notification::try_from(DesktopNotificationPayload {
        title: format!("  {}tail  ", "t".repeat(256)),
        body: "  body  ".to_string(),
        sound: Some("  ping  ".to_string()),
    })
    .unwrap();

    assert_eq!(notification.title().len(), 256);
    assert_eq!(notification.body(), "body");
    assert_eq!(notification.sound(), Some("ping"));

    let error = Notification::try_from(DesktopNotificationPayload {
        title: " ".to_string(),
        body: "body".to_string(),
        sound: None,
    })
    .unwrap_err();
    assert_eq!(error.code(), "NOTICE_INVALID_TITLE");

    let error = Notification::try_from(DesktopNotificationPayload {
        title: "title".to_string(),
        body: " \n ".to_string(),
        sound: None,
    })
    .unwrap_err();
    assert_eq!(error.code(), "NOTICE_INVALID_BODY");

    let notification = Notification::try_from(DesktopNotificationPayload {
        title: "title".to_string(),
        body: format!("{}tail", "体".repeat(4_096)),
        sound: Some(format!("{}tail", "声".repeat(128))),
    })
    .unwrap();
    assert_eq!(notification.body().chars().count(), 4_096);
    assert_eq!(notification.sound().unwrap().chars().count(), 128);
}

#[test]
fn notification_permission_state_keeps_kebab_case_wire_values() {
    assert_eq!(
        serde_json::to_value(DesktopNotificationPermissionState::PromptWithRationale).unwrap(),
        "prompt-with-rationale"
    );
}

#[test]
fn updater_metadata_keeps_existing_camel_case_shape() {
    let metadata = DesktopUpdaterMetadata::from(UpdateMetadata {
        id: UpdateId::new(42),
        current_version: "1.0.0".to_string(),
        version: "1.1.0".to_string(),
        date: Some("2026-07-17".to_string()),
        body: None,
    });

    assert_eq!(
        serde_json::to_value(metadata).unwrap(),
        serde_json::json!({
            "rid": 42,
            "currentVersion": "1.0.0",
            "version": "1.1.0",
            "date": "2026-07-17",
            "body": null
        })
    );
}

#[test]
fn updater_requests_carry_timeout_and_cancellation() {
    let cancellation = CancellationToken::new();
    let check = UpdateCheckRequest::new(Some(Duration::from_millis(250)), cancellation.clone());
    let install = UpdateInstallRequest::new(
        UpdateId::new(7),
        Some(Duration::from_secs(1)),
        cancellation.clone(),
    );

    assert_eq!(check.timeout(), Some(Duration::from_millis(250)));
    assert_eq!(install.id(), UpdateId::new(7));
    assert_eq!(install.timeout(), Some(Duration::from_secs(1)));
    cancellation.cancel();
    assert!(check.cancellation().is_cancelled());
    assert!(install.cancellation().is_cancelled());
}

#[test]
fn updater_progress_is_transport_neutral() {
    assert_eq!(
        UpdateProgressEvent::Started {
            content_length: Some(1024)
        },
        UpdateProgressEvent::Started {
            content_length: Some(1024)
        }
    );
    assert_eq!(
        UpdateProgressEvent::Progress { chunk_length: 128 },
        UpdateProgressEvent::Progress { chunk_length: 128 }
    );
    assert_eq!(UpdateProgressEvent::Finished, UpdateProgressEvent::Finished);
}
