# ТЗ: Sales analytics (Pachca → Sipuni → EdProBiz)

Дата разбора: 2026-07-24  
Workflows:

| ID | Имя | Роль |
|----|-----|------|
| `hLoWzVNPpQhNBIpb` | Pachca \| Sales analytics chat gateway | Вход из Пачки (`/analytics`), чат `41651256` |
| `7nyuQ3obGyyw6kcZ` | DRAFT \| Manager sales analytics (batch) | Движок: batch Sipuni → CRM batches → join |

## Вердикт

1. **Существующие воркфлоу не ломает.** Gateway слушает отдельный credential `Pachca — Sales analytics bot` и фильтрует только чат `41651256` + команду `/analytics`. MLM-аналитика КЦ (`6wkfOPTBQv8Zgx5F`, чат `41071479`), анализ звонков Дарьи/Gemini и прочие Pachca-боты — другие токены/чаты.
2. **Денег на LLM не жрёт.** В gateway и draft **нет** OpenAI/Vertex/Agent-нод. Стоимость = Sipuni export + edprobiz batch + трафик n8n. Риск раздуть бюджет — если позже воткнуть AI-агента поверх сырых звонков (как в `[on] Общий анализ звонков…`).
3. **Сейчас gateway — заглушка:** принимает `/analytics` и отвечает «подключаю данные…». Реальных MCP-вызовов нет.
4. **Draft архитектурно верный** (батчи, каналы `calls|messengers`, attribution window), но **не рабочий в проде:**
   - нет `SIPUNI_MCP_GATEWAY_URL` / `EDPROBIZ_MCP_GATEWAY_URL` / `MESSENGER_*` в env n8n;
   - ветка Messenger не смержена в Join;
   - статусы Sipuni (`ANSWER`) ≠ ожидания Join (`answered`);
   - edprobiz MCP умеет phone lookup только **по одному** (`mcp_user_find`), batch — по email/user_ids. Для склейки «звонок→оплата» нужен phone-batch или CRM id из Sipuni (`crmLinks`).

## Целевая схема (масштабируемая)

```
Pachca /analytics
    → n8n gateway (parse intent, без LLM)
        → engine webhook (draft)
            → Sipuni HTTP gateway  (этот репо)  [calls batch]
            → Messenger gateway    (позже, optional)
            → EdProBiz gateway     (батч user/orders/payments)
        → join + attribution timeline
    → ответ в Пачку (summary-first)
```

Принципы стоимости/скорости:

- один Sipuni export на период, агрегаты в памяти;
- CRM/оплаты только батчами (≤100–300 id);
- в Пачку и LLM — только summary + короткий timeline, не весь CSV;
- мессенджеры подключаются тем же `channels[]`, без переписывания join.

## Статус реализации

- [x] Общий модуль агрегатов `src/analytics.ts`
- [x] HTTP gateway `POST /v1/gateway` (операции `sipuni.stats.report`, `sipuni.calls.list`, `sipuni.intent.parse`)
- [x] n8n `hLoWzVNPpQhNBIpb`: `/analytics …` → Sipuni gateway → ответ в Пачку (без LLM)
- [x] n8n draft `7nyuQ3obGyyw6kcZ`: URL Sipuni на `pachca-sipuni-bot`, join чинит статусы ANSWER, messenger отключён от fan-out
- [ ] EdProBiz HTTP gateway (вне этого репо) + phone batch / crmLinks
- [ ] Полный join оплат после звонков end-to-end
- [ ] Messenger MCP bridge
