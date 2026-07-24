import crypto from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  CallCache,
  createCallCache,
  listCallsForGateway,
  makeTextReport,
  parseAnalyticsIntent,
  PeriodKind,
} from './analytics.js';
import { SipuniClient } from './sipuni.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PACHCA_TOKEN = requiredEnv('PACHCA_TOKEN');
const PACHCA_WEBHOOK_SECRET = requiredEnv('PACHCA_WEBHOOK_SECRET');
const PACHCA_CHAT_ID = Number.parseInt(requiredEnv('PACHCA_CHAT_ID'), 10);
const PACHCA_BOT_USER_ID = Number.parseInt(requiredEnv('PACHCA_BOT_USER_ID'), 10);
const SIPUNI_USER = requiredEnv('SIPUNI_USER');
const SIPUNI_SECRET = requiredEnv('SIPUNI_SECRET');
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Moscow';
const MCP_GATEWAY_TOKEN = process.env.MCP_GATEWAY_TOKEN || '';
const PACHCA_API = 'https://api.pachca.com/api/shared/v1';

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
const callCache: CallCache = createCallCache();
const reportCache = new Map<string, { expiresAt: number; value: Promise<string> }>();
const processedEvents = new Map<string, number>();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cachedText(key: string, calculate: () => Promise<string>): Promise<string> {
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
  return cachedText(kind, () => makeTextReport(sipuni, callCache, kind, TIME_ZONE));
}

const buttons = [
  [
    { text: 'Статистика за сегодня', data: 'sipuni:today' },
    { text: 'Статистика за вчера', data: 'sipuni:yesterday' },
  ],
  [
    { text: 'Статистика за неделю', data: 'sipuni:week' },
    { text: 'Сравнение недель', data: 'sipuni:compare_weeks' },
  ],
  [
    { text: 'Менеджеры: неделя', data: 'sipuni:managers_week' },
    { text: 'Менеджеры: месяц', data: 'sipuni:managers_month' },
  ],
  [
    { text: 'Статистика за месяц', data: 'sipuni:month' },
    { text: 'Сравнение месяцев', data: 'sipuni:compare_months' },
  ],
];

