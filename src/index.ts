import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createCallCache,
  filterByExtensions,
  filterInternal,
  makeTextReport,
  metrics,
  PeriodKind,
} from './analytics.js';
import { SipuniClient } from './sipuni.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// .env рядом с проектом (не зависит от cwd Cursor)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SIPUNI_USER = process.env.SIPUNI_USER || '';
const SIPUNI_SECRET = process.env.SIPUNI_SECRET || '';
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Moscow';

if (!SIPUNI_USER || !SIPUNI_SECRET) {
  console.error('CRITICAL WARNING: SIPUNI_USER or SIPUNI_SECRET environment variables are missing!');
}

const sipuniClient = new SipuniClient(SIPUNI_USER, SIPUNI_SECRET);
const callCache = createCallCache();

const server = new Server(
  {
    name: 'sipuni-telephony',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Объявление доступных инструментов
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_sipuni_calls_raw',
        description: 'Получить сырую выгрузку звонков напрямую из АТС Sipuni за указанный период в формате JSON.',
        inputSchema: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'Начальная дата в формате дд.мм.гггг (например, 20.07.2026)',
            },
            to: {
              type: 'string',
              description: 'Конечная дата в формате дд.мм.гггг (например, 23.07.2026)',
            },
            type: {
              type: 'string',
              enum: ['0', '1', '2', '3'],
              description: 'Тип вызовов: "0" - все, "1" - входящие, "2" - исходящие, "3" - внутренние',
            },
            state: {
              type: 'string',
              enum: ['0', '1', '2'],
              description: 'Статус вызовов: "0" - все, "1" - пропущенные, "2" - принятые',
            },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'get_manager_call_statistics',
        description:
          'KPI менеджера по добавочному Sipuni. По умолчанию только summary (без массива calls). Для деталей: include_details=true + details_limit.',
        inputSchema: {
          type: 'object',
          properties: {
            from: {
              type: 'string',
              description: 'Начальная дата в формате дд.мм.гггг (например, 20.07.2026)',
            },
            to: {
              type: 'string',
              description: 'Конечная дата в формате дд.мм.гггг (например, 23.07.2026)',
            },
            manager_extension: {
              type: 'number',
              description: 'Добавочный номер менеджера (sipuni_extension) в АТС Sipuni (например, 201)',
            },
            include_details: {
              type: 'boolean',
              description: 'Если true — добавить массив calls (по умолчанию false, экономия токенов)',
            },
            details_limit: {
              type: 'number',
              description: 'Максимум звонков в details (1..500, по умолчанию 50)',
            },
          },
          required: ['from', 'to', 'manager_extension'],
        },
      },
      {
        name: 'get_call_stats_report',
        description:
          'Текстовая/JSON сводка звонков: today|yesterday|week|month|compare_weeks|compare_months|managers_week|managers_month. Один export Sipuni на период, без LLM.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'today',
                'yesterday',
                'week',
                'month',
                'compare_weeks',
                'compare_months',
                'managers_week',
                'managers_month',
              ],
            },
          },
          required: ['kind'],
        },
      },
    ],
  };
});

/**
 * Обработка вызовов инструментов
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'get_sipuni_calls_raw') {
      const { from, to, type, state } = args as {
        from: string;
        to: string;
        type?: '0' | '1' | '2' | '3';
        state?: '0' | '1' | '2';
      };

      const calls = await sipuniClient.exportStatistics(from, to, { type, state });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(calls, null, 2),
          },
        ],
      };
    }

    if (name === 'get_manager_call_statistics') {
      const { from, to, manager_extension, include_details, details_limit } = args as {
        from: string;
        to: string;
        manager_extension: number;
        include_details?: boolean;
        details_limit?: number;
      };

      const allCalls = filterInternal(await sipuniClient.exportStatistics(from, to));
      const managerCalls = filterByExtensions(allCalls, [manager_extension]);
      const nameFromSipuni = managerCalls.find((c) => c.managerName)?.managerName;
      const summaryMetrics = metrics(managerCalls);
      const inbound = managerCalls.filter((c) => c.type === 'inbound');
      const outbound = managerCalls.filter((c) => c.type === 'outbound');
      const avgTalkTime =
        summaryMetrics.answered > 0 ? Math.round(summaryMetrics.talkSeconds / summaryMetrics.answered) : 0;
      const limit = Math.min(Math.max(Number(details_limit ?? 50), 1), 500);

      const statistics: Record<string, unknown> = {
        manager: {
          extension: manager_extension,
          name: nameFromSipuni || 'Не указано в выгрузке Sipuni',
        },
        period: { from, to, timezone: TIME_ZONE },
        summary: {
          totalCalls: summaryMetrics.total,
          inboundCount: inbound.length,
          outboundCount: outbound.length,
          answeredCount: summaryMetrics.answered,
          missedCount: summaryMetrics.missed,
          answerRate:
            summaryMetrics.total > 0
              ? `${Math.round((summaryMetrics.answered / summaryMetrics.total) * 100)}%`
              : '0%',
          answerRateDenominator: summaryMetrics.total,
          totalTalkTimeSeconds: summaryMetrics.talkSeconds,
          totalTalkTimeFormatted: `${Math.floor(summaryMetrics.talkSeconds / 60)}м ${summaryMetrics.talkSeconds % 60}с`,
          averageTalkTimeSeconds: avgTalkTime,
          averageTalkTimeFormatted: `${Math.floor(avgTalkTime / 60)}м ${avgTalkTime % 60}с`,
        },
      };

      if (include_details) {
        statistics.calls = managerCalls.slice(0, limit);
        statistics.detailsTruncated = managerCalls.length > limit;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(statistics, null, 2),
          },
        ],
      };
    }

    if (name === 'get_call_stats_report') {
      const { kind } = args as { kind: PeriodKind };
      const text = await makeTextReport(sipuniClient, callCache, kind, TIME_ZONE);
      return {
        content: [{ type: 'text', text }],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error executing tool ${name}: ${error.message}`,
        },
      ],
    };
  }
});

/**
 * Запуск сервера
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sipuni Telephony MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
