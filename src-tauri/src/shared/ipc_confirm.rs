use serde::{Deserialize, Serialize};

pub(crate) const MAX_TTL_MS: i64 = 5 * 60 * 1000;
pub(crate) const MAX_FUTURE_SKEW_MS: i64 = 30 * 1000;
pub(crate) const MIN_NONCE_LEN: usize = 16;
pub(crate) const MAX_NONCE_LEN: usize = 128;

pub(crate) const SEC_CONFIRM_REQUIRED: &str = "SEC_CONFIRM_REQUIRED";
pub(crate) const SEC_CONFIRM_ACTION_MISMATCH: &str = "SEC_CONFIRM_ACTION_MISMATCH";
pub(crate) const SEC_CONFIRM_RESOURCE_MISMATCH: &str = "SEC_CONFIRM_RESOURCE_MISMATCH";
pub(crate) const SEC_CONFIRM_TTL_INVALID: &str = "SEC_CONFIRM_TTL_INVALID";
pub(crate) const SEC_CONFIRM_ISSUED_AT_INVALID: &str = "SEC_CONFIRM_ISSUED_AT_INVALID";
pub(crate) const SEC_CONFIRM_NONCE_INVALID: &str = "SEC_CONFIRM_NONCE_INVALID";
pub(crate) const SEC_CONFIRM_EXPIRED: &str = "SEC_CONFIRM_EXPIRED";

pub(crate) const CONFIRM_ERROR_CODES: &[&str] = &[
    SEC_CONFIRM_REQUIRED,
    SEC_CONFIRM_ACTION_MISMATCH,
    SEC_CONFIRM_RESOURCE_MISMATCH,
    SEC_CONFIRM_TTL_INVALID,
    SEC_CONFIRM_ISSUED_AT_INVALID,
    SEC_CONFIRM_NONCE_INVALID,
    SEC_CONFIRM_EXPIRED,
];

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RiskyIpcOperation {
    pub(crate) command: &'static str,
    pub(crate) action: &'static str,
    pub(crate) resource_template: &'static str,
}

impl RiskyIpcOperation {
    pub(crate) fn require(
        &self,
        confirm: Option<RiskyIpcConfirm>,
        resource: impl Into<String>,
    ) -> Result<(), String> {
        RiskyIpcConfirm::require(confirm, self.action, resource)
    }
}

pub(crate) const RISKY_CONFIG_IMPORT: RiskyIpcOperation = RiskyIpcOperation {
    command: "config_import",
    action: "config_import",
    resource_template: "{filePath}",
};
pub(crate) const RISKY_APP_DATA_RESET: RiskyIpcOperation = RiskyIpcOperation {
    command: "app_data_reset",
    action: "app_data_reset",
    resource_template: "app_data",
};
pub(crate) const RISKY_DESKTOP_UPDATER_INSTALL: RiskyIpcOperation = RiskyIpcOperation {
    command: "desktop_updater_download_and_install",
    action: "desktop_updater_download_and_install",
    resource_template: "updater:{resourceId}",
};
pub(crate) const RISKY_SKILL_LOCAL_DELETE: RiskyIpcOperation = RiskyIpcOperation {
    command: "skill_local_delete",
    action: "skill_local_delete",
    resource_template: "workspace:{workspaceId}:skill-local:{dirName}",
};
pub(crate) const RISKY_PROVIDER_API_KEY_CLIPBOARD: RiskyIpcOperation = RiskyIpcOperation {
    command: "provider_copy_api_key_to_clipboard",
    action: "provider_copy_api_key_to_clipboard",
    resource_template: "provider:{providerId}:api_key",
};
pub(crate) const RISKY_PROVIDER_CODEX_QUOTA_RESET: RiskyIpcOperation = RiskyIpcOperation {
    command: "provider_oauth_reset_codex_quota",
    action: "provider_oauth_reset_codex_quota",
    resource_template: "provider:{providerId}:codex_reset_credit",
};

pub(crate) const RISKY_IPC_OPERATIONS: &[RiskyIpcOperation] = &[
    RISKY_CONFIG_IMPORT,
    RISKY_APP_DATA_RESET,
    RISKY_DESKTOP_UPDATER_INSTALL,
    RISKY_SKILL_LOCAL_DELETE,
    RISKY_PROVIDER_API_KEY_CLIPBOARD,
    RISKY_PROVIDER_CODEX_QUOTA_RESET,
];

