import { extname } from 'node:path';
import { parseSpreadsheet } from './sourceParser.js';
import { RegistrationError } from './registrationStore.js';

const headers = new Map([
  ['报名编号', 'id'], ['个人凭证', 'id'], ['id', 'id'], ['姓名', 'name'], ['name', 'name'],
  ['邮箱', 'email'], ['email', 'email'], ['电子邮箱', 'email'], ['分场', 'session'], ['场次', 'session'],
  ['场次编号', 'session'], ['审核状态', 'status'], ['报名状态', 'status'], ['备注', 'note'],
]);

export async function registrationSpreadsheet(name, buffer) {
  if (!['.xlsx', '.xls', '.csv', '.tsv'].includes(extname(name).toLowerCase())) {
    throw new RegistrationError(400, '请选择 XLSX、XLS、CSV 或 TSV 名单。');
  }
  const result = await parseSpreadsheet(name, buffer).catch(error => {
    if (error.status === 429) throw new RegistrationError(429, error.message);
    throw error;
  });
  if (!result.sheets) throw new RegistrationError(400, result.error || '名单无法读取，请核对文件格式。');
  const rows = [];
  for (const sheet of result.sheets) {
    const [heading, ...entries] = sheet;
    if (!heading) continue;
    const fields = heading.cells.map(value => headers.get(value.trim().toLowerCase()));
    if (!fields.includes('name') || new Set(fields.filter(Boolean)).size !== fields.filter(Boolean).length) {
      throw new RegistrationError(400, '名单首行需要唯一的「姓名」表头，其他列可填写报名编号、邮箱、分场、审核状态和备注。');
    }
    for (const { cells, location } of entries) {
      const row = { location };
      fields.forEach((field, index) => {
        if (field && (cells[index] || ['email', 'session', 'note'].includes(field))) row[field] = cells[index] ?? '';
      });
      rows.push(row);
    }
  }
  if (!rows.length || rows.length > 1000) throw new RegistrationError(400, '每批名单需要 1–1000 行有效数据。');
  return rows;
}
