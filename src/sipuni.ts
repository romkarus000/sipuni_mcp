import crypto from 'crypto';
import axios from 'axios';
import { parse } from 'csv-parse/sync';

export interface SipuniCallRecord {
  callId: string;
  type: 'inbound' | 'outbound' | 'internal' | 'unknown';
  status: 'ANSWER' | 'NOANSWER' | 'BUSY' | 'CANCEL' | 'CONGESTION' | 'CHANUNAVAIL' | 'unknown';
  timestamp: number;
  dateTime: string;
  srcNum: string;
  dstNum: string;
  shortSrcNum: string;
  shortDstNum: string;
  managerName: string;
  duration: number;
  dialogDuration: number;
  recordId: string;
  recordExists: boolean;
  whoAnswered: string;
  whoTalked: string;
}

export class SipuniClient {
  private user: string;
  private secret: string;
  private baseUrl = 'https://sipuni.com/api';

  constructor(user: string, secret: string) {
    this.user = user;
    this.secret = secret;
  }

  /**
   * Сгенерировать контрольную подпись hash для API Sipuni.
   * Порядок склеивания параметров критически важен.
   */
  private generateHash(params: Record<string, string | number>): string {
    const hashOrder = [
      'anonymous',
      'crmLinks',
      'dtmfUserAnswer',
      'firstTime',
      'from',
      'fromNumber',
      'hangupinitor',
      'ignoreSpecChar',
      'names',
      'numbersInvolved',
      'numbersRinged',
      'outgoingLine',
      'rating',
      'showTreeId',
      'state',
      'timeFrom',
      'timeTo',
      'to',
      'toAnswer',
      'toNumber',
      'tree',
      'type',
      'user',
    ];

    const values = hashOrder.map((field) => {
      if (field === 'user') {
        return this.user;
      }
      return params[field] !== undefined ? String(params[field]) : '';
    });

    values.push(this.secret);

    return crypto.createHash('md5').update(values.join('+')).digest('hex');
  }

  /**
   * Извлечь короткий номер и имя из поля вида "428 (Додаев Иван)" или "+7908..."
   */
  private parseParty(value: string): { number: string; extension: string; name: string } {
    const raw = (value || '').trim();
    if (!raw) {
      return { number: '', extension: '', name: '' };
    }

    // "428 (Додаев Иван)" или "• 428 (Додаев Иван) 16"
    const withName = raw.match(/(\d{2,6})\s*\(([^)]+)\)/);
    if (withName) {
      return {
        number: withName[1],
        extension: withName[1],
        name: withName[2].trim(),
      };
    }

    // Чистый короткий добавочный
    if (/^\d{2,6}$/.test(raw)) {
      return { number: raw, extension: raw, name: '' };
    }

