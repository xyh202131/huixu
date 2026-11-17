import { isClock } from './scheduling.js';
import { planDate, planNumber } from './topicPlan.js';

function publicRegistrationUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && !url.username && !url.password && host.includes('.') &&
        !host.endsWith('.local') && !host.endsWith('.localhost') && !/^[\d.]+$/.test(host)) return url.href;
  } catch {
    return '';
  }
  return '';
}

export function designPlanSource(event) {
  const draft = event.organizedPlan;
  if (!draft && !event.version) return null;
  const details = draft?.event;
  const agenda = draft ? draft.agenda : event.agenda.toSorted((a, b) => a.start.localeCompare(b.start));
  return {
    label: draft ? '已保存的活动方案草稿' : '活动发布版 v' + event.version,
    title: details?.title?.trim() || event.title,
    type: event.type,
    goal: details?.goal?.trim() || '［活动目标待确认］',
    audience: details?.audience?.trim() || '［目标受众待确认］',
    date: planDate(draft ? details.date : event.date) || '［活动日期待确认］',
    venue: (draft ? details.venue?.trim() : event.venue) || '［活动地点待确认］',
    registration: publicRegistrationUrl(details?.registrationUrl) || '［公开报名链接或二维码待补］',
    agenda: agenda.flatMap(row => {
      const name = (draft ? row.name : row.title)?.trim();
      if (!name) return [];
      const duration = planNumber(row.duration, 480);
      const timing = isClock(row.start) && isClock(row.end) ? row.start + '–' + row.end :
        duration ? '建议 ' + duration + ' 分钟' : '';
      return [name + (timing ? '（' + timing + '）' : '')];
    }),
  };
}

export function designPrompt(source, { kind, format, purpose = '活动介绍', style = '' }) {
  const visual = style.trim() || '保持信息层级清晰，视觉表达适合活动主题和受众。';
  const agenda = source.agenda.length ? source.agenda.map(item => '- ' + item).join('\n') : '［活动议程待确认］';
  const facts = [
    '活动名称：' + source.title, '活动类型：' + source.type, '目标受众：' + source.audience,
    '活动目标：' + source.goal, '日期：' + source.date, '地点：' + source.venue,
  ];
  const instructions = '沿用资料里的活动名称和安排。保留所有［待确认 / 待补］类占位信息，不自行补写日期、地点、嘉宾、主办方、链接或二维码。';
  if (kind === 'PPT') return [
    '请为这场活动设计一份 ' + format + ' 页的 16:9 中文 PPT，用于' + purpose + '。逐页输出标题、要点、版式建议、配图方向和讲稿提示。',
    '', ...facts, '报名入口：' + source.registration, '', '议程（按现有方案顺序）', agenda, '',
    '编排建议：从封面、活动目标和受众出发，再安排议程概览与重点环节。按用途组织参会指引或讨论内容，最后一页保留下一步行动。按指定页数拆分或合并。',
    '视觉要求：' + visual, instructions,
  ].join('\n');
  return [
    '请设计一张 ' + format + ' 的中文活动宣传海报。输出标题、副标题、信息排版建议，以及可直接交给图像生成工具的画面描述。',
    '', ...facts, '报名入口：' + source.registration, '', '可选取的议程亮点', agenda, '',
    '版面要求：先突出活动名称，再展示日期、地点和亮点。为报名行动引导及二维码留出独立空间。标题和事实信息适合后期排版。',
    '视觉要求：' + visual, instructions,
  ].join('\n');
}
