import mysql, { RowDataPacket } from 'mysql2/promise';

export interface ManagerDbRecord {
  id: number;
  userId: number;
  sipuniExtension: number | null;
  name: string;
  isWorking: boolean;
  isFired: boolean;
}

export interface TimelineDbRecord {
  id: number;
  userId: number | null;
  entityId: number | null;
  entityType: number | null;
  title: string | null;
  description: string | null;
  itemId: number | null;
  itemType: number | null;
  itemData: string | null; // JSON-строка
  created: string;
  salesManagerId: number | null;
}

export class CrmDatabase {
  private pool: mysql.Pool | null = null;
  private config: mysql.PoolOptions;

  constructor(config: mysql.PoolOptions) {
    this.config = {
      ...config,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    };
  }

  /**
   * Инициализировать пул подключений
   */
  async connect(): Promise<void> {
    if (!this.pool) {
      this.pool = mysql.createPool(this.config);
    }
  }

  /**
   * Закрыть пул подключений
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private getPool(): mysql.Pool {
    if (!this.pool) {
      throw new Error('Database pool is not initialized. Call connect() first.');
    }
    return this.pool;
  }

  /**
   * Получить список всех менеджеров, сопоставленных с их данными пользователей
   */
  async getManagers(): Promise<ManagerDbRecord[]> {
    const pool = this.getPool();
    // Делаем LEFT JOIN с таблицей user_detail для получения читаемого ФИО менеджера
    const query = `
      SELECT 
        sm.id,
        sm.is_working as isWorking,
        sm.is_fired as isFired,
        sm.sipuni_extension as sipuniExtension,
        ud.user_id as userId,
        CONCAT_WS(' ', ud.surname, ud.first_name, ud.patronymic) as name
      FROM sales_manager sm
      LEFT JOIN user_detail ud ON ud.user_id = sm.id
      WHERE sm.deleted IS NULL
    `;

    const [rows] = await pool.execute<RowDataPacket[]>(query);
    
    return rows.map(r => ({
      id: Number(r.id),
      userId: Number(r.userId),
      sipuniExtension: r.sipuniExtension ? Number(r.sipuniExtension) : null,
      name: r.name || `Менеджер #${r.id}`,
      isWorking: Boolean(r.isWorking),
      isFired: Boolean(r.isFired),
    }));
  }

  /**
   * Найти менеджера по добавочному номеру Sipuni
   */
  async findManagerByExtension(extension: number): Promise<ManagerDbRecord | null> {
    const pool = this.getPool();
    const query = `
      SELECT 
        sm.id,
        sm.is_working as isWorking,
        sm.is_fired as isFired,
        sm.sipuni_extension as sipuniExtension,
        ud.user_id as userId,
        CONCAT_WS(' ', ud.surname, ud.first_name, ud.patronymic) as name
      FROM sales_manager sm
      LEFT JOIN user_detail ud ON ud.user_id = sm.id
      WHERE sm.sipuni_extension = ? AND sm.deleted IS NULL
      LIMIT 1
    `;

    const [rows] = await pool.execute<RowDataPacket[]>(query, [extension]);
    if (rows.length === 0) {
      return null;
    }

    const r = rows[0];
    return {
      id: Number(r.id),
      userId: Number(r.userId),
      sipuniExtension: r.sipuniExtension ? Number(r.sipuniExtension) : null,
      name: r.name || `Менеджер #${r.id}`,
      isWorking: Boolean(r.isWorking),
      isFired: Boolean(r.isFired),
    };
  }

  /**
   * Получить все записи звонков из CRM Timeline за указанный период
   */
  async getTimelineCalls(fromDate: string, toDate: string): Promise<TimelineDbRecord[]> {
    const pool = this.getPool();
    // item_type = 3 — PHONE_CALL согласно DictTimelineType
    const query = `
      SELECT 
        id,
        user_id as userId,
        entity_id as entityId,
        entity_type as entityType,
        title,
        description,
        item_id as itemId,
        item_type as itemType,
        item_data as itemData,
        created,
        sales_manager_id as salesManagerId
      FROM timeline
      WHERE item_type = 3 
        AND created >= ? 
        AND created <= ?
    `;

    const [rows] = await pool.execute<RowDataPacket[]>(query, [`${fromDate} 00:00:00`, `${toDate} 23:59:59`]);

    return rows.map(r => ({
      id: Number(r.id),
      userId: r.userId ? Number(r.userId) : null,
      entityId: r.entityId ? Number(r.entityId) : null,
      entityType: r.entityType ? Number(r.entityType) : null,
      title: r.title,
      description: r.description,
      itemId: r.itemId ? Number(r.itemId) : null,
      itemType: r.itemType ? Number(r.itemType) : null,
      itemData: r.itemData,
      created: r.created,
      salesManagerId: r.salesManagerId ? Number(r.salesManagerId) : null,
    }));
  }
}
