// Tasks sheet drag. While the handle (or the whole sheet in peek) is dragged, the sheet's top edge follows the
// finger 1:1: pointer moves only store the finger position and one requestAnimationFrame per frame writes the
// height, so React never re-renders during a drag. On release the sheet snaps to the nearest of peek / next / all
// (a fast flick goes one state in its direction) with an ease-out that starts at the finger's speed.
// Every other state change (tap on the handle, keyboard, tapping the peek line) animates the same way.
//
// Height, not transform: the sheet floats above the tab bar with rounded corners at both ends, so it has to grow
// and shrink from its bottom edge. It is absolutely positioned, so a height change only lays out the sheet itself.
//
// DOM attributes set here (never by React, so re-renders leave them alone):
//   data-view = peek | next | all   which content to show, overriding the state class (see adjuster.css)
//   data-free                       height is driven from here: no max-height, no inner scrolling
//   data-scrolled                   the cards are scrolled under the handle
import { useEffect, useLayoutEffect, useRef, type Dispatch, type MouseEvent, type PointerEvent, type RefObject, type SetStateAction, type UIEvent } from 'react';
import type { SheetState } from './sheetState';

const ORDER: SheetState[] = ['peek', 'next', 'all'];
const SLOP = 6; // px of movement before a press becomes a drag (less is a tap)
const FLICK = 0.45; // px/ms; a faster release moves one state in that direction
const PEEK_FALLBACK = 88; // peek height before peek has been measured

type Drag = {
  id: number; y0: number; y: number; onHandle: boolean; active: boolean;
  h0: number; snaps: number[]; hasPeekline: boolean; samples: { t: number; y: number }[]; raf: number;
};

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Past the first or last snap the sheet still moves, but less and less (rubber band), up to `max` px.
const rubber = (over: number, max: number) => max * (1 - Math.exp(-over / (max * 2.5)));

