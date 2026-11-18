import { Dialog } from './interactions';
import { Badge } from './components';
import { workItems } from './workItems';
import { dateLabel } from './model';

export function TeamBoard({ events, open, close }) {
  const ordered = events.toSorted((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const samples = ordered.filter(item => item.isSample || ['forum', 'training', 'expo', 'market', 'campus'].includes(item.id));
  const own = ordered.filter(item => !samples.includes(item));
  function eventCard(event) {
    const { sources, changes } = workItems(event);
    const tasks = event.tasks.filter(task => !task.done);
    const due = tasks.map(task => {
      if (task.offset == null || !event.date) return { task, date: null };
      const date = new Date(event.date + 'T00:00:00');
      date.setDate(date.getDate() - task.offset);
      return { task, date };
    }).sort((a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity));
    return <section key={event.id} className="team-event">
      <button className="link-button" onClick={() => open(event.id, 'overview')}>{event.title}</button>
      <span className="muted">{dateLabel(event.date)} · {event.type}</span>
      <div className="actions compact">
        <Badge>{sources.length} 项资料待确认</Badge><Badge>{changes.length} 张变更单</Badge><Badge>{tasks.length} 项待办</Badge>
      </div>
      <ul className="plain-list">
        {sources.map(item => <li key={item.route}><button className="link-button" onClick={() => open(event.id, item.route)}>{item.title}</button></li>)}
        {changes.map(item => <li key={item.id}><button className="link-button" onClick={() => open(event.id, 'change', item)}>{item.title}</button></li>)}
        {due.slice(0, 2).map(({ task, date }) => <li key={task.id}><button className="link-button" onClick={() => open(event.id, 'prep/task/' + task.id)}>
          {task.name} · {task.owner} · {date ? date.toLocaleDateString('zh-CN') + ' 截止' : '截止待定'}</button></li>)}
      </ul>
    </section>;
  }
  return <Dialog title="团队活动总览" variant="drawer" fullOnMobile close={close}>
    <div className="form-stack">{own.map(eventCard)}
      {own.length && samples.length ? <details className="import-review-detail"><summary>示例活动（{samples.length}）</summary>
        {samples.map(eventCard)}</details> : samples.map(eventCard)}
    </div>
  </Dialog>;
}
