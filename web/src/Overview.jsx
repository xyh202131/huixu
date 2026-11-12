import { ArrowRight, ArrowRightLeft, CalendarDays, CalendarX2, CheckSquare, ChevronRight, Clock3, FileText, MapPin, Monitor, UploadCloud, UsersRound } from 'lucide-react';
import { AgentInput, Badge, Empty, IconTile, LinkButton, PageHead, Panel, Table } from './components';
import { MetricValue } from './interactions';
import { dateLabel, participantCount, roomLabel } from './model';

export function Overview({ event, navigate, ask, openImport }) {
  const completed = event.tasks.filter(task => task.done).length;
  const openIssues = event.issues.filter(issue => !issue.resolved);
  const stats = [
    [UsersRound, 'success', '确认报名', participantCount(event) + ' / ' + event.capacity, '已确认报名人数 / 目标人数', 'registration'],
    [CheckSquare, 'success', '筹备任务', completed + ' / ' + event.tasks.length, '已完成任务 / 总任务', 'prep'],
    [FileText, 'amber', '资料待确认', openIssues.length, '需确认的资料或信息', 'sources'],
    [ArrowRightLeft, 'purple', '待发布变更', Number(Boolean(event.change)), '待评估并发布的变更', 'change'],
  ];
  const pending = [
    ...openIssues.slice(0, 1).map(issue => [CalendarX2, 'rose', issue.title, '对照原文并确认采用的安排。', 'sources']),
    ...(event.change ? [[ArrowRightLeft, 'success', '确认' + event.change.title + '方案', event.change.reason + '，查看候选方案及发布影响。', 'change']] : []),
    ...(event.isSample && !event.replies.some(reply => reply.role === 'guest') ? [[FileText, 'blue', '嘉宾课件待提交', '查看嘉宾确认与课件提交情况。', 'external']] : []),
  ];
  return <>
    <PageHead title="活动概览" description="查看筹备进度、待确认资料和现场变化。">
      <button className="button" onClick={openImport}><UploadCloud size={18} />导入活动项目</button>
      <button className="button" onClick={() => navigate('live')}><Monitor size={18} />现场模式</button>
    </PageHead>
    <section className="overview-event" aria-label="当前活动">
      <IconTile icon={CalendarDays} />
      <div className="overview-event-copy">
        <div className="overview-event-title"><h2>{event.title}</h2><Badge tone="success">{event.onsite ? '进行中' : '筹备中'}</Badge></div>
        <div className="overview-event-meta">
          <span><Clock3 size={16} aria-hidden="true" />{dateLabel(event.date)}{event.date && ' 09:00–17:30'}</span>
          <span><MapPin size={16} aria-hidden="true" />{event.venue}{event.isSample && ' · A / B / C 厅'}</span>
        </div>
      </div>
      <button className="button" onClick={() => navigate('schedule')}>查看议程<ArrowRight size={16} aria-hidden="true" /></button>
    </section>
    <div className="metrics overview-metrics">
      {stats.map(([Icon, tone, title, value, note, page]) => <button className="metric overview-metric" onClick={() => navigate(page)} key={title}>
        <span className="overview-metric-head"><strong>{title}</strong><IconTile icon={Icon} tone={tone} /></span>
        <MetricValue value={value} />
        <span className="muted">{note}</span>
      </button>)}
    </div>
    <div className="overview-columns">
      <Panel title="当日议程" action={<LinkButton onClick={() => navigate('schedule')}>查看完整议程</LinkButton>}>
        <Table headers={['时间', '环节', '场地']}>
          {[...event.agenda].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4).map(session => <tr key={session.id}>
            <td className="tabular">{session.start}</td><td>{session.title}
              {openIssues.some(issue => issue.sessionId === session.id) ? <Badge tone="amber">待确认</Badge> : <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '已确认' : '草稿'}</Badge>}
            </td><td>{roomLabel(session.room)}</td>
          </tr>)}
        </Table>
      </Panel>
      <Panel title="待处理" action={pending.length > 0 && <LinkButton onClick={() => navigate(pending[0][4])}>查看首项</LinkButton>}>
        {pending.length ? <ul className="action-list">{pending.map(([Icon, tone, title, note, page]) => <li key={title}>
          <button onClick={() => navigate(page)}>
            <IconTile icon={Icon} tone={tone} />
            <span><strong>{title}</strong><small>{note}</small></span>
            <ChevronRight className="row-chevron" size={18} aria-hidden="true" />
          </button>
        </li>)}</ul> : <Empty>当前没有待处理事项。</Empty>}
      </Panel>
    </div>
    <AgentInput onSubmit={ask} />
  </>;
}
