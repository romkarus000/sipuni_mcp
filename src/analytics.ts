import { SipuniCallRecord, SipuniClient } from './sipuni.js';

export type PeriodKind =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'compare_weeks'
  | 'compare_months'
  | 'managers_week'
  | 'managers_month';

export type Metrics = {
  total: number;
  answered: number;
  missed: number;
  talkSeconds: number;
};

export type AnalyticsQuery = {
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  managerExtensions?: number[];
  includeDetails?: boolean;
  detailsLimit?: number;
  timezone?: string;
};

export type NormalizedCall = {
  callId: string;
  recordId: string;
  type: SipuniCallRecord['type'];
  status: SipuniCallRecord['status'];
  answered: boolean;
  startedAt: string; // ISO
  date: string; // YYYY-MM-DD (TZ calendar day)
  phone: string;
  managerExtension: string;
  managerName: string;
  durationSeconds: number;
  dialogDurationSeconds: number;
};

const DEFAULT_TZ = 'Europe/Moscow';

export function dateParts(timeZone: string, date = new Date()) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: string) => Number(values.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

export function dateFromParts({ year, month, day }: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

export function sipuniDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date ${value}, expected YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  return dateFromParts({ year, month, day });
}

export function today(timeZone = DEFAULT_TZ): Date {
  return dateFromParts(dateParts(timeZone));
}

export function monday(date: Date): Date {
  const day = date.getUTCDay() || 7;
  return shiftDays(date, 1 - day);
}

export function periodFor(kind: Exclude<PeriodKind, 'compare_weeks' | 'compare_months'>, timeZone = DEFAULT_TZ) {
  const now = today(timeZone);
  if (kind === 'today') return { from: now, to: now, title: 'Статистика за сегодня' };
  if (kind === 'yesterday') {
    const day = shiftDays(now, -1);
    return { from: day, to: day, title: 'Статистика за вчера' };
  }
  if (kind === 'week' || kind === 'managers_week') {
    return {
      from: monday(now),
      to: now,
      title: kind === 'week' ? 'Статистика за текущую неделю' : 'Менеджеры: текущая неделя',
    };
  }
  if (kind === 'month' || kind === 'managers_month') {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: now,
      title: kind === 'month' ? 'Статистика за текущий месяц' : 'Менеджеры: текущий месяц',
    };
  }
  throw new Error(`Unsupported period kind: ${kind}`);
}

