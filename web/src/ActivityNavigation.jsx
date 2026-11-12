import { useEffect, useRef, useState } from 'react';
import { BookOpen, Calendar, FileText, Home, Layers, List, Monitor, Sparkles, Ticket, X } from 'lucide-react';

export const chapters = [
  { id: 'overview', label: '活动概况', icon: Home },
  { id: 'sources', label: '资料与确认', icon: FileText },
  { id: 'schedule', label: '方案与议程', icon: Calendar },
  { id: 'prep', label: '筹备与协作', icon: Layers, subsections: [{ id: 'external', label: '外部协作' }] },
  { id: 'registration', label: '报名与发布', icon: Ticket,
    subsections: [{ id: 'materials', label: '材料与沟通' }, { id: 'change', label: '变更单' }] },
  { id: 'live', label: '现场执行', icon: Monitor },
  { id: 'review', label: '复盘与模板', icon: BookOpen },
];
const sections = chapters.flatMap(chapter => [chapter, ...(chapter.subsections ?? [])]);

export function chapterFor(page) {
  return chapters.find(chapter => chapter.id === page || chapter.subsections?.some(section => section.id === page)) ?? chapters[0];
}

export function jumpToActivity(route, smooth = false) {
  const [page, detail, item] = route;
  const chapterId = 'activity-' + (page || 'overview');
  let target;
  if (page === 'sources' && detail === 'issue' && item) target = document.getElementById('activity-issue-' + item);
  if (page === 'schedule' && detail === 'plan') target = document.getElementById('activity-organized-plan');
  target ??= document.getElementById(chapterId) ?? document.getElementById('workbench');
  if (!target) return;

  const heading = target.querySelector('h1, h2, h3') ?? target;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  const behavior = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant';
  if (!page || page === 'overview') window.scrollTo({ top: 0, behavior });
  else target.scrollIntoView({ block: 'start', behavior });
}

export function ActivityDirectory({ id, page, mobile, navigate, agentOpen, toggleAgent }) {
  const directory = useRef(null);
  const [visibleSection, setVisibleSection] = useState(null);
  const current = visibleSection ?? page;

  useEffect(() => {
    let frame = 0;
    function measure() {
      frame = 0;
      const header = document.querySelector('.activity-topbar')?.getBoundingClientRect();
      const readingLine = (header?.bottom ?? 0) + 42;
      let active = sections[0].id;
      for (const { id } of sections) {
        const section = document.getElementById('activity-' + id);
        if (section && section.getBoundingClientRect().top <= readingLine) active = id;
      }
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
        active = sections.at(-1).id;
      }
      setVisibleSection(active);
    }
    function update() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    update();
    const layout = new ResizeObserver(update);
    layout.observe(document.getElementById('workbench'));
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      layout.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  function openSection(event, section) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (mobile && directory.current.matches(':popover-open')) directory.current.hidePopover();
    navigate(section);
  }

  return <>
    <nav ref={directory} id={id} popover={mobile ? 'auto' : undefined} className="chapter-directory" aria-label="活动目录">
      <div className="directory-heading">
        <h2>活动目录</h2>
        {mobile && <button type="button" className="icon-button" aria-label="关闭活动目录" popoverTarget={id} popoverTargetAction="hide">
          <X size={18} aria-hidden="true" />
        </button>}
      </div>
      <div className="directory-links">
        {chapters.map(({ id: chapterId, label, icon: Icon, subsections }) => <div key={chapterId}>
          <a href={'#/' + chapterId} aria-current={current === chapterId ? 'location' : undefined}
            data-active-group={subsections?.some(section => section.id === current) || undefined}
            onClick={event => openSection(event, chapterId)}><Icon size={18} aria-hidden="true" />{label}</a>
          {subsections?.map(section => <a className="directory-subsection" key={section.id} href={'#/' + section.id}
            aria-current={current === section.id ? 'location' : undefined}
            onClick={event => openSection(event, section.id)}>{section.label}</a>)}
        </div>)}
      </div>
    </nav>
    {mobile && <nav className="mobile-activity-nav" aria-label="手机工作台导航">
      <a href="#/overview" aria-current={current === 'overview' ? 'location' : undefined} onClick={event => openSection(event, 'overview')}>
        <Home size={20} aria-hidden="true" /><span>概况</span>
      </a>
      <button type="button" className="mobile-nav-menu" aria-label="活动目录" popoverTarget={id}>
        <List size={21} aria-hidden="true" /><span>目录</span>
      </button>
      <a href="#/live" aria-current={current === 'live' ? 'location' : undefined} onClick={event => openSection(event, 'live')}>
        <Monitor size={20} aria-hidden="true" /><span>现场</span>
      </a>
      <button type="button" aria-label="切换 Agent 工作台" aria-haspopup="dialog" aria-expanded={agentOpen} onClick={toggleAgent}>
        <Sparkles size={20} aria-hidden="true" /><span>Agent</span>
      </button>
    </nav>}
  </>;
}
