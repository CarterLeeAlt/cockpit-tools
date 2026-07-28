import { listWorkbuddyAccounts, getCheckinStatusWorkbuddy, checkinWorkbuddy } from './workbuddyService';
import { useWorkbuddyAccountStore } from '../stores/useWorkbuddyAccountStore';

export interface WorkbuddyAccountScheduleState {
  scheduledDate: string;        // "YYYY-MM-DD"
  scheduledMinute: number;      // Minutes from midnight (0..1439)
  lastCheckedDate?: string;     // "YYYY-MM-DD" when checked in
}

export interface WorkbuddyAutoCheckinConfig {
  enabled: boolean;
  startTime: string; // HH:mm, e.g. "06:00"
  endTime: string;   // HH:mm, e.g. "12:00"
  lastCheckedDate?: string; // "YYYY-MM-DD"
  accountSchedules?: Record<string, WorkbuddyAccountScheduleState>;
}

export const DEFAULT_WORKBUDDY_AUTO_CHECKIN_CONFIG: WorkbuddyAutoCheckinConfig = {
  // 签到会对所有已保存账号发起远程请求，必须由用户显式开启。
  enabled: false,
  startTime: '06:00',
  endTime: '12:00',
};

const CONFIG_KEY = 'agtools.workbuddy.auto_checkin_config';
export const WORKBUDDY_AUTO_CHECKIN_CONFIG_CHANGED_EVENT = 'workbuddy-auto-checkin-config-changed';
const AUTO_CHECKIN_RETRY_DELAY_MS = 5 * 60 * 1000;
const AUTO_CHECKIN_IDLE_RECHECK_DELAY_MS = 60 * 60 * 1000;

export type WorkbuddyAutoCheckinCycleResult = 'disabled' | 'waiting' | 'completed' | 'retry';

function isValidTime(time: unknown): time is string {
  return typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function getWorkbuddyAutoCheckinConfig(): WorkbuddyAutoCheckinConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_WORKBUDDY_AUTO_CHECKIN_CONFIG;
  }
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) {
      return DEFAULT_WORKBUDDY_AUTO_CHECKIN_CONFIG;
    }
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      startTime: isValidTime(parsed.startTime) ? parsed.startTime : '06:00',
      endTime: isValidTime(parsed.endTime) ? parsed.endTime : '12:00',
      lastCheckedDate: typeof parsed.lastCheckedDate === 'string' ? parsed.lastCheckedDate : undefined,
      accountSchedules: typeof parsed.accountSchedules === 'object' && parsed.accountSchedules !== null ? parsed.accountSchedules : undefined,
    };
  } catch {
    return DEFAULT_WORKBUDDY_AUTO_CHECKIN_CONFIG;
  }
}

export function saveWorkbuddyAutoCheckinConfig(config: WorkbuddyAutoCheckinConfig): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.dispatchEvent(new Event(WORKBUDDY_AUTO_CHECKIN_CONFIG_CHANGED_EVENT));
  } catch (err) {
    console.warn('[WorkbuddyAutoCheckin] 保存配置失败:', err);
  }
}

export function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 60 + m;
}

