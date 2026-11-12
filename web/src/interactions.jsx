import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export function MenuIcon() {
  return <span className="menu-icon" aria-hidden="true"><i /><i /><i /></span>;
}

export function Dialog({ title, close, variant = 'modal', className = '', footer, children }) {
  const element = useRef(null);
  const closeButton = useRef(null);
  const latestClose = useRef(close);
  const titleId = useId();
  useLayoutEffect(() => { latestClose.current = close; }, [close]);

  useLayoutEffect(() => {
    const dialog = element.current;
    const trigger = document.activeElement;
    const mobile = matchMedia('(max-width: 760px)');
    const dismiss = () => latestClose.current();
    const isDrawer = variant === 'drawer';

    if (isDrawer) {
      // 工作台只保留一个抽屉，避免多个编辑区互相遮挡。
      document.querySelectorAll('.dialog.drawer[open]').forEach(other => other.dispatchEvent(new Event('huixu:close-drawer')));
      dialog.addEventListener('huixu:close-drawer', dismiss);
    }
    function show() {
      const focused = dialog.contains(document.activeElement) ? document.activeElement : closeButton.current;
      if (dialog.open) dialog.close();
      if (isDrawer && !mobile.matches) dialog.show();
      else dialog.showModal();
      focused.focus({ preventScroll: true });
    }
    function escapeDrawer(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog:modal, :popover-open')) return;
      event.preventDefault();
      dismiss();
    }
    show();
    if (isDrawer) {
      mobile.addEventListener('change', show);
      document.addEventListener('keydown', escapeDrawer);
    }
    if (variant === 'navigation') mobile.addEventListener('change', dismiss);
    return () => {
      const hadFocus = dialog.contains(document.activeElement);
      dialog.close();
      dialog.removeEventListener('huixu:close-drawer', dismiss);
      document.removeEventListener('keydown', escapeDrawer);
      mobile.removeEventListener('change', show);
      mobile.removeEventListener('change', dismiss);
      if (hadFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [variant]);

  return <dialog ref={element} className={`dialog ${variant} ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (variant !== 'modal' && event.target === event.currentTarget) close();
    }}>
    <header className="dialog-head"><h2 id={titleId}>{title}</h2>
      <button ref={closeButton} type="button" className="icon-button" aria-label={variant === 'navigation' ? '关闭菜单' : '关闭'} onClick={close}>
        {variant === 'navigation' ? <MenuIcon /> : <X size={20} aria-hidden="true" />}
      </button>
    </header>
    <div className="dialog-body">{children}</div>
    {footer && <footer className="dialog-footer actions">{footer}</footer>}
  </dialog>;
}

export function Tooltip({ children, text }) {
  const id = useId();
  const anchor = useRef(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (dismissed) return;
    function dismiss(event) {
      if (event.key !== 'Escape') return;
      const hovered = matchMedia('(hover: hover)').matches && anchor.current.matches(':hover');
      if (!hovered && !anchor.current.querySelector(':focus-visible')) return;
      if (document.querySelector('dialog:modal') && !anchor.current.closest('dialog:modal')) return;
      setDismissed(true);
      event.preventDefault();
    }
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [dismissed]);
  return <span ref={anchor} className="tooltip-anchor" data-dismissed={dismissed} onMouseEnter={() => setDismissed(false)}
    onFocus={() => setDismissed(false)} onClick={() => setDismissed(true)}>
    {cloneElement(children, { 'aria-describedby': id })}
    <span className="tooltip" id={id} role="tooltip">{text}</span>
  </span>;
}

export function Popconfirm({ label, description, confirmLabel, onConfirm, className = 'button small' }) {
  const id = useId();
  const button = useRef(null);
  const popover = useRef(null);
  const cancel = useRef(null);
  const [open, setOpen] = useState(false);

  function position() {
    const anchor = button.current.getBoundingClientRect();
    const panel = popover.current;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const below = anchor.bottom + height + 16 <= window.innerHeight;
    const top = below ? anchor.bottom + 8 : anchor.top - height - 8;
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)) + 'px';
  }

  useEffect(() => {
    if (!open) return;
    function hide() { popover.current?.hidePopover(); }
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open]);

  return <>
    <button ref={button} className={className} type="button" popoverTarget={id} aria-haspopup="dialog">{label}</button>
    <div ref={popover} id={id} className="popconfirm" role="dialog" aria-label={description} popover="auto"
      onBeforeToggle={event => {
        if (event.newState !== 'open') return;
        const panel = popover.current;
        panel.style.visibility = 'hidden';
        requestAnimationFrame(() => {
          if (!panel.matches(':popover-open')) return;
          position();
          panel.style.visibility = '';
          cancel.current.focus({ preventScroll: true });
        });
      }} onToggle={event => setOpen(event.newState === 'open')}>
      <p><AlertCircle size={17} aria-hidden="true" />{description}</p>
      <div className="actions compact">
        <button ref={cancel} type="button" className="button small" popoverTarget={id} popoverTargetAction="hide">取消</button>
        <button type="button" className="button small primary" onClick={() => { popover.current.hidePopover(); onConfirm(); }}>{confirmLabel}</button>
      </div>
    </div>
  </>;
}

export function Notice({ tone = 'info', announce = false, children }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'info' ? Info : AlertCircle;
  const role = announce ? (tone === 'error' ? 'alert' : 'status') : undefined;
  return <div className={'notice ' + tone} role={role}><Icon size={19} aria-hidden="true" /><div>{children}</div></div>;
}

export function Toast({ feedback, dismiss }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!feedback || paused) return;
    const timer = setTimeout(dismiss, 4400);
    return () => clearTimeout(timer);
  }, [feedback, paused, dismiss]);

  return <>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{feedback && <span key={feedback.id}>{feedback.text}</span>}</div>
    {feedback && <div className="toast" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
      <CheckCircle2 size={20} aria-hidden="true" /><span>{feedback.text}</span>
      <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => { setPaused(false); dismiss(); }}><X size={17} aria-hidden="true" /></button>
    </div>}
  </>;
}

export function CheckControl({ checked, onChange, label, description, variant = 'check' }) {
  return <label className={'check-control ' + variant}>
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)}
      role={variant === 'switch' ? 'switch' : undefined} aria-label={label} />
    <span className="check-mark" aria-hidden="true">{variant === 'check' && <svg viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" /></svg>}</span>
    <span aria-hidden="true">{description}</span>
  </label>;
}

export function MetricValue({ value, compact = false }) {
  return <b className={compact ? 'metric-inline' : 'metric-value'}><span key={value}>{value}</span></b>;
}
