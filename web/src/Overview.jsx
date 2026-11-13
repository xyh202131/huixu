import { ArrowRight, ArrowRightLeft, CalendarDays, CalendarX2, CheckSquare, ChevronRight, Clock3, FileText, MapPin, Monitor, UploadCloud, UsersRound } from 'lucide-react';
import { Badge, Empty, IconTile, LinkButton, Panel } from './components';
import { MetricValue } from './interactions';
import { MarbleFlow } from './MarbleFlow';
import { dateLabel, liveAgenda, participantCount, roomLabel, timeRange } from './model';

export function Overview({ event, readOnly, navigate, openImport }) {
  const completed = event.tasks.filter(task => task.done).length;
  const openIssues = event.issues.filter(issue => !issue.resolved);
  const sessions = [...event.agenda].sort((a, b) => a.start.localeCompare(b.start));
  const { current, next } = liveAgenda(event, sessions);
  const agendaRows = event.onsite
    ? [[current, '当前'], [next, '下一场']].filter(([item]) => item)
    : sessions.slice(0, 4).map(item => [item, '']);
  const stats = [
    [UsersRound, 'success', '确认报名', participantCount(event) + ' / ' + event.capacity, '已确认报名人数 / 目标人数', 'registration'],
    [CheckSquare, 'success', '筹备任务', completed + ' / ' + event.tasks.length, '已完成任务 / 总任务', 'prep'],
    [FileText, 'amber', '资料待确认', openIssues.length, '需确认的资料或信息', 'sources'],
    [ArrowRightLeft, 'purple', '待发布变更', Number(Boolean(event.change)), '待评估并发布的变更', 'change'],
  ];
  const pending = [
    ...openIssues.map(issue => [CalendarX2, 'rose', issue.title, readOnly ? '查看两份资料的原文差异。' : '对照原文并确认采用的安排。', 'sources/issue/' + issue.id]),
    ...(event.change ? [[ArrowRightLeft, 'success', '确认' + event.change.title + '方案', event.change.reason + '，查看候选方案及发布影响。', 'change']] : []),
    ...(event.isSample && !event.replies.some(reply => reply.role === 'guest') ? [[FileText, 'blue', '嘉宾课件待提交', '查看嘉宾确认与课件提交情况。', 'external']] : []),
  ];
  return <>
    <header className="overview-event">
      <MarbleFlow />
      <div className="overview-event-copy">
        <div className="overview-event-status"><CalendarDays size={16} aria-hidden="true" /><span>{event.type}</span>
          {readOnly && <Badge tone="neutral">示例活动</Badge>}
          <Badge tone="success">{event.onsite ? '进行中' : '筹备中'}</Badge></div>
        <h1>{event.title}</h1>
        <div className="overview-event-meta">
          <span><Clock3 size={16} aria-hidden="true" />{dateLabel(event.date)}{event.date && ' 09:00–17:30'}</span>
          <span><MapPin size={16} aria-hidden="true" />{event.venue}{event.isSample && ' · A / B / C 厅'}</span>
        </div>
      </div>
      <div className="overview-event-actions">
        {!readOnly && <button type="button" className="button" onClick={openImport}><UploadCloud size={17} aria-hidden="true" />导入活动项目</button>}
        <button type="button" className="button" onClick={() => navigate('live')}><Monitor size={17} aria-hidden="true" />现场模式</button>
        <button type="button" className="button primary" onClick={() => navigate('schedule')}>查看议程<ArrowRight size={16} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="metrics overview-metrics">
      {stats.map(([Icon, tone, title, value, note, page]) => <button className="metric overview-metric" onClick={() => navigate(page)} key={title}>
        <span className="overview-metric-head"><strong>{title}</strong><IconTile icon={Icon} tone={tone} /></span>
        <MetricValue value={value} />
        <span className="muted">{note}</span>
      </button>)}
    </div>
    <div className="overview-details">
      <Panel title={event.onsite ? '现场议程' : '当日议程'} className="overview-agenda" action={
        <LinkButton onClick={() => navigate(event.onsite ? 'live' : 'schedule')}>{event.onsite ? '查看现场' : '完整议程'}</LinkButton>
      }>
        {agendaRows.length ? <ul className="overview-agenda-list">{agendaRows.map(([item, label]) => <li key={item.id}>
          <span className="tabular">{label === '当前' ? '开始于 ' + event.actual[item.id].started : timeRange(item)}</span>
          <div><strong>{item.title}</strong><small>{roomLabel(item.room)}</small></div>
          {label && <Badge tone={label === '当前' ? 'success' : 'neutral'}>{label}</Badge>}
        </li>)}</ul> : <Empty>{event.onsite && sessions.length ? '当日环节已结束。' : '暂无议程。'}</Empty>}
      </Panel>
      <Panel title="待处理" className="activity-pending" action={pending.length > 0 && <Badge tone="neutral">{pending.length} 项</Badge>}>
        {pending.length ? <ul className="action-list">{pending.map(([Icon, tone, title, note, page]) => <li key={title}>
          <button onClick={() => navigate(page)}>
            <IconTile icon={Icon} tone={tone} />
            <span><strong>{title}</strong><small>{note}</small></span>
            <ChevronRight className="row-chevron" size={18} aria-hidden="true" />
          </button>
        </li>)}</ul> : <Empty>当前没有待处理事项。</Empty>}
      </Panel>
    </div>
  </>;
}
