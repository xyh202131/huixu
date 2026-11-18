// 复用 rengong DirectionDock 的距离衰减、触控确认和点击去重。
// Lucian UX/UI Prompt #208 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#208
import { useEffect } from 'react';

export function useDockMagnification(ref, enabled) {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    const items = Array.from(root.children).map(control => ({ control, slot: control.querySelector('.dock-icon-slot'), center: 0, weight: 0 }));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let pointerX = null, focused = -1, frame = 0, activationFrame = 0, gesture = null, suppressClick = false;
    let width = root.clientWidth;

    function measure() {
      // 测量固定槽位，图标放大不会改变下一帧的命中中心。
      for (const item of items) {
        const bounds = item.slot.getBoundingClientRect();
        item.center = bounds.left + bounds.width / 2;
      }
    }
    function nearest(x) {
      return items.reduce((best, item, index) => Math.abs(item.center - x) < Math.abs(items[best].center - x) ? index : best, 0);
    }
    function draw() {
      frame = 0;
      const aim = pointerX ?? (focused >= 0 ? items[focused].center : null);
      const active = aim === null ? -1 : nearest(aim);
      const spread = Math.abs(items[1].center - items[0].center) * 1.3;
      let moving = false;
      items.forEach((item, index) => {
        item.control.toggleAttribute('data-preview', index === active);
        const distance = aim === null ? 0 : (aim - item.center) / spread;
        const target = aim === null || reduced.matches ? 0 : Math.exp(-distance * distance * 1.6);
        item.weight += (target - item.weight) * (gesture || reduced.matches ? 1 : .35);
        if (Math.abs(target - item.weight) > .001) moving = true;
        else item.weight = target;
        item.control.style.setProperty('--dock-scale', (1 + item.weight * .3).toFixed(4));
        item.control.style.setProperty('--dock-lift', (item.weight * 14).toFixed(2) + 'px');
      });
      if (moving) frame = requestAnimationFrame(draw);
    }
    function update() { if (!frame) frame = requestAnimationFrame(draw); }
    function cancel() {
      cancelAnimationFrame(activationFrame);
      const previous = gesture;
      gesture = null;
      pointerX = null;
      focused = -1;
      delete root.dataset.dragging;
      if (previous && root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id);
      update();
    }
    function contains(x, y) {
      const bounds = root.getBoundingClientRect();
      return x >= bounds.left && x <= bounds.right && y >= bounds.top - 16 && y <= bounds.bottom;
    }
    function down(event) {
      if (event.pointerType === 'mouse') { suppressClick = false; return; }
      if (!event.isPrimary || event.button !== 0 || gesture) return;
      measure();
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
      suppressClick = true;
      pointerX = event.clientX;
      focused = -1;
      root.dataset.dragging = '';
      root.setPointerCapture(event.pointerId);
      update();
    }
    function move(event) {
      if (event.pointerType === 'mouse') { measure(); pointerX = event.clientX; update(); return; }
      if (gesture?.id !== event.pointerId) return;
      const horizontal = Math.abs(event.clientX - gesture.x), vertical = Math.abs(event.clientY - gesture.y);
      if (!contains(event.clientX, event.clientY) || (vertical > 12 && vertical > horizontal)) { cancel(); return; }
      if (horizontal > 6) event.preventDefault();
      pointerX = event.clientX;
      update();
    }
    function up(event) {
      if (gesture?.id !== event.pointerId) return;
      const chosen = nearest(event.clientX);
      const confirmed = contains(event.clientX, event.clientY) &&
        !(Math.abs(event.clientY - gesture.y) > 12 && Math.abs(event.clientY - gesture.y) > Math.abs(event.clientX - gesture.x));
      cancel();
      // 始终走原生控件入口，保留目录 popover、链接与 Agent 开关。
      // 先消化浏览器补发的点击，再打开弹窗，避免补发点击落在新遮罩上。
      if (confirmed) activationFrame = requestAnimationFrame(() => items[chosen].control.click());
    }
    function pointerCancel(event) { if (gesture?.id === event.pointerId) cancel(); }
    function lostCapture(event) { if (event.target === root && gesture?.id === event.pointerId) cancel(); }
    function leave(event) { if (event.pointerType === 'mouse') { pointerX = null; update(); } }
    function focusIn(event) {
      focused = items.findIndex(item => item.control === event.target.closest('a, button'));
      pointerX = null;
      measure();
      update();
    }
    function focusOut() { focused = -1; update(); }
    function keyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = items.findIndex(item => item.control === document.activeElement);
      if (current < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1);
      event.preventDefault();
      items[(next + items.length) % items.length].control.focus();
    }
    function click(event) {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
    }
    function contextMenu(event) { if (gesture) event.preventDefault(); }
    function pageScroll() { if (gesture || pointerX !== null) cancel(); }
    function hidden() { if (document.hidden) cancel(); }
    measure();
    const resize = new ResizeObserver(() => {
      if (width === root.clientWidth) return;
      width = root.clientWidth;
      cancel();
      measure();
    });
    resize.observe(root);
    const listeners = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: pointerCancel,
      lostpointercapture: lostCapture, pointerleave: leave, focusin: focusIn, focusout: focusOut, keydown: keyDown, contextmenu: contextMenu };
    for (const [name, handler] of Object.entries(listeners)) root.addEventListener(name, handler);
    root.addEventListener('click', click, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('scroll', pageScroll, { passive: true });
    document.addEventListener('visibilitychange', hidden);
    reduced.addEventListener('change', update);
    return () => {
      resize.disconnect();
      for (const [name, handler] of Object.entries(listeners)) root.removeEventListener(name, handler);
      root.removeEventListener('click', click, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('scroll', pageScroll);
      document.removeEventListener('visibilitychange', hidden);
      reduced.removeEventListener('change', update);
      if (gesture && root.hasPointerCapture(gesture.id)) root.releasePointerCapture(gesture.id);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(activationFrame);
      delete root.dataset.dragging;
      for (const item of items) {
        item.control.removeAttribute('data-preview');
        item.control.style.removeProperty('--dock-scale');
        item.control.style.removeProperty('--dock-lift');
      }
    };
  }, [ref, enabled]);
}
