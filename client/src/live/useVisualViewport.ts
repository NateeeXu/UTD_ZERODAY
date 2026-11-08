// Keeps a full-screen chat page inside the part of the screen the phone keyboard leaves visible.
// iOS Safari keeps the layout viewport (and 100dvh) at full height when the keyboard opens and pans the page
// instead: the header slides off the top, and after Send or Done the page can stay scrolled, with the composer
// left mid-screen over a blank band. This writes the visual viewport's height and top to --vv-h / --vv-top on the
// element (its CSS pins it there with position: fixed), sets data-kb while the keyboard is up, and scrolls the
// window back to the top once the text box loses focus or the keyboard closes.
import { useLayoutEffect, type RefObject } from 'react';

const editable = (el: Element | null) =>
  !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable);

/** Undo the scroll iOS can leave behind after the keyboard closes. */
export function resetPageScroll() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}

export function useVisualViewport(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !vv) return; // CSS falls back to the full screen
    let timer = 0;
    const apply = () => {
      if (vv.scale > 1.01) { // pinch zoom, not the keyboard: keep the normal size
        el.style.removeProperty('--vv-h');
        el.style.removeProperty('--vv-top');
        delete el.dataset.kb;
        return;
      }
      el.style.setProperty('--vv-h', `${vv.height}px`);
      el.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      if (document.documentElement.clientHeight - vv.height > 120) el.dataset.kb = '';
      else {
        delete el.dataset.kb;
        resetPageScroll();
      }
    };
    // Send, Done or a tap outside: once nothing editable has focus, put the page back at the top.
    const onFocusOut = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!editable(document.activeElement)) resetPageScroll();
        apply();
      }, 60);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      clearTimeout(timer);
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      el.removeEventListener('focusout', onFocusOut);
      resetPageScroll();
    };
  }, [ref]);
}