export function useSheetDrag(ref: RefObject<HTMLElement | null>, sheet: SheetState, setSheet: Dispatch<SetStateAction<SheetState>>) {
  const drag = useRef<Drag | null>(null);
  const restH = useRef(0); // sheet height at rest after the latest render
  const peekH = useRef(0); // last measured peek height
  const prev = useRef(sheet);
  const stopSettle = useRef<(() => void) | null>(null);
  const releaseV = useRef<number | null>(null); // finger speed at release (px/ms, + = up) for the next settle
  const swallowUntil = useRef(0); // a drag must not end in a click on what is under the finger

  /** Animate from `from` px to the natural height of the committed state. `v` = finger speed, null for taps. */
  const settle = (from: number, v: number | null) => {
    const el = ref.current;
    if (!el) return;
    stopSettle.current?.();
    stopSettle.current = null;
    const scroll = el.scrollTop; // read while the old content is still laid out
    el.style.transition = 'none';
    el.style.height = '';
    delete el.dataset.view;
    delete el.dataset.free;
    const to = el.offsetHeight; // natural height, capped by the CSS for this state
    if (sheet === 'peek') peekH.current = to;
    const finish = () => {
      stopSettle.current?.();
      stopSettle.current = null;
      el.style.transition = ''; el.style.height = '';
      delete el.dataset.view; delete el.dataset.free;
      restH.current = el.offsetHeight;
    };
    if (reducedMotion() || Math.abs(to - from) < 1) { finish(); return; }
    const shrinking = to < from;
    // Sliding down to 'next': keep the list on screen until it is covered, instead of leaving empty glass.
    if (shrinking && sheet !== 'peek') el.dataset.view = 'all';
    el.dataset.free = '';
    el.style.height = `${from}px`;
    el.scrollTop = scroll;
    if (shrinking && scroll > 0) el.scrollTo({ top: 0, behavior: 'smooth' });
    const dist = Math.abs(to - from);
    const dur = Math.round(Math.min(380, Math.max(240, 200 + dist * 0.25)));
    // Ease-out whose starting slope matches the finger, so the release has no visible kink.
    let curve = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    if (v != null) {
      const slope = (Math.max(0, v * Math.sign(to - from)) * dur) / dist;
      let x1 = 0.25, y1 = slope * x1;
      if (y1 > 1) { y1 = 1; x1 = 1 / slope; }
      curve = `cubic-bezier(${x1.toFixed(3)}, ${y1.toFixed(3)}, 0.2, 1)`;
    }
    void el.offsetHeight; // start from `from`
    el.style.transition = `height ${dur}ms ${curve}`;
    el.style.height = `${to}px`;
    const onEnd = (e: TransitionEvent) => {
      // transitionend bubbles up from the cards: only the sheet's own height counts.
      if (e.target === el && e.propertyName === 'height') finish();
    };
    const timer = window.setTimeout(finish, dur + 150);
    el.addEventListener('transitionend', onEnd);
    stopSettle.current = () => { clearTimeout(timer); el.removeEventListener('transitionend', onEnd); };
  };

  // After every commit: animate a state change from the height the sheet had on screen, else note the rest height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const was = prev.current;
    if (was !== sheet) {
      prev.current = sheet;
      // Leaving 'all' (tap or keyboard): show the list again for one more moment so its scroll position survives.
      if (was === 'all' && !el.dataset.view) el.dataset.view = 'all';
      const from = el.style.height ? el.getBoundingClientRect().height : restH.current;
      const v = releaseV.current;
      releaseV.current = null;
      if (from > 0) settle(from, v);
      else delete el.dataset.view;
      return;
    }
    if (!el.style.height && !drag.current?.active) {
      restH.current = el.offsetHeight;
      if (sheet === 'peek') peekH.current = restH.current;
    }
  });

  useEffect(() => () => {
    stopSettle.current?.();
    if (drag.current?.raf) cancelAnimationFrame(drag.current.raf);
  }, []);

  /** Rest heights of peek, next and all (one forced layout each, once per drag). */
  const measureSnaps = (el: HTMLElement, hasPeekline: boolean): number[] => {
    const keep = { h: el.style.height, view: el.dataset.view, scroll: el.scrollTop };
    el.style.height = '';
    delete el.dataset.free;
    let p = peekH.current || PEEK_FALLBACK;
    if (hasPeekline) { el.dataset.view = 'peek'; p = peekH.current = el.offsetHeight; }
    el.dataset.view = 'next'; const n = el.offsetHeight;
    el.dataset.view = 'all'; const a = el.offsetHeight;
    el.style.height = keep.h;
    if (keep.view) el.dataset.view = keep.view; else delete el.dataset.view;
    el.scrollTop = keep.scroll;
    return [p, n, a];
  };

  const heightFor = (d: Drag) => {
    let h = d.h0 + (d.y0 - d.y);
    const lo = d.snaps[0], hi = Math.max(...d.snaps);
    if (h > hi) h = hi + rubber(h - hi, 56);
    else if (h < lo) h = lo - rubber(lo - h, 28);
    return h;
  };

  const frame = (d: Drag) => {
    d.raf = 0;
    const el = ref.current;
    if (!el || drag.current !== d) return;
    const h = heightFor(d);
    el.style.height = `${h}px`;
    // At the peek height, the peek line; above it, the cards and the list (clipped by the height).
    const view = d.hasPeekline && h <= d.snaps[0] + 8 ? 'peek' : 'all';
    if (el.dataset.view !== view) el.dataset.view = view;
  };

  const begin = (d: Drag, el: HTMLElement) => {
    const cur = el.getBoundingClientRect().height; // mid-animation if a settle is running: catch it there
    stopSettle.current?.();
    stopSettle.current = null;
    el.style.transition = 'none';
    el.style.height = `${cur}px`;
    d.hasPeekline = !!el.querySelector(':scope > .adj-peekline');
    d.snaps = measureSnaps(el, d.hasPeekline);
    d.h0 = cur;
    d.active = true;
    el.dataset.free = '';
    try { el.setPointerCapture(d.id); } catch { /* pointer already gone */ }
  };

  const velocity = (d: Drag, now: number) => {
    const s = d.samples;
    const last = s[s.length - 1];
    if (!last || now - last.t > 90) return 0; // the finger stopped before lifting
    const first = s.find((p) => last.t - p.t <= 100) ?? last;
    return last.t - first.t < 10 ? 0 : (first.y - last.y) / (last.t - first.t);
  };

  const pick = (snaps: number[], h: number, v: number): SheetState => {
    const idx = [0]; // states that add height (no list -> 'all' is as tall as 'next')
    for (let i = 1; i < snaps.length; i++) if (snaps[i] - snaps[idx[idx.length - 1]] > 2) idx.push(i);
    if (v > FLICK) return ORDER[idx.find((i) => snaps[i] > h + 4) ?? idx[idx.length - 1]];
    if (v < -FLICK) return ORDER[[...idx].reverse().find((i) => snaps[i] < h - 4) ?? idx[0]];
    return ORDER[idx.reduce((b, i) => (Math.abs(snaps[i] - h) < Math.abs(snaps[b] - h) ? i : b), idx[0])];
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.active) {
      // A tap on the handle toggles next <-> all (from peek: next). A tap on the peek line is its own click.
      if (d.onHandle && e.type === 'pointerup') setSheet((s) => (s === 'next' ? 'all' : 'next'));
      return;
    }
    swallowUntil.current = performance.now() + 400;
    const el = ref.current;
    const h = heightFor(d);
    if (el) el.style.height = `${h}px`;
    const v = e.type === 'pointerup' ? velocity(d, e.timeStamp) : 0;
    const target = pick(d.snaps, h, v);
    if (target === sheet) settle(h, v);
    else { releaseV.current = v; setSheet(target); }
  };

  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const onHandle = !!(e.target as Element).closest('.adj-handle');
      if (!onHandle && sheet !== 'peek') return; // open sheet: only the handle drags, the rest scrolls
      swallowUntil.current = 0;
      drag.current = { id: e.pointerId, y0: e.clientY, y: e.clientY, onHandle, active: false, h0: 0, snaps: [], hasPeekline: false, samples: [{ t: e.timeStamp, y: e.clientY }], raf: 0 };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      d.y = e.clientY;
      d.samples.push({ t: e.timeStamp, y: d.y });
      if (d.samples.length > 12) d.samples.shift();
      if (!d.active) {
        if (Math.abs(d.y - d.y0) < SLOP || !ref.current) return;
        begin(d, ref.current);
      }
      if (!d.raf) d.raf = requestAnimationFrame(() => frame(d));
    },
    onPointerUp: end,
    onPointerCancel: end,
    onScroll: (e: UIEvent<HTMLElement>) => {
      const el = e.currentTarget, on = el.scrollTop > 1;
      if (on !== ('scrolled' in el.dataset)) el.toggleAttribute('data-scrolled', on); // frosted handle band (CSS)
    },
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (performance.now() < swallowUntil.current) { e.stopPropagation(); e.preventDefault(); swallowUntil.current = 0; }
    },
  };
}