export function metrics(calls: SipuniCallRecord[]): Metrics {
  const answered = calls.filter((call) => call.status === 'ANSWER');
  return {
    total: calls.length,
    answered: answered.length,
    missed: calls.filter((call) => call.status === 'NOANSWER' || call.status === 'CANCEL').length,
    talkSeconds: answered.reduce((total, call) => total + call.dialogDuration, 0),
  };
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

export function metricsText(value: Metrics): string {
  return [
    `Всего звонков: ${value.total}`,
    `Отвеченные: ${value.answered}`,
    `Недозвон: ${value.missed}`,
    `Проговорено: ${formatDuration(value.talkSeconds)}`,
  ].join('\n');
}

function managerKey(call: SipuniCallRecord): string {
  const extension = call.shortSrcNum || call.shortDstNum || 'unknown';
  return `${call.managerName || 'Не определён'}|${extension}`;
}

export function managerStats(calls: SipuniCallRecord[]) {
  const groups = new Map<string, SipuniCallRecord[]>();
  for (const call of calls) {
    const key = managerKey(call);
    const bucket = groups.get(key);
    if (bucket) bucket.push(call);
    else groups.set(key, [call]);
  }

  return [...groups.entries()]
    .map(([key, managerCalls]) => {
      const [name, extension] = key.split('|');
      return {
        managerName: name,
        managerExtension: extension === 'unknown' ? null : extension,
        ...metrics(managerCalls),
      };
    })
    .sort((left, right) => right.total - left.total || left.managerName.localeCompare(right.managerName, 'ru'));
}

export function managerReport(calls: SipuniCallRecord[]): string {
  const rows = managerStats(calls);
  if (!rows.length) return 'Звонков за период нет.';
  return rows
    .map((row) => {
      const ext = row.managerExtension ? ` (${row.managerExtension})` : '';
      return `* ${row.managerName}${ext} — ${row.total} / ${row.answered} / ${row.missed} / ${formatDuration(row.talkSeconds)}`;
    })
    .join('\n');
}

export function clientPhone(call: SipuniCallRecord): string {
  if (call.type === 'outbound') return normalizePhone(call.dstNum);
  if (call.type === 'inbound') return normalizePhone(call.srcNum);
  return normalizePhone(call.srcNum) || normalizePhone(call.dstNum);
}

export function normalizePhone(value: string): string {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `7${digits.slice(1)}`;
  }
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

export function maskPhone(phone: string): string {
  const digits = normalizePhone(phone);
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-4)}`;
}

export function toNormalizedCall(call: SipuniCallRecord, timeZone = DEFAULT_TZ): NormalizedCall {
  const phone = clientPhone(call);
  const startedAt = new Date(call.timestamp * 1000);
  const parts = dateParts(timeZone, startedAt);
  const day = isoDay(dateFromParts(parts));
  const extension = call.shortSrcNum || call.shortDstNum || '';
  return {
    callId: call.callId || call.recordId,
    recordId: call.recordId,
    type: call.type,
    status: call.status,
    answered: call.status === 'ANSWER',
    startedAt: startedAt.toISOString(),
    date: day,
    phone,
    managerExtension: extension,
    managerName: call.managerName || 'Не определён',
    durationSeconds: call.duration,
    dialogDurationSeconds: call.dialogDuration,
  };
}

export function filterInternal(calls: SipuniCallRecord[], includeInternal = false): SipuniCallRecord[] {
  if (includeInternal) return calls;
  return calls.filter((call) => call.type !== 'internal');
}

export function filterByExtensions(calls: SipuniCallRecord[], extensions?: number[]): SipuniCallRecord[] {
  if (!extensions?.length) return calls;
  const set = new Set(extensions);
  return calls.filter((call) => {
    const src = Number.parseInt(call.shortSrcNum, 10);
    const dst = Number.parseInt(call.shortDstNum, 10);
    return set.has(src) || set.has(dst);
  });
}

export type CallCache = Map<string, { expiresAt: number; value: Promise<SipuniCallRecord[]> }>;

export function createCallCache(): CallCache {
  return new Map();
}

export async function loadCallsCached(
  client: SipuniClient,
  cache: CallCache,
  from: Date,
  to: Date,
  ttlMs = 60_000
): Promise<SipuniCallRecord[]> {
  const key = `${sipuniDate(from)}:${sipuniDate(to)}`;
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;

  const value = client.exportStatistics(sipuniDate(from), sipuniDate(to)).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

export async function makeTextReport(
  client: SipuniClient,
  cache: CallCache,
  kind: PeriodKind,
  timeZone = DEFAULT_TZ
): Promise<string> {
  if (kind === 'compare_weeks') {
    const currentStart = monday(today(timeZone));
    const previousStart = shiftDays(currentStart, -7);
    const previousEnd = shiftDays(currentStart, -1);
    const [currentCalls, previousCalls] = await Promise.all([
      loadCallsCached(client, cache, currentStart, today(timeZone)),
      loadCallsCached(client, cache, previousStart, previousEnd),
    ]);
    const current = filterInternal(currentCalls);
    const previous = filterInternal(previousCalls);
    return [
      'Сравнение недель',
      '',
      `Текущая: ${sipuniDate(currentStart)}–${sipuniDate(today(timeZone))}`,
      metricsText(metrics(current)),
      '',
      `Прошлая: ${sipuniDate(previousStart)}–${sipuniDate(previousEnd)}`,
      metricsText(metrics(previous)),
    ].join('\n');
  }

  if (kind === 'compare_months') {
    const now = today(timeZone);
    const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const previousEnd = shiftDays(currentStart, -1);
    const [currentCalls, previousCalls] = await Promise.all([
      loadCallsCached(client, cache, currentStart, now),
      loadCallsCached(client, cache, previousStart, previousEnd),
    ]);
    const current = filterInternal(currentCalls);
    const previous = filterInternal(previousCalls);
    return [
      'Сравнение месяцев',
      '',
      `Текущий: ${sipuniDate(currentStart)}–${sipuniDate(now)}`,
      metricsText(metrics(current)),
      '',
      `Прошлый: ${sipuniDate(previousStart)}–${sipuniDate(previousEnd)}`,
      metricsText(metrics(previous)),
    ].join('\n');
  }

  const period = periodFor(kind, timeZone);
  const calls = filterInternal(await loadCallsCached(client, cache, period.from, period.to));
  const header = `${period.title}\n${sipuniDate(period.from)}–${sipuniDate(period.to)}`;
  if (kind === 'managers_week' || kind === 'managers_month') {
    return `${header}\n\nВсего по всем менеджерам\n${metricsText(metrics(calls))}\n\nМенеджеры (всего / отвеченные / недозвон / проговорено)\n${managerReport(calls)}`;
  }
  return `${header}\n\n${metricsText(metrics(calls))}`;
}

export async function listCallsForGateway(
  client: SipuniClient,
  cache: CallCache,
  query: AnalyticsQuery
): Promise<{
  requestEcho: AnalyticsQuery;
  summary: Metrics & { uniquePhones: number; byManager: ReturnType<typeof managerStats> };
  period: { from: string; to: string; timezone: string };
  calls: NormalizedCall[];
  phones: string[];
}> {
  const timeZone = query.timezone || DEFAULT_TZ;
  const from = parseIsoDay(query.dateFrom);
  const to = parseIsoDay(query.dateTo);
  if (query.dateFrom > query.dateTo) throw new Error('dateFrom must not be after dateTo');

  let calls = filterInternal(await loadCallsCached(client, cache, from, to));
  calls = filterByExtensions(calls, query.managerExtensions);

  const normalized = calls.map((call) => toNormalizedCall(call, timeZone));
  const phones = [...new Set(normalized.map((call) => call.phone).filter(Boolean))];
  const includeDetails = query.includeDetails === true;
  const limit = Math.min(Math.max(Number(query.detailsLimit ?? 200), 1), 2000);

  return {
    requestEcho: query,
    summary: {
      ...metrics(calls),
      uniquePhones: phones.length,
      byManager: managerStats(calls),
    },
    period: { from: query.dateFrom, to: query.dateTo, timezone: timeZone },
    calls: includeDetails ? normalized.slice(0, limit) : [],
    phones,
  };
}

export function parseAnalyticsIntent(text: string): {
  kind?: PeriodKind;
  help?: string;
  dateFrom?: string;
  dateTo?: string;
  managerExtension?: number;
} {
  const raw = text.trim().toLowerCase();
  if (!raw) {
    return {
      help:
        'Примеры:\n/analytics неделя\n/analytics месяц\n/analytics сравни недели\n/analytics сравни месяцы\n/analytics менеджеры неделя\n/analytics менеджеры месяц\n/analytics сегодня',
    };
  }
  if (/сравн.*месяц/.test(raw)) return { kind: 'compare_months' };
  if (/сравн.*недел/.test(raw)) return { kind: 'compare_weeks' };
  if (/менеджер.*месяц|месяц.*менеджер/.test(raw)) return { kind: 'managers_month' };
  if (/менеджер.*недел|недел.*менеджер/.test(raw)) return { kind: 'managers_week' };
  if (/вчера/.test(raw)) return { kind: 'yesterday' };
  if (/сегодня/.test(raw)) return { kind: 'today' };
  if (/месяц/.test(raw)) return { kind: 'month' };
  if (/недел/.test(raw)) return { kind: 'week' };
  return {
    help:
      'Не распознал запрос. Примеры:\n/analytics неделя\n/analytics месяц\n/analytics сравни недели\n/analytics менеджеры месяц',
  };
}
