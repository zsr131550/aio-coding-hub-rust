//! Usage: Notification-related Tauri commands.

use crate::notice;

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoticeSendInput {
    level: notice::NoticeLevel,
    title: Option<String>,
    body: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn notice_send(app: tauri::AppHandle, input: NoticeSendInput) -> Result<bool, String> {
    let payload = notice::build(input.level, input.title, input.body)?;
    let events = crate::app::core_runtime::event_sink(&app);
    notice::emit(events.as_ref(), payload)?;
    Ok(true)
}
