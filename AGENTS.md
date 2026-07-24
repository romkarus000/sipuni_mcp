# Sipuni MCP — рабочие правила агента

## Назначение

Репозиторий `sipuni_mcp` — TypeScript MCP-сервер телефонии Sipuni + HTTP-бот Пачки для быстрых отчётов по звонкам.

**Цели продукта**

1. Сделать MCP доступным пользователям (Cursor / n8n / агенты) с понятными контрактами инструментов.
2. Отдавать **компактную проверяемую статистику** по запросу, а не сырые дампы по умолчанию.
3. Писать **оптимизированный код**: один fetch Sipuni на период, батчи, кэш, без N+1.
4. Конечный сценарий аналитики продаж:
   - моментальная статистика звонков (общая / по менеджерам / периоды / сравнения);
   - статистика **оплат после звонков** и **статусов клиентов в CRM** — через связку с **edprobiz-mcp** (не через прямой доступ к БД LK в этом репо).

Связанный orchestration: n8n `https://flow.ai.edpro.io/` (в т.ч. gateway `Pachca | Sales analytics chat gateway`, id `hLoWzVNPpQhNBIpb`). Масштабирование: позже тот же контракт отчётов + MCP мессенджеров.

## Архитектура

| Компонент | Файл | Роль |
|-----------|------|------|
| MCP stdio | `src/index.ts` | Инструменты для AI/n8n |
| Sipuni API | `src/sipuni.ts` | Подпись, `/api/statistic/export`, CSV → `SipuniCallRecord[]` |
| Pachca bot | `src/pachca-bot.ts` | Webhook + кнопки отчётов + `POST /v1/gateway` |
| Aggregates | `src/analytics.ts` | Общие метрики/периоды/нормализация звонков |

Транспорт MCP — **stdio**. HTTP: Pachca webhook + внутренний gateway для n8n (`http://pachca-sipuni-bot:3000/v1/gateway` в сети `n8n_default`).

Разбор ТЗ n8n: `docs/N8N_SALES_ANALYTICS_TZ.md`.

### Инфраструктура (prod)

- Сервер: `root@46.149.70.15`
- Код: `/opt/sipuni-mcp` (git detach на `origin/main`)
- Compose: `pachca-sipuni-bot` → `127.0.0.1:3001:3000`, health `/health`
- Nginx: `qa.piemnaya.ru` → `/sipuni-pachca/webhook` (allowlist IP в snippet)
- Сервис `sipuni-mcp` в compose **намеренно не поднимается** как long-running HTTP: stdio нужен attached client
- Host Node на сервере — `v12` (не использовать для запуска); в Docker — Node 20+
- Не трогать без согласования: n8n (`/opt/n8n`), Metabase, прочие nginx/location

Деплой: `deploy/deploy.sh` (lockfile, `git fetch`, build образа один раз, up бота если задан `PACHCA_WEBHOOK_SECRET`).

Локальный клон для агента: `/Users/rodionakovlev/sipuni_mcp`  
(старый путь из README `total-lk-yii/sipuni-mcp` — legacy, не канон).

## Текущие MCP-инструменты

- `get_sipuni_calls_raw` — сырая выгрузка за период (`from`/`to` = `дд.мм.гггг`).
- `get_manager_call_statistics` — KPI по `manager_extension`.

**Не возвращать в проде:** прямой MySQL EdPro (удалён в `agent/remove-edpro-db`).  
Инструмент `get_unlinked_calls` / CRM-сверки — только через edprobiz-mcp или явный новый дизайн без секретов БД в этом сервисе. Если Cursor показывает `get_unlinked_calls`, это рассинхрон со старым билдом — ориентироваться на `src/index.ts`.

Pachca-бот уже отдаёт: сегодня / вчера / неделя / сравнение недель / менеджеры (неделя, месяц).

## Правила разработки

### Контракты ответов MCP

