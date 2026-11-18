export const planSections = {
  event: { label: '活动信息', fields: { title: '活动名称', date: '活动日期', venue: '活动地点', target: '预计人数', budget: '预算总额（元）' },
    required: ['title', 'date', 'venue', 'target', 'budget'] },
  agenda: { label: '议程', fields: { name: '环节名称', date: '环节日期', start: '开始时间', end: '结束时间', room: '会场', host: '负责人或讲者',
    expected: '分场预计人数', equipment: '环节所需设备' },
    required: ['start', 'end', 'room'] },
  roster: { label: '人员名单', fields: { name: '姓名', role: '角色', organization: '单位' }, required: ['role'] },
  venues: { label: '场地', fields: { name: '场地名称', capacity: '场地容量', address: '地址', equipment: '设备' }, required: ['capacity'] },
  budgetItems: { label: '预算明细', fields: { name: '费用项目', amount: '金额（元）' }, required: ['amount'] },
};

export const topicPlanSections = {
  event: { ...planSections.event, fields: { ...planSections.event.fields, goal: '活动目标', audience: '目标受众', registrationUrl: '公开报名链接' } },
  agenda: { ...planSections.agenda, fields: { ...planSections.agenda.fields, duration: '建议时长（分钟）' } },
  roster: planSections.roster,
  roles: { label: '岗位分工', fields: { name: '岗位', duty: '职责', owner: '负责人' }, required: ['owner'] },
  tasks: { label: '筹备任务', fields: { name: '任务', offset: '距活动开始的倒排天数', owner: '负责人' }, required: ['owner'] },
  supplies: { label: '设备与物料', fields: { name: '物料', quantity: '数量' }, required: ['quantity'] },
  venues: planSections.venues,
  budgetItems: planSections.budgetItems,
};

export function missingPlanFields(plan, unresolved = []) {
  const missing = [];
  const pending = new Set(unresolved.map(fact => `${fact.section}:${fact.entityKey}:${fact.field}`));
  for (const [section, { label, fields, required }] of Object.entries(plan.topicPlan ? topicPlanSections : planSections)) {
    if (section === 'event') {
      for (const field of required) if (!plan.event[field] && !pending.has(`event::${field}`)) missing.push(fields[field]);
      continue;
    }
    const rows = plan[section] ?? [];
    if (!rows.length) missing.push(label);
    for (const row of rows) {
      for (const field of ['name', ...required]) {
        if (!row[field] && !pending.has(`${row.id}:${field}`)) missing.push(`${label} · ${row.name || '未命名'} · ${fields[field]}`);
      }
    }
  }
  return missing;
}

export function conflictEvidenceKey(fact) {
  return JSON.stringify(fact.options.map(option => [option.value, ...option.evidence.toSorted((a, b) => a.chunkId - b.chunkId)
    .map(item => item.textRevision ? `${item.chunkId}@${item.textRevision}` : item.chunkId)]).sort());
}

export function currentReviewChoice(fact, saved) {
  const choice = saved?.[fact.key];
  return choice?.evidence === conflictEvidenceKey(fact) ? choice : null;
}

export function reviewChoices(review, saved) {
  return Object.fromEntries(review.facts.flatMap(fact => {
    const choice = currentReviewChoice(fact, saved);
    if (!choice) return [];
    return [[fact.key, choice.status === '待核对' || choice.status === '已忽略' ? null : choice.value]];
  }));
}

export function planFromReview(review, choices) {
  const plan = { event: {}, agenda: [], roster: [], venues: [], budgetItems: [] };
  const rows = new Map();
  const reviewedNames = new Set(review.facts.filter(fact => fact.field === 'name')
    .map(fact => `${fact.section}:${fact.entityKey}`));
  for (const fact of review.facts) {
    const { section, entity, entityKey, field, key, options } = fact;
    let selected = options.length === 1 ? options[0] : null;
    if (Object.hasOwn(choices, key)) selected = choices[key] ? { value: choices[key] } : null;
    if (section === 'event') {
      if (selected) plan.event[field] = selected.value;
      continue;
    }
    const rowKey = `${section}:${entityKey}`;
    if (!rows.has(rowKey)) {
      const row = { id: rowKey };
      // 旧提取结果可能只有其他字段，此时仍用原文中的实体名标识该行。
      if (!reviewedNames.has(rowKey)) row.name = entity;
      rows.set(rowKey, row);
      plan[section].push(row);
    }
    if (selected) rows.get(rowKey)[field] = selected.value;
  }
  return plan;
}

export function applyReviewFields(plan, review, choices, selectedKeys) {
  const extracted = planFromReview(review, choices);
  const next = { ...plan, event: { ...plan.event } };
  for (const fact of review.facts) {
    if (!selectedKeys.includes(fact.key)) continue;
    if (fact.section === 'event') {
      if (extracted.event[fact.field] !== undefined) next.event[fact.field] = extracted.event[fact.field];
      continue;
    }
    const source = extracted[fact.section].find(row => row.id === `${fact.section}:${fact.entityKey}`);
    if (source?.[fact.field] === undefined) continue;
    const rows = next[fact.section] ?? [];
    const existing = rows.find(row => row.id === source.id);
    if (existing) next[fact.section] = rows.map(row => row.id === source.id ? { ...row, [fact.field]: source[fact.field] } : row);
    else next[fact.section] = [...rows, { id: source.id, name: source.name, [fact.field]: source[fact.field] }];
  }
  return next;
}

export function rebasePlanDraft(previous, next, edited) {
  const draft = { ...next, event: { ...next.event } };
  for (const [field, value] of Object.entries(edited.event)) {
    if (value !== previous.event[field]) draft.event[field] = value;
  }
  for (const section of Object.keys(topicPlanSections)) {
    if (section === 'event' || !Array.isArray(edited[section])) continue;
    const before = new Map((previous[section] ?? []).map(row => [row.id, row]));
    const local = new Map(edited[section].map(row => [row.id, row]));
    const rows = [];
    for (const row of next[section] ?? []) {
      const original = before.get(row.id);
      const unsaved = local.get(row.id);
      if (original && !unsaved) continue;
      const merged = { ...row };
      if (original && unsaved) {
        for (const [field, value] of Object.entries(unsaved)) {
          if (value !== original[field]) merged[field] = value;
        }
      }
      rows.push(merged);
    }
    for (const row of edited[section]) {
      if (!before.has(row.id) && !rows.some(item => item.id === row.id)) rows.push(row);
    }
    draft[section] = rows;
  }
  return draft;
}