    // Внешний номер (+7..., 8..., 7...)
    const phone = raw.replace(/[^\d+]/g, '');
    return { number: phone || raw, extension: '', name: '' };
  }

  /**
   * Загрузить и распарсить статистику звонков за указанный период
   */
  async exportStatistics(
    fromDate: string,
    toDate: string,
    filters: {
      type?: '0' | '1' | '2' | '3';
      state?: '0' | '1' | '2';
    } = {}
  ): Promise<SipuniCallRecord[]> {
    const rawParams: Record<string, string | number> = {
      from: fromDate,
      to: toDate,
      anonymous: '1',
      crmLinks: '0',
      dtmfUserAnswer: '0',
      firstTime: '0',
      fromNumber: '',
      hangupinitor: '',
      ignoreSpecChar: '1',
      names: '1',
      numbersInvolved: '1',
      numbersRinged: '1',
      outgoingLine: '1',
      rating: '0',
      showTreeId: '1',
      state: filters.state || '0',
      timeFrom: '00:00',
      timeTo: '23:59',
      toAnswer: '',
      toNumber: '',
      tree: '',
      type: filters.type || '0',
    };

    const hash = this.generateHash(rawParams);

    const queryParams = {
      ...rawParams,
      user: this.user,
      hash,
    };

    try {
      const response = await axios.post(`${this.baseUrl}/statistic/export`, null, {
        params: queryParams,
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const buf = Buffer.from(response.data);
      // Sipuni отдаёт UTF-8 с BOM
      const decodedCsv =
        buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
          ? buf.slice(3).toString('utf8')
          : buf.toString('utf8');

      if (!decodedCsv.trim() || decodedCsv.startsWith('Error') || /ошибка|не найден/i.test(decodedCsv.slice(0, 200))) {
        console.error('Sipuni API error response or empty:', decodedCsv.slice(0, 300));
        return [];
      }

      const records = parse(decodedCsv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: ';',
        relax_column_count: true,
      }) as Record<string, string>[];

      return this.mapCsvRecords(records);
    } catch (error: any) {
      console.error('Failed to export statistics from Sipuni:', error.message);
      throw error;
    }
  }

  /**
   * Преобразовать сырые CSV-записи в типизированные объекты
   */
  private mapCsvRecords(records: Record<string, string>[]): SipuniCallRecord[] {
    return records.map((r) => {
      const dateTime = r['Время'] || r['Дата и время'] || '';
      const rawType = r['Тип'] || '';
      const rawStatus = r['Статус'] || '';
      const fromParty = this.parseParty(r['Откуда'] || '');
      const toParty = this.parseParty(r['Куда'] || '');
      const answeredParty = this.parseParty(r['Кто ответил'] || '');
      const talkedParty = this.parseParty(r['Кто разговаривал'] || '');
      const ringedParty = this.parseParty(r['Кому звонили'] || '');

      const callDuration = parseInt(r['Длительность звонка, сек'] || r['Длительность звонка'] || '0', 10) || 0;
      const dialogDuration =
        parseInt(r['Длительность разговора, сек'] || r['Длительность разговора'] || '0', 10) || 0;
      const recordId = r['ID записи'] || '';
      const recordExists = String(r['Запись существует'] || '') === '1';

      let type: SipuniCallRecord['type'] = 'unknown';
      const typeLower = rawType.toLowerCase();
      if (typeLower.includes('входящ')) {
        type = 'inbound';
      } else if (typeLower.includes('исходящ')) {
        type = 'outbound';
      } else if (typeLower.includes('внутрен')) {
        type = 'internal';
      }

      let status: SipuniCallRecord['status'] = 'unknown';
      const statusLower = rawStatus.toLowerCase().trim();
      if (statusLower.includes('не отвечен') || statusLower.includes('пропущен')) {
        status = 'NOANSWER';
      } else if (statusLower === 'отвечен' || statusLower === 'принят' || statusLower.includes('принят')) {
        status = 'ANSWER';
      } else if (statusLower.includes('занят')) {
        status = 'BUSY';
      } else if (statusLower.includes('отменен') || statusLower.includes('отменён')) {
        status = 'CANCEL';
      }

      let shortSrcNum = '';
      let shortDstNum = '';
      let managerName = '';

      if (type === 'outbound') {
        shortSrcNum = fromParty.extension || answeredParty.extension || talkedParty.extension || ringedParty.extension;
        managerName = fromParty.name || answeredParty.name || talkedParty.name || ringedParty.name;
      } else if (type === 'inbound') {
        shortDstNum =
          toParty.extension || answeredParty.extension || talkedParty.extension || ringedParty.extension;
        managerName = toParty.name || answeredParty.name || talkedParty.name || ringedParty.name;
      } else {
        shortSrcNum = fromParty.extension;
        shortDstNum = toParty.extension;
        managerName = fromParty.name || toParty.name || answeredParty.name;
      }

      let timestamp = Math.floor(Date.now() / 1000);
      if (dateTime) {
        const parts = dateTime.split(/[\s.:]+/);
        if (parts.length >= 6) {
          // DD.MM.YYYY HH:mm:ss
          const dateObj = new Date(
            parseInt(parts[2], 10),
            parseInt(parts[1], 10) - 1,
            parseInt(parts[0], 10),
            parseInt(parts[3], 10),
            parseInt(parts[4], 10),
            parseInt(parts[5], 10)
          );
          if (!isNaN(dateObj.getTime())) {
            timestamp = Math.floor(dateObj.getTime() / 1000);
          }
        }
      }

      return {
        callId: recordId,
        type,
        status,
        timestamp,
        dateTime,
        srcNum: fromParty.number,
        dstNum: toParty.number,
        shortSrcNum,
        shortDstNum,
        managerName,
        duration: callDuration,
        dialogDuration,
        recordId,
        recordExists,
        whoAnswered: (r['Кто ответил'] || '').trim(),
        whoTalked: (r['Кто разговаривал'] || '').trim(),
      };
    });
  }
}