async function sendMessage(content: string, parentMessageId?: number, withButtons = false): Promise<void> {
  const response = await fetch(`${PACHCA_API}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PACHCA_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      message: {
        entity_type: 'discussion',
        entity_id: PACHCA_CHAT_ID,
        content,
        parent_message_id: parentMessageId,
        ...(withButtons ? { buttons } : {}),
      },
    }),
  });
  if (!response.ok) throw new Error(`Pachca API returned ${response.status}`);
}

function validSignature(rawBody: Buffer, signature?: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', PACHCA_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function eventSeen(event: PachcaEvent): boolean {
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

const PERIOD_KINDS: PeriodKind[] = [
  'today',
  'yesterday',
  'week',
  'month',
  'compare_weeks',
  'compare_months',
  'managers_week',
  'managers_month',
];

async function processEvent(event: PachcaEvent): Promise<void> {
  if (event.chat_id !== PACHCA_CHAT_ID || event.user_id === PACHCA_BOT_USER_ID || eventSeen(event)) return;
  const parentMessageId = event.message_id || event.id;
  if (event.type === 'message' && event.event === 'new' && recognizedCommand(event.content)) {
    await sendMessage('Выберите отчёт:', parentMessageId, true);
    return;
  }
  const kind = event.data?.startsWith('sipuni:') ? (event.data.slice('sipuni:'.length) as PeriodKind) : undefined;
  if (event.type === 'button' && kind && PERIOD_KINDS.includes(kind)) {
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

function replyText(response: ServerResponse, status: number, body = ''): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function authorizeGateway(request: IncomingMessage): boolean {
  if (!MCP_GATEWAY_TOKEN) return true;
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && match[1] === MCP_GATEWAY_TOKEN);
}

async function handleGateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorizeGateway(request)) {
    replyJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const rawBody = await readBody(request);
  const payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  const operation = String(payload.operation || '');
  const requestId = payload.requestId || null;

  if (operation === 'sipuni.stats.report') {
    const kind = String(payload.kind || payload.query?.kind || '') as PeriodKind;
    if (!PERIOD_KINDS.includes(kind)) {
      replyJson(response, 400, { error: 'kind must be a supported PeriodKind', requestId });
      return;
    }
    const text = await makeReport(kind);
    replyJson(response, 200, {
      requestId,
      operation,
      kind,
      text,
      source: 'sipuni',
      timezone: TIME_ZONE,
    });
    return;
  }

  if (operation === 'sipuni.calls.list') {
    const query = payload.query || {};
    const dateFrom = String(query.dateFrom || '');
    const dateTo = String(query.dateTo || '');
    const result = await listCallsForGateway(sipuni, callCache, {
      dateFrom,
      dateTo,
      managerExtensions: Array.isArray(query.managerIds)
        ? query.managerIds.map(Number).filter((n: number) => Number.isFinite(n))
        : Array.isArray(query.managerExtensions)
          ? query.managerExtensions.map(Number).filter((n: number) => Number.isFinite(n))
          : [],
      includeDetails: query.includeDetails === true || query.includeDetails === undefined,
      detailsLimit: Number(query.detailsLimit ?? query.crmBatchSize ?? 500),
      timezone: query.timezone || TIME_ZONE,
    });

    // Contract expected by n8n draft: echo requestId/query + calls[]
    replyJson(response, 200, {
      requestId,
      operation,
      query: {
        ...query,
        dateFrom: result.period.from,
        dateTo: result.period.to,
      },
      summary: result.summary,
      period: result.period,
      phones: result.phones,
      calls: result.calls,
      context: {
        requestId,
        query: {
          ...query,
          dateFrom: result.period.from,
          dateTo: result.period.to,
        },
        calls: result.calls,
      },
    });
    return;
  }

  if (operation === 'sipuni.intent.parse') {
    const intent = parseAnalyticsIntent(String(payload.text || ''));
    replyJson(response, 200, { requestId, operation, intent });
    return;
  }

  replyJson(response, 400, {
    error: 'Unknown operation',
    supported: ['sipuni.calls.list', 'sipuni.stats.report', 'sipuni.intent.parse'],
    requestId,
  });
}

createServer(async (request, response) => {
  const url = request.url?.split('?')[0] || '';

  if (request.method === 'GET' && url === '/health') {
    replyText(response, 200, 'ok');
    return;
  }

  if (request.method === 'POST' && url === '/v1/gateway') {
    try {
      await handleGateway(request, response);
    } catch (error: any) {
      console.error('Gateway failed:', error.message);
      replyJson(response, 500, { error: error.message || 'Gateway error' });
    }
    return;
  }

  if (request.method !== 'POST' || url !== '/webhook') {
    replyText(response, 404, 'Not found');
    return;
  }

  try {
    const rawBody = await readBody(request);
    if (!validSignature(rawBody, request.headers['pachca-signature'] as string | undefined)) {
      replyText(response, 401, 'Invalid signature');
      return;
    }
    const event = JSON.parse(rawBody.toString('utf8')) as PachcaEvent;
    if (!event.webhook_timestamp || Math.abs(Date.now() / 1000 - event.webhook_timestamp) > 60) {
      replyText(response, 401, 'Expired event');
      return;
    }
    replyText(response, 200, 'OK');
    void processEvent(event).catch((error) => console.error('Pachca event processing failed:', error.message));
  } catch (error: any) {
    console.error('Pachca webhook failed:', error.message);
    replyText(response, 400, 'Bad request');
  }
}).listen(PORT, '0.0.0.0', () => console.error(`Pachca Sipuni bot + gateway listening on ${PORT}`));
