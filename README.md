# Sipuni Telephony MCP Server

Model Context Protocol (MCP) сервер для интеграции с АТС Sipuni и получения аналитики/статистики по звонкам менеджеров из платформы EdPro Biz (Yii2 advanced).

Сервер позволяет AI-агентам напрямую взаимодействовать с АТС Sipuni, выгружать статистику звонков за любой период, рассчитывать KPI менеджеров по их добавочным номерам и сверять данные Sipuni с CRM Timeline базой данных (для поиска непривязанных или упущенных звонков).

## Особенности (Features)

*   **`get_sipuni_calls_raw`** — выгрузка сырого списка звонков из АТС Sipuni за выбранный период (JSON). **БД не нужна.**
*   **`get_manager_call_statistics`** — KPI по добавочному номеру менеджера. ФИО берётся из CSV Sipuni; из CRM — если настроена БД. **БД опциональна.**
*   **`get_unlinked_calls`** — сверка АТС с CRM Timeline. **Требует DB_*.**
*   БД CRM (`dbSlave`) подключается только при наличии `DB_HOST` / `DB_USER` / `DB_NAME`.

## Требования (Requirements)

*   NodeJS >= v18.0.0
*   Доступ к API Sipuni (ID аккаунта и секретный ключ)
*   Доступ к MySQL базе данных вашей CRM (рекомендуется `dbSlave`)

## Установка и сборка (Installation)

1.  Перейдите в папку сервера:
    ```bash
    cd sipuni-mcp
    ```
2.  Установите npm-зависимости:
    ```bash
    npm install
    ```
3.  Соберите TypeScript код:
    ```bash
    npm run build
    ```

## Настройка интеграции (Configuration)

Создайте файл `.env` в корне папки `sipuni-mcp` (для локальных тестов) или передайте переменные окружения напрямую вашему MCP-клиенту (Cursor / Claude Desktop):

```env
# Параметры Sipuni (берутся из Личного Кабинета Sipuni -> Настройки -> Интеграция по API)
SIPUNI_USER=012345
SIPUNI_SECRET=your_sipuni_api_key_secret

# Подключение к базе данных CRM EdPro (рекомендуется dbSlave)
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=lk
```

### Подключение к Cursor IDE

Добавьте следующую конфигурацию в настройки Cursor (`Settings` -> `Features` -> `MCP` -> `+ Add New MCP Server`):

*   **Name**: `sipuni-telephony`
*   **Type**: `command`
*   **Command**: `node /полный/путь/к/total-lk-yii/sipuni-mcp/dist/index.js`

Или укажите ее в глобальном файле настроек Cursor:

```json
"mcpServers": {
  "sipuni-telephony": {
    "command": "node",
    "args": ["/Users/rodionakovlev/total-lk-yii/sipuni-mcp/dist/index.js"],
    "env": {
      "SIPUNI_USER": "012345",
      "SIPUNI_SECRET": "your_api_key",
      "DB_HOST": "127.0.0.1",
      "DB_USER": "root",
      "DB_PASSWORD": "",
      "DB_NAME": "lk"
    }
  }
}
```

## Разработка (Development)

Для автоматической компиляции TypeScript изменений при разработке запустите:
```bash
npm run watch
```