export function formatMinutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getTodayDateString(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatTimeOnly(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function ensureAccountSchedules(
  config: WorkbuddyAutoCheckinConfig,
  accounts: Array<{ id: string; email?: string }>,
): WorkbuddyAutoCheckinConfig {
  const todayStr = getTodayDateString();
  const startMin = parseTimeToMinutes(config.startTime);
  let endMin = parseTimeToMinutes(config.endTime);
  if (endMin < startMin) {
    endMin = startMin;
  }
  const minRange = Math.max(0, endMin - startMin);

  const existingSchedules = config.accountSchedules || {};
  let changed = false;
  const updatedSchedules: Record<string, WorkbuddyAccountScheduleState> = { ...existingSchedules };

  for (const account of accounts) {
    const existing = existingSchedules[account.id];
    if (
      existing &&
      existing.scheduledDate === todayStr &&
      existing.scheduledMinute >= startMin &&
      existing.scheduledMinute <= endMin
    ) {
      continue;
    }

    // 每个不同账号，在时间段内随机分配各自的签到时间
    const randomOffset = minRange > 0 ? Math.floor(Math.random() * (minRange + 1)) : 0;
    const scheduledMinute = startMin + randomOffset;

    updatedSchedules[account.id] = {
      scheduledDate: todayStr,
      scheduledMinute,
      lastCheckedDate: existing?.lastCheckedDate === todayStr ? todayStr : undefined,
    };
    changed = true;
  }

  if (changed) {
    const updatedConfig: WorkbuddyAutoCheckinConfig = {
      ...config,
      accountSchedules: updatedSchedules,
    };
    saveWorkbuddyAutoCheckinConfig(updatedConfig);
    return updatedConfig;
  }

  return config;
}

let isAutoCheckinCycleRunning = false;

function getMillisecondsUntilNextLocalDay(now: Date): number {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 1, 0);
  return Math.max(1_000, nextDay.getTime() - now.getTime());
}

export function getWorkbuddyAutoCheckinNextDelayMs(
  result?: WorkbuddyAutoCheckinCycleResult,
  accounts: Array<{ id: string }> = [],
): number {
  const config = getWorkbuddyAutoCheckinConfig();
  if (!config.enabled) {
    return AUTO_CHECKIN_IDLE_RECHECK_DELAY_MS;
  }

  if (result === 'retry') {
    return AUTO_CHECKIN_RETRY_DELAY_MS;
  }

  const now = new Date();
  const todayStr = getTodayDateString();
  const updatedConfig = ensureAccountSchedules(config, accounts);
  const schedules = updatedConfig.accountSchedules || {};

  const currentMinute = now.getHours() * 60 + now.getMinutes();
  let nextScheduledMinute: number | null = null;

  for (const accId of Object.keys(schedules)) {
    const sch = schedules[accId];
    if (!sch) continue;
    if (sch.lastCheckedDate !== todayStr) {
      if (nextScheduledMinute === null || sch.scheduledMinute < nextScheduledMinute) {
        nextScheduledMinute = sch.scheduledMinute;
      }
    }
  }

  if (nextScheduledMinute === null) {
    return getMillisecondsUntilNextLocalDay(now);
  }

  if (currentMinute >= nextScheduledMinute) {
    return 1000;
  }

  const scheduledAt = new Date(now);
  scheduledAt.setHours(Math.floor(nextScheduledMinute / 60), nextScheduledMinute % 60, 0, 0);
  return Math.max(1_000, scheduledAt.getTime() - now.getTime());
}

export interface WorkbuddyAutoCheckinAccountDetail {
  accountId: string;
  email: string;
  status: 'success' | 'already_checked' | 'failed' | 'inactive';
  time?: string; // e.g. "16:17:02"
  message?: string;
  credit?: number;
}

export interface WorkbuddyAutoCheckinLogRecord {
  id: string;
  timestamp: string; // formatted e.g. "YYYY-MM-DD HH:mm:ss"
  date: string;      // "YYYY-MM-DD"
  durationMs: number;
  totalAccounts: number;
  successCount: number;
  alreadyCheckedCount: number;
  failedCount: number;
  status: 'success' | 'partial' | 'failed' | 'no_accounts';
  details: WorkbuddyAutoCheckinAccountDetail[];
}

const LOGS_KEY = 'agtools.workbuddy.auto_checkin_logs';
export const WORKBUDDY_AUTO_CHECKIN_LOGS_CHANGED_EVENT = 'workbuddy-auto-checkin-logs-changed';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getWorkbuddyAutoCheckinLogs(): WorkbuddyAutoCheckinLogRecord[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = localStorage.getItem(LOGS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as WorkbuddyAutoCheckinLogRecord[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const now = Date.now();
    // 自动过滤并清理超过 30 天的历史记录
    const validLogs = parsed.filter((log) => {
      const logTime = new Date(log.timestamp.replace(' ', 'T')).getTime();
      return !isNaN(logTime) && now - logTime <= THIRTY_DAYS_MS;
    });

    if (validLogs.length !== parsed.length) {
      localStorage.setItem(LOGS_KEY, JSON.stringify(validLogs));
    }
    return validLogs;
  } catch {
    return [];
  }
}

export function saveWorkbuddyAutoCheckinLogs(logs: WorkbuddyAutoCheckinLogRecord[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const now = Date.now();
    // 仅保留近 30 天记录
    const validLogs = logs.filter((log) => {
      const logTime = new Date(log.timestamp.replace(' ', 'T')).getTime();
      return !isNaN(logTime) && now - logTime <= THIRTY_DAYS_MS;
    });
    localStorage.setItem(LOGS_KEY, JSON.stringify(validLogs));
    window.dispatchEvent(new Event(WORKBUDDY_AUTO_CHECKIN_LOGS_CHANGED_EVENT));
  } catch (err) {
    console.warn('[WorkbuddyAutoCheckin] 保存自动签到日志失败:', err);
  }
}

export function addWorkbuddyAutoCheckinLog(record: WorkbuddyAutoCheckinLogRecord): void {
  const currentLogs = getWorkbuddyAutoCheckinLogs();
  const existingIndex = currentLogs.findIndex((l) => l.date === record.date);

  if (existingIndex < 0) {
    saveWorkbuddyAutoCheckinLogs([record, ...currentLogs]);
    return;
  }

  // 一天的所有自动签到记录（独立随机签到/手动测试），合并保存在当天的唯一一条记录中
  const existing = currentLogs[existingIndex];
  if (!existing) {
    saveWorkbuddyAutoCheckinLogs([record, ...currentLogs]);
    return;
  }

  const mergedDetailsMap = new Map<string, WorkbuddyAutoCheckinAccountDetail>();
  for (const d of existing.details) {
    mergedDetailsMap.set(d.accountId, d);
  }
  for (const d of record.details) {
    mergedDetailsMap.set(d.accountId, d);
  }

  const mergedDetails = Array.from(mergedDetailsMap.values());
  let successCount = 0;
  let alreadyCheckedCount = 0;
  let failedCount = 0;

  for (const d of mergedDetails) {
    if (d.status === 'success') successCount++;
    else if (d.status === 'already_checked') alreadyCheckedCount++;
    else if (d.status === 'failed') failedCount++;
  }

  const totalAccounts = mergedDetails.length;
  const overallStatus: WorkbuddyAutoCheckinLogRecord['status'] =
    totalAccounts === 0
      ? 'no_accounts'
      : failedCount === 0
        ? 'success'
        : successCount > 0 || alreadyCheckedCount > 0
          ? 'partial'
          : 'failed';

  const mergedRecord: WorkbuddyAutoCheckinLogRecord = {
    id: existing.id,
    timestamp: record.timestamp, // 记为当天最新签到触发的时间戳
    date: record.date,
    durationMs: existing.durationMs + record.durationMs,
    totalAccounts,
    successCount,
    alreadyCheckedCount,
    failedCount,
    status: overallStatus,
    details: mergedDetails,
  };

  const updatedLogs = [...currentLogs];
  updatedLogs[existingIndex] = mergedRecord;
  saveWorkbuddyAutoCheckinLogs(updatedLogs);
}

export function clearWorkbuddyAutoCheckinLogs(): void {
  saveWorkbuddyAutoCheckinLogs([]);
}

export function formatFormattedTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function runWorkbuddyAutoCheckinCycleIfNeeded(
  force = false,
): Promise<WorkbuddyAutoCheckinCycleResult> {
  const config = getWorkbuddyAutoCheckinConfig();
  if (!config.enabled && !force) {
    return 'disabled';
  }

  if (isAutoCheckinCycleRunning) {
    return 'waiting';
  }

  isAutoCheckinCycleRunning = true;
  const startTime = Date.now();
  const startTimestampStr = formatFormattedTimestamp(new Date(startTime));
  const todayStr = getTodayDateString();

  try {
    console.log('[WorkbuddyAutoCheckin] 检查账号独立随机签到任务...');
    const accounts = await listWorkbuddyAccounts();
    if (accounts.length === 0) {
      if (force) {
        addWorkbuddyAutoCheckinLog({
          id: `log_${startTime}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp: startTimestampStr,
          date: todayStr,
          durationMs: Date.now() - startTime,
          totalAccounts: 0,
          successCount: 0,
          alreadyCheckedCount: 0,
          failedCount: 0,
          status: 'no_accounts',
          details: [],
        });
      }
      return 'completed';
    }

    const updatedConfig = ensureAccountSchedules(config, accounts);
    const schedules = updatedConfig.accountSchedules || {};
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();

    // 筛选今日需进行签到的账号（按各自设定的随机分钟到期且今日未签到）
    const targetAccounts = force
      ? accounts
      : accounts.filter((acc) => {
          const sch = schedules[acc.id];
          if (!sch) return false;
          return sch.scheduledMinute <= currentMinute && sch.lastCheckedDate !== todayStr;
        });

    if (targetAccounts.length === 0) {
      return 'waiting';
    }

    let didCheckinAny = false;
    let retryNeeded = false;
    let successCount = 0;
    let alreadyCheckedCount = 0;
    let failedCount = 0;
    const details: WorkbuddyAutoCheckinAccountDetail[] = [];
    const newSchedules = { ...schedules };

    for (const account of targetAccounts) {
      const emailDisplay = account.email || account.id;
      const accountCheckinTime = formatTimeOnly(new Date());
      try {
        const status = await getCheckinStatusWorkbuddy(account.id);
        if (status.today_checked_in) {
          alreadyCheckedCount++;
          details.push({
            accountId: account.id,
            email: emailDisplay,
            status: 'already_checked',
            time: accountCheckinTime,
            message: '今日已完成签到',
            credit: status.daily_credit ?? undefined,
          });
          newSchedules[account.id] = {
            ...newSchedules[account.id],
            scheduledDate: todayStr,
            scheduledMinute: newSchedules[account.id]?.scheduledMinute ?? currentMinute,
            lastCheckedDate: todayStr,
          };
        } else if (status.active === false) {
          details.push({
            accountId: account.id,
            email: emailDisplay,
            status: 'inactive',
            time: accountCheckinTime,
            message: '签到活动未开启或不适用',
          });
        } else {
          console.log(`[WorkbuddyAutoCheckin] 为账号 ${emailDisplay} 执行自动签到...`);
          const res = await checkinWorkbuddy(account.id);
          if (res.success) {
            didCheckinAny = true;
            successCount++;
            details.push({
              accountId: account.id,
              email: emailDisplay,
              status: 'success',
              time: accountCheckinTime,
              message: res.message || '签到成功',
              credit: res.credit ?? undefined,
            });
            newSchedules[account.id] = {
              ...newSchedules[account.id],
              scheduledDate: todayStr,
              scheduledMinute: newSchedules[account.id]?.scheduledMinute ?? currentMinute,
              lastCheckedDate: todayStr,
            };
          } else {
            const latestStatus = await getCheckinStatusWorkbuddy(account.id);
            if (latestStatus.today_checked_in) {
              alreadyCheckedCount++;
              details.push({
                accountId: account.id,
                email: emailDisplay,
                status: 'already_checked',
                time: accountCheckinTime,
                message: '今日已完成签到',
              });
              newSchedules[account.id] = {
                ...newSchedules[account.id],
                scheduledDate: todayStr,
                scheduledMinute: newSchedules[account.id]?.scheduledMinute ?? currentMinute,
                lastCheckedDate: todayStr,
              };
            } else {
              retryNeeded = true;
              failedCount++;
              details.push({
                accountId: account.id,
                email: emailDisplay,
                status: 'failed',
                time: accountCheckinTime,
                message: res.message || '签到失败',
              });
            }
          }
        }
      } catch (accountErr) {
        const errMsg = accountErr instanceof Error ? accountErr.message : String(accountErr);
        console.warn(`[WorkbuddyAutoCheckin] 账号 ${account.id} 签到检测异常:`, accountErr);
        retryNeeded = true;
        failedCount++;
        details.push({
          accountId: account.id,
          email: emailDisplay,
          status: 'failed',
          time: accountCheckinTime,
          message: errMsg,
        });
      }
    }

    // 保存更新后的账号状态
    saveWorkbuddyAutoCheckinConfig({
      ...updatedConfig,
      accountSchedules: newSchedules,
    });

    const durationMs = Date.now() - startTime;
    const overallStatus: WorkbuddyAutoCheckinLogRecord['status'] =
      failedCount === 0
        ? 'success'
        : successCount > 0 || alreadyCheckedCount > 0
          ? 'partial'
          : 'failed';

    addWorkbuddyAutoCheckinLog({
      id: `log_${startTime}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: startTimestampStr,
      date: todayStr,
      durationMs,
      totalAccounts: targetAccounts.length,
      successCount,
      alreadyCheckedCount,
      failedCount,
      status: overallStatus,
      details,
    });

    if (didCheckinAny) {
      void useWorkbuddyAccountStore.getState().fetchAccounts().catch((err) => {
        console.warn('[WorkbuddyAutoCheckin] 刷新账号列表失败:', err);
      });
    }
    return retryNeeded ? 'retry' : 'completed';
  } catch (err) {
    console.error('[WorkbuddyAutoCheckin] 自动签到周期失败:', err);
    return 'retry';
  } finally {
    isAutoCheckinCycleRunning = false;
  }
}
