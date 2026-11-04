/**
 * The terminal's end-of-scroll feel for ordinary scrolling areas (the home screen): pulled past
 * the top or the bottom, the content follows the finger a little — harder the further it goes —
 * and springs back when let go; a fling that runs into an end bounces gently.
 *
 * Uses the CSS `translate` property (not `transform`, which screen transitions animate); older
 * WebViews without it simply don't stretch.
 */
const canStretch = typeof CSS !== 'undefined' && !!CSS.supports?.('translate', '0 1px');

export function attachRubberBand(el: HTMLElement, animate: () => boolean) {
  if (!canStretch) return;
  let stretch = 0;
  let lastY = 0;
  let touching = false;
  let anim: Animation | null = null;
  // a fling's speed when it reaches an end (px/ms, from the scroll positions)
  let lastTop = el.scrollTop;
  let lastT = performance.now();
  let speed = 0;

  // only while this element really scrolls (the home screen's layout differs by orientation:
  // a column in one is `display: contents` in the other)
  let active = false;
  const isScroller = () => {
    const cs = getComputedStyle(el);
    return cs.display !== 'contents' && (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
  };
  const max = () => Math.max(40, el.clientHeight * 0.12);
  const atTop = () => el.scrollTop <= 0;
  const atBottom = () => el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
  const set = (px: number) => {
    stretch = px;
    anim?.cancel();
    anim = null;
    el.style.translate = px ? `0 ${px.toFixed(1)}px` : '';
  };
  const release = () => {
    const from = stretch;
    if (!from) return;
    set(0);
    if (!animate()) return;
    anim = el.animate([{ translate: `0 ${from.toFixed(1)}px` }, { translate: '0 0' }], {
      duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  };
  const bounce = (v: number) => {
    if (!animate() || touching || stretch) return;
    const lim = max() * 0.45;
    const amp = Math.max(-lim, Math.min(lim, v * 14));
    if (Math.abs(amp) < 4) return;
    anim?.cancel();
    anim = el.animate(
      [{ translate: '0 0' }, { translate: `0 ${amp.toFixed(1)}px`, offset: 0.28 }, { translate: '0 0' }],
      { duration: 460, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)' },
    );
  };

  el.addEventListener('touchstart', (e) => {
    touching = true;
    active = isScroller();
    lastY = e.touches[0].clientY;
    if (stretch) set(stretch); // (stops a spring-back in progress where it is)
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!active) return;
    if (e.touches.length !== 1) {
      lastY = e.touches[0].clientY; // (two fingers: none of it stretches, nothing jumps after)
      return;
    }
    const y = e.touches[0].clientY;
    const dy = y - lastY;
    lastY = y;
    if (stretch && Math.sign(dy) !== Math.sign(stretch)) {
      // pulling back: the stretch goes first
      const next = Math.abs(dy) >= Math.abs(stretch) ? 0 : stretch + dy;
      set(next);
      return;
    }
    // finger down at the top, or up at the bottom: past the end
    if ((dy > 0 && atTop()) || (dy < 0 && atBottom())) {
      const m = max();
      set(Math.max(-m, Math.min(m, stretch + dy * 0.55 * (1 - Math.abs(stretch) / m))));
    }
  }, { passive: true });
  const end = (e: TouchEvent) => {
    if (e.touches.length) {
      lastY = e.touches[0].clientY; // one finger of two lifted: the other one goes on from here
      return;
    }
    touching = false;
    release();
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  el.addEventListener('scroll', () => {
    const now = performance.now();
    const top = el.scrollTop;
    const dt = Math.max(1, now - lastT);
    // scrolling towards the top is a pull down (positive), like the finger's direction
    speed = 0.6 * ((lastTop - top) / dt) + 0.4 * speed;
    lastTop = top;
    lastT = now;
    // a fling (no finger on the screen) just reached an end
    if (!touching && (atTop() || atBottom()) && Math.abs(speed) > 0.4 && isScroller()) {
      bounce(speed);
      speed = 0;
    }
  }, { passive: true });
}
