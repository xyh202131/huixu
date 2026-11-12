export const planSections = {
  event: { label: '活动信息', fields: { title: '活动名称', date: '活动日期', venue: '活动地点', target: '预计人数', budget: '预算总额（元）' },
    required: ['title', 'date', 'venue', 'target', 'budget'] },
  agenda: { label: '议程', fields: { name: '环节名称', date: '环节日期', start: '开始时间', end: '结束时间', room: '会场', host: '负责人或讲者' },
    required: ['start', 'end', 'room'] },
  roster: { label: '人员名单', fields: { name: '姓名', role: '角色', organization: '单位' }, required: ['role'] },
  venues: { label: '场地', fields: { name: '场地名称', capacity: '场地容量', address: '地址', equipment: '设备' }, required: ['capacity'] },
  budgetItems: { label: '预算明细', fields: { name: '费用项目', amount: '金额（元）' }, required: ['amount'] },
};

export function missingPlanFields(plan, unresolved = []) {
  const missing = [];
  const pending = new Set(unresolved.map(fact => `${fact.section}:${fact.entityKey}:${fact.field}`));
  for (const [section, { label, fields, required }] of Object.entries(planSections)) {
    if (section === 'event') {
      for (const field of required) if (!plan.event[field] && !pending.has(`event::${field}`)) missing.push(fields[field]);
      continue;
    }
    if (!plan[section].length) missing.push(label);
    for (const row of plan[section]) {
      for (const field of ['name', ...required]) {
        if (!row[field] && !pending.has(`${row.id}:${field}`)) missing.push(`${label} · ${row.name || '未命名'} · ${fields[field]}`);
      }
    }
  }
  return missing;
}

export function conflictEvidenceKey(fact) {
  return JSON.stringify(fact.options.map(option => [option.value, ...option.evidence.map(item => item.chunkId).sort((a, b) => a - b)]).sort());
}

export function reviewChoices(review, saved) {
  return Object.fromEntries(review.facts.flatMap(fact => {
    const choice = saved?.[fact.key];
    return fact.options.length > 1 && choice?.evidence === conflictEvidenceKey(fact) ? [[fact.key, choice.value]] : [];
  }));
}

export function planFromReview(review, choices) {
  const plan = { event: {}, agenda: [], roster: [], venues: [], budgetItems: [] };
  const rows = new Map();
  for (const fact of review.facts) {
    const { section, entity, entityKey, field, key, options } = fact;
    const selected = options.length === 1 ? options[0] : options.find(option => option.value === choices[key]);
    if (section === 'event') {
      if (selected) plan.event[field] = selected.value;
      continue;
    }
    const rowKey = `${section}:${entityKey}`;
    if (!rows.has(rowKey)) {
      const row = { id: rowKey, name: entity };
      rows.set(rowKey, row);
      plan[section].push(row);
    }
    if (selected) rows.get(rowKey)[field] = selected.value;
  }
  return plan;
}
