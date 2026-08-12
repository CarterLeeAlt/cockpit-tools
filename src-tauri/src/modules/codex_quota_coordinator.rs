use crate::models::codex::CodexQuota;
use crate::modules::{app_lifecycle, codex_account, codex_quota, config, logger};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{Mutex as TokioMutex, OwnedMutexGuard, Semaphore};

const SCHEDULER_TICK: Duration = Duration::from_secs(5);
const MIN_REMOTE_INTERVAL_SECONDS: i64 = 30;
const FAILURE_BACKOFF_SECONDS: [i64; 5] = [60, 120, 300, 600, 900];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshReason {
    Scheduled,
    Manual,
    LoginOrImport,
    ApiRequest,
    ApiReserve,
}

impl RefreshReason {
    fn label(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Manual => "manual",
            Self::LoginOrImport => "login_or_import",
            Self::ApiRequest => "api_request",
            Self::ApiReserve => "api_reserve",
        }
    }

    fn is_background_batch(self) -> bool {
        matches!(self, Self::Scheduled)
    }
}

#[derive(Debug, Clone, Default)]
struct AccountRefreshState {
    last_attempt_at: Option<i64>,
    last_success_at: Option<i64>,
    retry_at: Option<i64>,
    consecutive_failures: usize,
}

fn account_locks() -> &'static TokioMutex<HashMap<String, Arc<TokioMutex<()>>>> {
    static LOCKS: OnceLock<TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| TokioMutex::new(HashMap::new()))
}

fn refresh_states() -> &'static TokioMutex<HashMap<String, AccountRefreshState>> {
    static STATES: OnceLock<TokioMutex<HashMap<String, AccountRefreshState>>> = OnceLock::new();
    STATES.get_or_init(|| TokioMutex::new(HashMap::new()))
}

fn global_remote_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(4)))
}

fn openai_remote_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(2)))
}

fn scheduled_remote_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(1)))
}

static CURRENT_ACCOUNT_INTERVAL_SECONDS: AtomicI64 = AtomicI64::new(60);

pub fn configure_current_account_interval(minutes: i32) {
    let seconds = if minutes > 0 {
        i64::from(minutes).saturating_mul(60)
    } else {
        -1
    };
    CURRENT_ACCOUNT_INTERVAL_SECONDS.store(seconds, Ordering::SeqCst);
}

async fn account_guard(account_id: &str) -> (OwnedMutexGuard<()>, bool) {
    let lock = {
        let mut locks = account_locks().lock().await;
        locks
            .entry(account_id.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
    };
    match lock.clone().try_lock_owned() {
        Ok(guard) => (guard, false),
        Err(_) => (lock.lock_owned().await, true),
    }
}

fn now_timestamp() -> i64 {
    chrono::Utc::now().timestamp()
}

fn effective_interval_seconds(account_id: &str, is_current: bool) -> Option<i64> {
    use codex_account::CodexGroupQuotaRefreshPolicy;

    let policy = codex_account::quota_refresh_policy_for_account(account_id);
    if policy == CodexGroupQuotaRefreshPolicy::Disabled {
        return None;
    }
    let current_seconds = is_current
        .then(|| CURRENT_ACCOUNT_INTERVAL_SECONDS.load(Ordering::SeqCst))
        .filter(|seconds| *seconds > 0);
    let background_seconds = match policy {
        CodexGroupQuotaRefreshPolicy::Disabled => unreachable!(),
        CodexGroupQuotaRefreshPolicy::Minutes(minutes) => Some(i64::from(minutes) * 60),
        CodexGroupQuotaRefreshPolicy::Inherit => {
            let configured = config::get_user_config().codex_auto_refresh_minutes;
            if configured <= 0 {
                return None;
            }
            Some(i64::from(configured) * 60)
        }
    };
    match (background_seconds, current_seconds) {
        (Some(background), Some(current)) => Some(background.min(current)),
        (Some(background), None) => Some(background),
        (None, Some(current)) => Some(current),
        (None, None) => None,
    }
}

fn account_is_due(
    account_id: &str,
    usage_updated_at: Option<i64>,
    interval_seconds: i64,
    now: i64,
) -> bool {
    let stable_offset = account_id.bytes().fold(0_u64, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(u64::from(byte))
    }) % ((interval_seconds / 10).max(1) as u64);
    usage_updated_at
        .map(|updated_at| now >= updated_at.saturating_add(interval_seconds + stable_offset as i64))
        .unwrap_or(true)
}