fn confirm_error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcConfirm {
    pub(crate) action: String,
    pub(crate) resource: String,
    pub(crate) nonce: String,
    pub(crate) issued_at_ms: i64,
    pub(crate) ttl_ms: i64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RiskyIpcConfirm {
    pub(crate) confirm: IpcConfirm,
}

impl RiskyIpcConfirm {
    pub(crate) fn require(
        confirm: Option<Self>,
        expected_action: &str,
        expected_resource: impl Into<String>,
    ) -> Result<(), String> {
        let expected_resource = expected_resource.into();
        let confirm = confirm.ok_or_else(|| {
            confirm_error(SEC_CONFIRM_REQUIRED, "risky ipc confirmation is required")
        })?;
        confirm.confirm.validate(
            expected_action,
            &expected_resource,
            crate::shared::time::now_unix_millis(),
        )
    }
}

impl IpcConfirm {
    fn validate(
        &self,
        expected_action: &str,
        expected_resource: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        if self.action != expected_action {
            return Err(confirm_error(
                SEC_CONFIRM_ACTION_MISMATCH,
                "risky ipc action mismatch",
            ));
        }
        if self.resource != expected_resource {
            return Err(confirm_error(
                SEC_CONFIRM_RESOURCE_MISMATCH,
                "risky ipc resource mismatch",
            ));
        }
        if self.ttl_ms <= 0 || self.ttl_ms > MAX_TTL_MS {
            return Err(confirm_error(
                SEC_CONFIRM_TTL_INVALID,
                "risky ipc ttl is invalid",
            ));
        }
        if self.issued_at_ms <= 0 {
            return Err(confirm_error(
                SEC_CONFIRM_ISSUED_AT_INVALID,
                "risky ipc issued_at_ms is invalid",
            ));
        }
        if !is_nonce_valid(&self.nonce) {
            return Err(confirm_error(
                SEC_CONFIRM_NONCE_INVALID,
                "risky ipc nonce is invalid",
            ));
        }

        let age_ms = now_ms.saturating_sub(self.issued_at_ms);
        if self.issued_at_ms > now_ms.saturating_add(MAX_FUTURE_SKEW_MS) || age_ms > self.ttl_ms {
            return Err(confirm_error(
                SEC_CONFIRM_EXPIRED,
                "risky ipc confirmation expired",
            ));
        }

        Ok(())
    }
}

fn is_nonce_valid(nonce: &str) -> bool {
    let len = nonce.len();
    (MIN_NONCE_LEN..=MAX_NONCE_LEN).contains(&len)
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::{
        IpcConfirm, RiskyIpcConfirm, CONFIRM_ERROR_CODES, RISKY_IPC_OPERATIONS,
        RISKY_PROVIDER_CODEX_QUOTA_RESET,
    };

    fn confirm(action: &str, resource: &str, issued_at_ms: i64) -> RiskyIpcConfirm {
        RiskyIpcConfirm {
            confirm: IpcConfirm {
                action: action.to_string(),
                resource: resource.to_string(),
                nonce: "abcDEF1234567890".to_string(),
                issued_at_ms,
                ttl_ms: 60_000,
            },
        }
    }

    #[test]
    fn require_rejects_missing_confirm() {
        let err = RiskyIpcConfirm::require(None, "app_data_reset", "app_data").unwrap_err();
        assert!(err.starts_with("SEC_CONFIRM_REQUIRED:"));
    }

    #[test]
    fn validate_rejects_wrong_action_resource_and_expired_payload() {
        let valid = confirm("config_import", "/tmp/a.json", 1_000);
        assert!(valid
            .confirm
            .validate("config_import", "/tmp/a.json", 2_000)
            .is_ok());

        let wrong_action = confirm("other", "/tmp/a.json", 1_000);
        assert!(wrong_action
            .confirm
            .validate("config_import", "/tmp/a.json", 2_000)
            .unwrap_err()
            .starts_with("SEC_CONFIRM_ACTION_MISMATCH:"));

        let wrong_resource = confirm("config_import", "/tmp/b.json", 1_000);
        assert!(wrong_resource
            .confirm
            .validate("config_import", "/tmp/a.json", 2_000)
            .unwrap_err()
            .starts_with("SEC_CONFIRM_RESOURCE_MISMATCH:"));

        let expired = confirm("config_import", "/tmp/a.json", 1_000);
        assert!(expired
            .confirm
            .validate("config_import", "/tmp/a.json", 62_000)
            .unwrap_err()
            .starts_with("SEC_CONFIRM_EXPIRED:"));
    }

    #[test]
    fn compatibility_matrix_lists_all_risky_operations_and_errors() {
        assert_eq!(RISKY_IPC_OPERATIONS.len(), 6);
        assert_eq!(CONFIRM_ERROR_CODES.len(), 7);

        let mut commands = RISKY_IPC_OPERATIONS
            .iter()
            .map(|operation| operation.command)
            .collect::<Vec<_>>();
        commands.sort_unstable();
        commands.dedup();
        assert_eq!(commands.len(), RISKY_IPC_OPERATIONS.len());
        assert!(CONFIRM_ERROR_CODES
            .iter()
            .all(|code| code.starts_with("SEC_CONFIRM_")));
        assert_eq!(
            RISKY_PROVIDER_CODEX_QUOTA_RESET.resource_template,
            "provider:{providerId}:codex_reset_credit"
        );
    }
}
