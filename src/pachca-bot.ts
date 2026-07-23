import crypto from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { SipuniCallRecord, SipuniClient } from './sipuni.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PACHCA_TOKEN = requiredEnv('PACHCA_TOKEN');
const PACHCA_WEBHOOK_SECRET = requiredEnv('PACHCA_WEBHOOK_SECRET');
const PACHCA_CHAT_ID = Number.parseInt(requiredEnv('PACHCA_CHAT_ID'), 10);
const PACHCA_BOT_USER_ID = Number.parseInt(requiredEnv('PACHCA_BOT_USER_ID'), 10);
const SIPUNI_USER = requiredEnv('SIPUNI_USER');
const SIPUNI_SECRET = requiredEnv('SIPUNI_SECRET');
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Moscow';
const PACHCA_API = 'https://api.pachca.com/api/shared/v1';

type PeriodKind = 'today' | 'yesterday' | 'week' | 'compare_weeks' | 'managers_week' | 'managers_month';
type Metrics = { total: number; answered: number; missed: number; talkSeconds: number };
type PachcaEvent = {
  type?: string;
  event?: string;
  id?: number;
  message_id?: number;
  chat_id?: number;
  user_id?: number;
  content?: string;
  data?: string;
  webhook_timestamp?: number;
};

const sipuni = new SipuniClient(SIPUNI_USER, SIPUNI_SECRET);
const reportCache = new Map<string, { expiresAt: number; value: Promise<string> }>();
const processedEvents = new Map<string, number>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function dateParts(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const read = (type: string) => Number(values.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function dateFromParts({ year, month, day }: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function sipuniDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function today(): Date { return dateFromParts(dateParts()); }

function monday(date: Date): Date {
  const day = date.getUTCDay() || 7;
  return shiftDays(date, 1 - day);
}

function periodFor(kind: Exclude<PeriodKind, 'compare_weeks'>) {
  const now = today();
  if (kind === 'today') return { from: now, to: now, title: 'Статистика за сегодня' };
  if (kind === 'yesterday') {
    const day = shiftDays(now, -1);
    return { from: day, to: day, title: 'Статистика за вчера' };
  }
  if (kind === 'week' || kind === 'managers_week') {
    return { from: monday(now), to: now, title: kind === 'week' ? 'Статистика за текущую неделю' : 'Менеджеры: текущая неделя' };
  }
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now, title: 'Менеджеры: текущий месяц' };
}

function metrics(calls: SipuniCallRecord[]): Metrics {
  const answered = calls.filter((call) => call.status === 'ANSWER');
  return {
    total: calls.length,
    answered: answered.length,
    missed: calls.filter((call) => call.status === 'NOANSWER' || call.status === 'CANCEL').length,
    talkSeconds: answered.reduce((total, call) => total + call.dialogDuration, 0),
  };
}

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function metricsText(value: Metrics): string {
  return `Всего звонков: ${value.total}\nОтвеченные: ${value.answered}\nНедозвон: ${value.missed}\nПроговорено: ${duration(value.talkSeconds)}`;
}

function managerKey(call: SipuniCallRecord): string {
  const extension = call.shortSrcNum || call.shortDstNum || 'unknown';
  return `${call.managerName || 'Не определён'}|${extension}`;
}

function managerReport(calls: SipuniCallRecord[]): string {
  const groups = new Map<string, SipuniCallRecord[]>();
  for (const call of calls) {
    const key = managerKey(call);
    groups.set(key, [...(groups.get(key) || []), call]);
  }
  const rows = [...groups.entries()]
    .map(([key, managerCalls]) => ({ key, value: metrics(managerCalls) }))
    .sort((left, right) => right.value.total - left.value.total || left.key.localeCompare(right.key, 'ru'));

  if (!rows.length) return 'Звонков за период нет.';
  return rows.map(({ key, value }) => {
    const [name, extension] = key.split('|');
    return `* ${name}${extension === 'unknown' ? '' : ` (${extension})`} — ${value.total} / ${value.answered} / ${value.missed} / ${duration(value.talkSeconds)}`;
  }).join('\n');
}

async function loadCalls(from: Date, to: Date): Promise<SipuniCallRecord[]> {
  return sipuni.exportStatistics(sipuniDate(from), sipuniDate(to));
}

function cached(key: string, calculate: () => Promise<string>): Promise<string> {
  const current = reportCache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = calculate().catch((error) => {
    reportCache.delete(key);
    throw error;
  });
  reportCache.set(key, { expiresAt: Date.now() + 60_000, value });
  return value;
}

async function makeReport(kind: PeriodKind): Promise<string> {
  return cached(kind, async () => {
    if (kind === 'compare_weeks') {
      const currentStart = monday(today());
      const previousStart = shiftDays(currentStart, -7);
      const previousEnd = shiftDays(currentStart, -1);
      const [currentCalls, previousCalls] = await Promise.all([
        loadCalls(currentStart, today()),
        loadCalls(previousStart, previousEnd),
      ]);
      return `Сравнение недель\n\nТекущая: ${sipuniDate(currentStart)}–${sipuniDate(today())}\n${metricsText(metrics(currentCalls))}\n\nПрошлая: ${sipuniDate(previousStart)}–${sipuniDate(previousEnd)}\n${metricsText(metrics(previousCalls))}`;
    }

    const period = periodFor(kind);
    const calls = await loadCalls(period.from, period.to);
    const header = `${period.title}\n${sipuniDate(period.from)}–${sipuniDate(period.to)}`;
    if (kind === 'managers_week' || kind === 'managers_month') {
      return `${header}\n\nВсего по всем менеджерам\n${metricsText(metrics(calls))}\n\nМенеджеры (всего / отвеченные / недозвон / проговорено)\n${managerReport(calls)}`;
    }
    return `${header}\n\n${metricsText(metrics(calls))}`;
  });
}

const buttons = [
  [{ text: 'Статистика за сегодня', data: 'sipuni:today' }, { text: 'Статистика за вчера', data: 'sipuni:yesterday' }],
  [{ text: 'Статистика за неделю', data: 'sipuni:week' }, { text: 'Сравнение недель', data: 'sipuni:compare_weeks' }],
  [{ text: 'Менеджеры: неделя', data: 'sipuni:managers_week' }, { text: 'Менеджеры: месяц', data: 'sipuni:managers_month' }],
];

async function sendMessage(content: string, parentMessageId?: number, withButtons = false): Promise<void> {
  const response = await fetch(`${PACHCA_API}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PACHCA_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message: {
      entity_type: 'discussion', entity_id: PACHCA_CHAT_ID, content, parent_message_id: parentMessageId,
      ...(withButtons ? { buttons } : {}),
    } }),
  });
  if (!response.ok) throw new Error(`Pachca API returned ${response.status}`);
}

function validSignature(rawBody: Buffer, signature?: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', PACHCA_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function eventSeen(event: PachcaEvent): boolean {
  // Button events refer to the same source message on every click. Include the
  // webhook timestamp and payload so retries are deduplicated but later clicks
  // on the same button remain valid requests.
  const key = [
    event.type,
    event.event,
    event.id || event.message_id || '',
    event.user_id || '',
    event.data || '',
    event.webhook_timestamp || '',
  ].join(':');
  const now = Date.now();
  for (const [item, expiresAt] of processedEvents) if (expiresAt <= now) processedEvents.delete(item);
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, now + 5 * 60_000);
  return false;
}

function recognizedCommand(content?: string): boolean {
  return /^(\/start|\/sipuni|статистика|звонки)$/i.test((content || '').trim());
}

async function processEvent(event: PachcaEvent): Promise<void> {
  if (event.chat_id !== PACHCA_CHAT_ID || event.user_id === PACHCA_BOT_USER_ID || eventSeen(event)) return;
  const parentMessageId = event.message_id || event.id;
  if (event.type === 'message' && event.event === 'new' && recognizedCommand(event.content)) {
    await sendMessage('Выберите отчёт:', parentMessageId, true);
    return;
  }
  const kind = event.data?.startsWith('sipuni:') ? event.data.slice('sipuni:'.length) as PeriodKind : undefined;
  if (event.type === 'button' && kind && ['today', 'yesterday', 'week', 'compare_weeks', 'managers_week', 'managers_month'].includes(kind)) {
    await sendMessage(await makeReport(kind), parentMessageId);
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, status: number, body = ''): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return reply(response, 200, 'ok');
  if (request.method !== 'POST' || request.url !== '/webhook') return reply(response, 404, 'Not found');
  try {
    const rawBody = await readBody(request);
    if (!validSignature(rawBody, request.headers['pachca-signature'] as string | undefined)) return reply(response, 401, 'Invalid signature');
    const event = JSON.parse(rawBody.toString('utf8')) as PachcaEvent;
    if (!event.webhook_timestamp || Math.abs(Date.now() / 1000 - event.webhook_timestamp) > 60) return reply(response, 401, 'Expired event');
    reply(response, 200, 'OK');
    void processEvent(event).catch((error) => console.error('Pachca event processing failed:', error.message));
  } catch (error: any) {
    console.error('Pachca webhook failed:', error.message);
    reply(response, 400, 'Bad request');
  }
}).listen(PORT, '0.0.0.0', () => console.error(`Pachca Sipuni bot listening on ${PORT}`));