async fn should_skip(account_id: &str, now: i64) -> bool {
    let states = refresh_states().lock().await;
    let Some(state) = states.get(account_id) else {
        return false;
    };
    if state.retry_at.is_some_and(|retry_at| retry_at > now) {
        return true;
    }
    if state
        .last_attempt_at
        .is_some_and(|attempt| now.saturating_sub(attempt) < MIN_REMOTE_INTERVAL_SECONDS)
    {
        return true;
    }
    false
}

async fn record_result(account_id: &str, result: &Result<CodexQuota, String>, now: i64) {
    let mut states = refresh_states().lock().await;
    let state = states.entry(account_id.to_string()).or_default();
    state.last_attempt_at = Some(now);
    if result.is_ok() {
        state.last_success_at = Some(now);
        state.retry_at = None;
        state.consecutive_failures = 0;
    } else {
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        let index = state
            .consecutive_failures
            .saturating_sub(1)
            .min(FAILURE_BACKOFF_SECONDS.len() - 1);
        state.retry_at = Some(now.saturating_add(FAILURE_BACKOFF_SECONDS[index]));
    }
}

/// 所有持久化账号的远端额度刷新都必须经过此入口。
pub async fn refresh_account(
    account_id: &str,
    reason: RefreshReason,
    options: codex_quota::RefreshQuotaOptions,
) -> Result<CodexQuota, String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return Err("Codex 账号 ID 不能为空".to_string());
    }
    // 后台批次只允许一个账号进入账号锁/远端许可队列，为启动预热和手动刷新保留通道。
    // 必须在 account_guard 前获取，否则一批后台任务会先锁住多个账号，启动预热仍会排队数分钟。
    let _scheduled_permit = if reason.is_background_batch() {
        Some(
            scheduled_remote_semaphore()
                .clone()
                .acquire_owned()
                .await
                .map_err(|error| format!("获取 Codex 后台刷新许可失败: {}", error))?,
        )
    } else {
        None
    };
    let (_guard, joined_existing) = account_guard(account_id).await;
    if joined_existing {
        let account = codex_account::load_account(account_id)
            .ok_or_else(|| format!("未找到 Codex 账号: {}", account_id))?;
        if let Some(error) = account.quota_error {
            return Err(error.message);
        }
        if let Some(quota) = account.quota {
            logger::log_info(&format!(
                "[Codex Quota Coordinator] 复用进行中的刷新结果: account_id={}, reason={}",
                account_id,
                reason.label()
            ));
            return Ok(quota);
        }
        return Err("Codex 额度刷新完成但没有可用数据".to_string());
    }
    let now = now_timestamp();
    if should_skip(account_id, now).await {
        let account = codex_account::load_account(account_id)
            .ok_or_else(|| format!("未找到 Codex 账号: {}", account_id))?;
        if let Some(quota) = account.quota {
            logger::log_info(&format!(
                "[Codex Quota Coordinator] 合并额度刷新: account_id={}, reason={}",
                account_id,
                reason.label()
            ));
            return Ok(quota);
        }
        return Err("Codex 额度刷新处于退避期，且暂无可用缓存".to_string());
    }

    logger::log_info(&format!(
        "[Codex Quota Coordinator] 开始额度刷新: account_id={}, reason={}",
        account_id,
        reason.label()
    ));
    let _global_permit = global_remote_semaphore()
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| format!("获取 Codex 全局刷新许可失败: {}", error))?;
    let account = codex_account::load_account(account_id)
        .ok_or_else(|| format!("未找到 Codex 账号: {}", account_id))?;
    let _openai_permit = if account.is_api_key_auth() {
        None
    } else {
        Some(
            openai_remote_semaphore()
                .clone()
                .acquire_owned()
                .await
                .map_err(|error| format!("获取 OpenAI 额度刷新许可失败: {}", error))?,
        )
    };
    let result = codex_quota::refresh_account_quota_uncoordinated(account_id, options).await;
    record_result(account_id, &result, now_timestamp()).await;
    if result.is_ok() {
        if let Some(app) = crate::get_app_handle() {
            let _ = app.emit("codex:quota-updated", account_id);
        }
    }
    result
}

