import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SipuniClient } from './sipuni.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// .env рядом с проектом (не зависит от cwd Cursor)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SIPUNI_USER = process.env.SIPUNI_USER || '';
const SIPUNI_SECRET = process.env.SIPUNI_SECRET || '';

if (!SIPUNI_USER || !SIPUNI_SECRET) {
  console.error('CRITICAL WARNING: SIPUNI_USER or SIPUNI_SECRET environment variables are missing!');
}

const sipuniClient = new SipuniClient(SIPUNI_USER, SIPUNI_SECRET);

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
        description: 'Выгрузить звонки менеджера по добавочному номеру Sipuni и рассчитать KPI.',
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
          },
          required: ['from', 'to', 'manager_extension'],
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
      const { from, to, manager_extension } = args as {
        from: string;
        to: string;
        manager_extension: number;
      };

      const allCalls = await sipuniClient.exportStatistics(from, to);

      // Фильтруем звонки по добавочному номеру менеджера
      const managerCalls = allCalls.filter((c) => {
        const shortSrc = parseInt(c.shortSrcNum, 10);
        const shortDst = parseInt(c.shortDstNum, 10);
        return shortSrc === manager_extension || shortDst === manager_extension;
      });

      const nameFromSipuni = managerCalls.find((c) => c.managerName)?.managerName;

      // Рассчитываем аналитику
      const inbound = managerCalls.filter((c) => c.type === 'inbound');
      const outbound = managerCalls.filter((c) => c.type === 'outbound');
      const answered = managerCalls.filter((c) => c.status === 'ANSWER');
      const missed = managerCalls.filter((c) => c.status === 'NOANSWER' || c.status === 'CANCEL');

      const totalTalkTime = answered.reduce((acc, c) => acc + c.dialogDuration, 0);
      const avgTalkTime = answered.length > 0 ? Math.round(totalTalkTime / answered.length) : 0;

      const statistics = {
        manager: {
          extension: manager_extension,
          name: nameFromSipuni || 'Не указано в выгрузке Sipuni',
        },
        period: { from, to },
        summary: {
          totalCalls: managerCalls.length,
          inboundCount: inbound.length,
          outboundCount: outbound.length,
          answeredCount: answered.length,
          missedCount: missed.length,
          answerRate:
            managerCalls.length > 0
              ? `${Math.round((answered.length / managerCalls.length) * 100)}%`
              : '0%',
          totalTalkTimeSeconds: totalTalkTime,
          totalTalkTimeFormatted: `${Math.floor(totalTalkTime / 60)}м ${totalTalkTime % 60}с`,
          averageTalkTimeSeconds: avgTalkTime,
          averageTalkTimeFormatted: `${Math.floor(avgTalkTime / 60)}м ${avgTalkTime % 60}с`,
        },
        calls: managerCalls,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(statistics, null, 2),
          },
        ],
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
