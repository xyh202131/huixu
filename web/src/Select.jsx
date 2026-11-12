import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export function Select({ label, name, options, value, defaultValue, onChange, compact = false }) {
  const id = useId();
  const trigger = useRef(null);
  const listbox = useRef(null);
  const initialHighlight = useRef(null);
  const typeahead = useRef({ text: '', time: 0 });
  const choices = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const selectedIndex = Math.max(0, choices.findIndex(option => option.value === (value ?? internalValue)));
  const selected = choices[selectedIndex];
  const listId = id + '-options';

  useEffect(() => {
    const form = trigger.current.form;
    if (!form) return;
    function reset(event) {
      queueMicrotask(() => { if (!event.defaultPrevented) setInternalValue(defaultValue); });
    }
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [defaultValue]);

  function position() {
    const button = trigger.current;
    const list = listbox.current;
    const anchor = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const above = anchor.top - topEdge - 14;
    const below = topEdge + viewportHeight - anchor.bottom - 14;
    if (above < -anchor.height || below < -anchor.height) {
      list.hidePopover();
      return;
    }
    const width = Math.min(viewportWidth - 16, Math.max(anchor.width, 196));
    list.style.width = width + 'px';
    const opensUp = below < Math.min(list.scrollHeight + 2, 288) && above > below;
    list.dataset.side = opensUp ? 'top' : 'bottom';
    list.style.maxHeight = Math.min(288, Math.max(48, opensUp ? above : below)) + 'px';
    list.style.left = Math.max(leftEdge + 8, Math.min(anchor.left, leftEdge + viewportWidth - width - 8)) + 'px';
    list.style.top = opensUp ? 'auto' : (anchor.bottom + 6) + 'px';
    list.style.bottom = opensUp ? (window.innerHeight - anchor.top + 6) + 'px' : 'auto';
  }

  useEffect(() => {
    if (!expanded) return;
    function reposition(event) {
      if (event.target === listbox.current || !listbox.current.matches(':popover-open')) return;
      position();
    }
    const viewport = window.visualViewport;
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    viewport?.addEventListener('resize', reposition);
    viewport?.addEventListener('scroll', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      viewport?.removeEventListener('resize', reposition);
      viewport?.removeEventListener('scroll', reposition);
    };
  }, [expanded]);

  function revealOption(index) {
    const list = listbox.current;
    const option = list.children[index];
    if (!option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    const optionBottom = option.offsetTop + option.offsetHeight;
    if (optionBottom > list.scrollTop + list.clientHeight) list.scrollTop = optionBottom - list.clientHeight;
  }

  function highlight(index) {
    setHighlighted(index);
    revealOption(index);
  }

  function show(index = selectedIndex) {
    initialHighlight.current = index;
    listbox.current.showPopover({ source: trigger.current });
  }

  function hide() {
    listbox.current.hidePopover();
    setExpanded(false);
  }

  function choose(index) {
    const option = choices[index];
    hide();
    if (!option || option.value === selected?.value) return;
    if (value === undefined) setInternalValue(option.value);
    onChange?.(option.value);
  }

  function handleKey(event) {
    const open = listbox.current.matches(':popover-open');
    if (event.key === 'Tab') {
      if (open) choose(highlighted);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(highlighted);
      else show();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (event.altKey && event.key === 'ArrowUp' && open) { choose(highlighted); return; }
      let index = open ? highlighted : selectedIndex;
      if (event.key === 'Home') index = 0;
      if (event.key === 'End') index = choices.length - 1;
      if (open && event.key === 'ArrowDown') index = Math.min(choices.length - 1, index + 1);
      if (open && event.key === 'ArrowUp') index = Math.max(0, index - 1);
      if (open) highlight(index);
      else show(index);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const now = Date.now();
    const key = event.key.toLowerCase();
    const previous = now - typeahead.current.time < 650 ? typeahead.current.text : '';
    const query = previous === key ? key : previous + key;
    typeahead.current = { text: query, time: now };
    const start = open ? highlighted : selectedIndex;
    for (let offset = 1; offset <= choices.length; offset += 1) {
      const index = (start + offset) % choices.length;
      if (!choices[index].label.toLowerCase().startsWith(query)) continue;
      event.preventDefault();
      if (open) highlight(index);
      else show(index);
      break;
    }
  }

  return <div className={'select-field' + (compact ? ' compact-select' : '')}>
    {!compact && <label htmlFor={id}>{label}</label>}
    {name && selected && <input type="hidden" name={name} value={selected.value} />}
    <button ref={trigger} id={id} className="select-trigger" type="button" role="combobox" aria-label={label}
      aria-controls={listId} aria-expanded={expanded} aria-haspopup="listbox" popoverTarget={listId} disabled={!selected}
      aria-activedescendant={expanded && choices[highlighted] ? listId + '-' + highlighted : undefined}
      onKeyDown={handleKey}>
      <span>{selected?.label ?? '暂无选项'}</span><ChevronDown size={17} aria-hidden="true" />
    </button>
    <ul ref={listbox} id={listId} className={'select-options' + (compact ? ' select-activities' : '')} role="listbox" aria-label={label} popover="auto"
      onBeforeToggle={event => {
        if (event.newState !== 'open') return;
        const index = initialHighlight.current ?? selectedIndex;
        initialHighlight.current = null;
        setHighlighted(index);
        requestAnimationFrame(() => {
          if (!listbox.current?.matches(':popover-open')) return;
          position();
          const activeIndex = Array.from(listbox.current.children).findIndex(option => option.dataset.highlighted === 'true');
          revealOption(activeIndex < 0 ? index : activeIndex);
        });
      }}
      onToggle={event => setExpanded(event.currentTarget.matches(':popover-open'))}>
      {choices.map((option, index) => <li id={listId + '-' + index} key={option.value} role="option" aria-selected={index === selectedIndex}
        data-highlighted={index === highlighted} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span className="select-option-text"><span>{option.label}</span>{option.detail && <small>{option.detail}</small>}</span>
        {index === selectedIndex && <Check size={16} aria-hidden="true" />}
      </li>)}
    </ul>
  </div>;
}