async fn run_scheduled_refreshes() {
    let accounts = codex_account::list_accounts();
    let current_id = codex_account::get_current_account().map(|account| account.id);
    let now = now_timestamp();
    let due_ids = accounts
        .iter()
        .filter(|account| codex_quota::supports_quota_refresh(account))
        .filter_map(|account| {
            let interval = effective_interval_seconds(
                &account.id,
                current_id.as_deref() == Some(account.id.as_str()),
            )?;
            account_is_due(&account.id, account.usage_updated_at, interval, now)
                .then(|| account.id.clone())
        })
        .collect::<Vec<_>>();

    if due_ids.is_empty() {
        return;
    }
    let previous_updates = due_ids
        .iter()
        .map(|account_id| {
            (
                account_id.clone(),
                codex_account::load_account(account_id)
                    .and_then(|account| account.usage_updated_at),
            )
        })
        .collect::<HashMap<_, _>>();
    let results = codex_quota::refresh_quotas_for_account_ids_with_reason(
        &due_ids,
        false,
        RefreshReason::Scheduled,
    )
    .await;
    let cache_was_updated = results.as_ref().is_ok_and(|items| {
        items.iter().any(|(account_id, result)| {
            result.is_ok()
                && codex_account::load_account(account_id)
                    .and_then(|account| account.usage_updated_at)
                    > previous_updates.get(account_id).copied().flatten()
        })
    });
    if cache_was_updated {
        if let Some(app) = crate::get_app_handle() {
            crate::commands::codex::run_codex_post_refresh_checks(&app).await;
            let _ = crate::modules::tray::update_tray_menu(&app);
        }
    }
}

pub fn trigger_api_request_refresh(account_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(account) = codex_account::load_account(account_id.trim()) else {
            return;
        };
        if !codex_quota::supports_quota_refresh(&account) {
            return;
        }
        let _ = refresh_account(
            &account.id,
            RefreshReason::ApiRequest,
            codex_quota::RefreshQuotaOptions::default(),
        )
        .await;
    });
}

pub fn ensure_started() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval_at(tokio::time::Instant::now() + SCHEDULER_TICK, SCHEDULER_TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if app_lifecycle::is_shutdown_started() {
                break;
            }
            run_scheduled_refreshes().await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{account_is_due, RefreshReason, FAILURE_BACKOFF_SECONDS};

    #[test]
    fn stale_accounts_are_due_and_fresh_accounts_are_not() {
        assert!(account_is_due("account-a", Some(100), 60, 200));
        assert!(!account_is_due("account-a", Some(190), 60, 200));
        assert!(account_is_due("account-a", None, 60, 200));
    }

    #[test]
    fn failure_backoff_is_bounded() {
        assert_eq!(FAILURE_BACKOFF_SECONDS, [60, 120, 300, 600, 900]);
    }

    #[test]
    fn scheduled_refresh_is_the_only_low_priority_reason() {
        assert!(RefreshReason::Scheduled.is_background_batch());
        assert!(!RefreshReason::Manual.is_background_batch());
    }
}