- Не ломать имена/поля/смысл инструментов без версионирования / deprecation.
- Валидировать даты, границы периода, TZ (`Europe/Moscow`), лимиты **до** вызова Sipuni.
- Ответ по умолчанию: компактный `summary` → период/TZ/фильтры → агрегаты. Сырые звонки — только `include_details` + `limit`/`offset` + стабильная сортировка.
- Числа — числа; длительности — секунды + human; проценты — с явным знаменателем.
- Пустой период → валидный нулевой отчёт. Ошибки API — без секретов и PII.

### Производительность (батчи / кэш)

- **Один** `exportStatistics` на период; все срезы (total / managers / compare) — из одного массива в памяти.
- Не грузить Sipuni повторно в рамках одного user-request / tool-call chain.
- TTL-кэш: ключ = `account + from + to + tz + filters`. Для закрытых дней — длиннее TTL; для «сегодня» — короткий / инкрементальный.
- Сравнение периодов — `Promise.all` параллельных загрузок (как в `pachca-bot`), не последовательно.
- Запрещён анти-паттерн: цикл «по каждому менеджеру / дню — отдельный export».
- Не отдавать весь JSON звонков в LLM/n8n по умолчанию — это жрёт токены и деньги.

### Корректность аналитики

- TZ явный (`TIME_ZONE=Europe/Moscow`); тесты границ суток и месяцев.
- Разделять: попытки / отвеченные / недозвон / `duration` vs `dialogDuration`; internal — не в клиентские KPI без флага.
- Неизвестные статусы Sipuni → `unknown` + count в отчёте.
- Дедуп по стабильному id (`callId` / `recordId`).

### Оплаты после звонков и CRM (целевой контур)

В этом репо — только телефония и нормализованные звонки (телефоны → внешние id по батчу).

Склейка:

1. Sipuni MCP → звонки / KPI / список внешних номеров (батч).
2. edprobiz-mcp → пользователи / заказы / оплаты / статусы воронки по батчу id.
3. Aggregation layer (n8n Code / общий модуль) → timeline «звонок → … → оплата».

Не тащить CRM SQL обратно в `sipuni_mcp` без отдельного ADR.

### Безопасность

- Не коммитить `.env`, ключи Sipuni/Pachca, дампы, полные номера.
- Маскировать телефоны по умолчанию.
- Webhook: HMAC `PACHCA_WEBHOOK_SECRET`, проверка timestamp, allowlist IP в nginx.
- Stdio MCP ≠ публичный API. Внешний доступ — только auth gateway / controlled client (Cursor, n8n MCP).

### Операционка

- Перед merge: `npm ci && npm run build`.
- Не плодить orphan `docker run` поверх compose; держать один healthy `pachca-sipuni-bot`.
- Логи без PII; healthcheck обязателен для HTTP-сервисов.

## Команды

```bash
npm ci
npm run build
npm start                 # MCP stdio
npm run start:pachca-bot  # HTTP бот
```

Минимальная проверка перед сдачей работы: `npm run build`.  
До изменений, затрагивающих расчёты, добавляйте или обновляйте тесты.

## Переменные окружения

См. `.env.example`: `SIPUNI_USER`, `SIPUNI_SECRET`, `PACHCA_*`, `TIME_ZONE`.  
Закомментированный CRM DB block — legacy; не включать без решения вернуть DB.

## Definition of Done (ближайшие итерации)

- [ ] MCP-ответы со `summary`-first и лимитом деталей (не весь массив `calls`).
- [ ] Общий модуль агрегатов для MCP и Pachca-бота (сейчас логика дублируется).
- [ ] Кэш/батч на уровне `SipuniClient` / shared store.
- [ ] Контракт tool(s) для периода: overall / by_manager / week / month / compare.
- [ ] Документированный пайплайн join с edprobiz-mcp для «оплаты после звонков».
- [ ] Пользовательский доступ: Cursor MCP + n8n tool nodes без утечки секретов.
