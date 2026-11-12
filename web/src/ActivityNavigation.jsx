import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Calendar, ChevronDown, FileText, Home, Layers, List, Monitor, Ticket } from 'lucide-react';

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

export function ActivityDirectory({ page, followScroll, navigate }) {
  const id = useId();
  const button = useRef(null);
  const popover = useRef(null);
  const [open, setOpen] = useState(false);
  const [visibleChapter, setVisibleChapter] = useState(null);
  const current = visibleChapter ?? chapterFor(page);

  useEffect(() => {
    if (!followScroll) return;
    let frame = 0;
    function measure() {
      frame = 0;
      const header = document.querySelector('.activity-topbar')?.getBoundingClientRect();
      const readingLine = (header?.bottom ?? 0) + 42;
      let active = chapters[0];
      for (const chapter of chapters) {
        const section = document.getElementById('activity-' + chapter.id);
        if (section && section.getBoundingClientRect().top <= readingLine) active = chapter;
      }
      if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
        active = chapters[chapters.length - 1];
      }
      setVisibleChapter(active);
    }
    function update() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [followScroll]);

  function placeDirectory() {
    const anchor = button.current.getBoundingClientRect();
    popover.current.style.setProperty('--directory-top', anchor.bottom + 9 + 'px');
    popover.current.style.setProperty('--directory-right', Math.max(12, window.innerWidth - anchor.right) + 'px');
  }

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', placeDirectory);
    return () => window.removeEventListener('resize', placeDirectory);
  }, [open]);

  function openSection(event, section) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    popover.current.hidePopover();
    navigate(section);
  }

  return <>
    <button ref={button} type="button" className="button directory-trigger" popoverTarget={id}
      aria-controls={id} aria-expanded={open} aria-label={'活动目录，当前' + current.label}>
      <List size={18} aria-hidden="true" /><span>目录</span><span className="directory-location">{current.label}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    <nav ref={popover} id={id} popover="auto" className="chapter-directory" aria-label="活动目录"
      onBeforeToggle={event => { if (event.newState === 'open') placeDirectory(); }}
      onToggle={event => setOpen(event.newState === 'open')}>
      {chapters.map(({ id: chapterId, label, icon: Icon, subsections }) => <div key={chapterId}>
        <a href={'#/' + chapterId} aria-current={current.id === chapterId ? 'location' : undefined}
          onClick={event => openSection(event, chapterId)}><Icon size={18} aria-hidden="true" />{label}</a>
        {subsections?.map(section => <a className="directory-subsection" key={section.id} href={'#/' + section.id}
          onClick={event => openSection(event, section.id)}>{section.label}</a>)}
      </div>)}
    </nav>
  </>;
}
