'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const navigationKeys = new Set(['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function RemoteViewport({ enabled, send, children }: { enabled: boolean; send: (command: object) => void; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !enabled) return;
    let pointer: number | undefined;
    let animation = 0;
    let move: { x: number; y: number } | undefined;
    let wheel: { x: number; y: number; deltaX: number; deltaY: number } | undefined;
    const contentRect = () => {
      const rect = element.getBoundingClientRect();
      const scale = Math.min(rect.width / 1280, rect.height / 720);
      const width = 1280 * scale, height = 720 * scale;
      return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
    };
    const inside = (event: MouseEvent) => { const r = contentRect(); return event.clientX >= r.left && event.clientX <= r.left + r.width && event.clientY >= r.top && event.clientY <= r.top + r.height; };
    const position = (event: MouseEvent) => {
      const rect = contentRect();
      return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
    };
    const flush = () => {
      cancelAnimationFrame(animation); animation = 0;
      if (move) { send({ type: 'mouse', action: 'move', ...move }); move = undefined; }
      if (wheel) { send({ type: 'wheel', ...wheel }); wheel = undefined; }
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(flush); };
    const release = () => {
      cancelAnimationFrame(animation); animation = 0; move = undefined; wheel = undefined;
      const captured = pointer; pointer = undefined;
      send({ type: 'release' });
      if (captured !== undefined && element.hasPointerCapture(captured)) element.releasePointerCapture(captured);
    };
    const onWheel = (event: WheelEvent) => {
      // Browser zoom is local, not a remote scroll gesture.
      if (event.ctrlKey || event.metaKey || !inside(event)) return;
      event.preventDefault();
      const rect = contentRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      wheel = { ...position(event),
        deltaX: clamp((wheel?.deltaX ?? 0) + event.deltaX * unit * 1280 / rect.width, -4000, 4000),
        deltaY: clamp((wheel?.deltaY ?? 0) + event.deltaY * unit * 720 / rect.height, -4000, 4000),
      };
      schedule();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !inside(event)) return;
      event.preventDefault(); flush();
      element.focus({ preventScroll: true });
      pointer = event.pointerId;
      element.setPointerCapture(pointer);
      send({ type: 'mouse', action: 'down', ...position(event) });
    };
    const moving = (event: PointerEvent) => {
      if (!event.isPrimary || pointer !== undefined && event.pointerId !== pointer || pointer === undefined && !inside(event)) return;
      move = position(event); schedule();
    };
    const up = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      event.preventDefault(); flush();
      send({ type: 'mouse', action: 'up', ...position(event) });
      const captured = pointer; pointer = undefined;
      if (element.hasPointerCapture(captured)) element.releasePointerCapture(captured);
    };
    const lost = () => { if (pointer !== undefined) release(); };
    const visibility = () => { if (document.hidden) release(); };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', moving);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', lost);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      release();
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', moving);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', release);
      element.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled, send]);

  return <div ref={viewport} className="browser-viewport" tabIndex={0} role="application" aria-label="Trình duyệt điều khiển từ xa" aria-disabled={!enabled}
    onKeyDown={event => {
      if (!enabled || event.ctrlKey || event.metaKey || event.altKey) return;
      if (navigationKeys.has(event.key)) {
        event.preventDefault(); send({ type: 'key', key: event.key, shift: event.shiftKey });
      } else if (event.key.length === 1) {
        event.preventDefault(); send({ type: 'text', text: event.key });
      }
    }}>{children}</div>;
}
