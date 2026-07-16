//! Notice（系统通知）模块。
//!
//! 用法：
//! - 前端：`invoke("notice_send", { level, title?, body })` 触发通知
//! - Rust 后台：调用 `notice::emit(app, payload)` 触发通知事件（由前端统一监听并发送系统通知）

pub use aio_contract::{NoticeEventPayload, NoticeLevel, NOTICE_EVENT_NAME};
pub const NOTICE_TITLE_MAX_CHARS: usize = 128;
pub const NOTICE_BODY_MAX_CHARS: usize = 4096;

const NOTICE_PREFIX: &str = "AIO Coding Hub";

fn default_title(level: NoticeLevel) -> &'static str {
    match level {
        NoticeLevel::Info => "提示",
        NoticeLevel::Success => "成功",
        NoticeLevel::Warning => "提醒",
        NoticeLevel::Error => "错误",
    }
}

fn invalid_notice_input(message: impl Into<String>) -> crate::shared::error::AppError {
    crate::shared::error::AppError::new("SEC_INVALID_INPUT", message)
}

fn validate_max_chars(
    label: &str,
    value: &str,
    max_chars: usize,
) -> crate::shared::error::AppResult<()> {
    if value.chars().count() > max_chars {
        return Err(invalid_notice_input(format!(
            "{label} is too long (max {max_chars} chars)"
        )));
    }
    Ok(())
}

fn normalize_optional_title(
    title: Option<String>,
) -> crate::shared::error::AppResult<Option<String>> {
    let Some(title) = title else {
        return Ok(None);
    };
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    validate_max_chars("title", trimmed, NOTICE_TITLE_MAX_CHARS)?;
    Ok(Some(trimmed.to_string()))
}

fn normalize_body(body: String) -> crate::shared::error::AppResult<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(invalid_notice_input("body is required"));
    }
    validate_max_chars("body", trimmed, NOTICE_BODY_MAX_CHARS)?;
    Ok(trimmed.to_string())
}

fn format_title(
    level: NoticeLevel,
    title: Option<String>,
) -> crate::shared::error::AppResult<String> {
    let title =
        normalize_optional_title(title)?.unwrap_or_else(|| default_title(level).to_string());
    Ok(format!("{NOTICE_PREFIX} · {title}"))
}

pub fn build(
    level: NoticeLevel,
    title: Option<String>,
    body: String,
) -> crate::shared::error::AppResult<NoticeEventPayload> {
    Ok(NoticeEventPayload {
        level,
        title: format_title(level, title)?,
        body: normalize_body(body)?,
    })
}

pub fn emit(
    events: &dyn aio_core::EventSink,
    payload: NoticeEventPayload,
) -> crate::shared::error::AppResult<()> {
    events.publish(aio_contract::AppEvent::NoticeRequested(payload));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aio_core::RecordingEventSink;

    #[test]
    fn emit_publishes_typed_notice_event() {
        let events = RecordingEventSink::default();
        let payload = NoticeEventPayload {
            level: NoticeLevel::Info,
            title: "Title".to_string(),
            body: "Body".to_string(),
        };

        emit(&events, payload).expect("publish notice");

        let published = events.events();
        assert_eq!(published.len(), 1);
        let aio_contract::AppEvent::NoticeRequested(actual) = &published[0] else {
            panic!("expected typed notice event");
        };
        assert_eq!(actual.title, "Title");
        assert_eq!(actual.body, "Body");
    }

    #[test]
    fn build_trims_title_and_body() {
        let payload = build(
            NoticeLevel::Success,
            Some("  Saved  ".to_string()),
            "  Done  ".to_string(),
        )
        .expect("notice should build");

        assert_eq!(payload.title, "AIO Coding Hub · Saved");
        assert_eq!(payload.body, "Done");
    }

    #[test]
    fn build_uses_default_title_for_empty_title() {
        let payload = build(
            NoticeLevel::Info,
            Some("   ".to_string()),
            "Ready".to_string(),
        )
        .expect("notice should build");

        assert_eq!(payload.title, "AIO Coding Hub · 提示");
        assert_eq!(payload.body, "Ready");
    }

    #[test]
    fn build_rejects_empty_body() {
        let err = build(NoticeLevel::Info, None, " \n\t ".to_string()).expect_err("blank body");

        assert_eq!(err.to_string(), "SEC_INVALID_INPUT: body is required");
    }

    #[test]
    fn build_rejects_oversized_title() {
        let err = build(
            NoticeLevel::Warning,
            Some("x".repeat(NOTICE_TITLE_MAX_CHARS + 1)),
            "Body".to_string(),
        )
        .expect_err("oversized title");

        assert_eq!(
            err.to_string(),
            "SEC_INVALID_INPUT: title is too long (max 128 chars)"
        );
    }

    #[test]
    fn build_rejects_oversized_body() {
        let err = build(
            NoticeLevel::Error,
            Some("Title".to_string()),
            "x".repeat(NOTICE_BODY_MAX_CHARS + 1),
        )
        .expect_err("oversized body");

        assert_eq!(
            err.to_string(),
            "SEC_INVALID_INPUT: body is too long (max 4096 chars)"
        );
    }

    #[test]
    fn build_counts_multibyte_chars_by_character() {
        let payload = build(
            NoticeLevel::Info,
            Some("界".repeat(NOTICE_TITLE_MAX_CHARS)),
            "好".repeat(NOTICE_BODY_MAX_CHARS),
        )
        .expect("max-sized multibyte notice should build");

        assert_eq!(
            payload.title.chars().count(),
            "AIO Coding Hub · ".chars().count() + 128
        );
        assert_eq!(payload.body.chars().count(), 4096);
    }
}
