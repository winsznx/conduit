/**
 * The landing page's scroll behaviour, which exists to explain state.
 *
 * Three things, and each answers "what changed in the protocol?" rather than
 * "can this site animate?":
 *
 *   sections settle in as they are reached, so the page has a reading rhythm;
 *   the mechanism's centre datum advances through the five protocol states as
 *     the stages scroll past the two chain modules, which stay still — that
 *     stillness is the claim the section is making;
 *   the message rail reveals one authenticated message at a time.
 *
 * ## Progressive enhancement, and why the default is visible
 *
 * `data-motion` is set on the document only once this file runs. Every reveal
 * rule is scoped under it, so a page with no JavaScript, a blocked bundle or a
 * failed parse renders fully visible rather than a column of blank sections.
 * Hiding content behind an observer that may never run is the failure mode this
 * ordering exists to prevent.
 *
 * `prefers-reduced-motion` is handled in the stylesheet, which is the right
 * place: it should hold even if this file is mid-flight. This file still runs
 * under it — the state progression is information, not decoration, and a reader
 * who asked for less motion still gets the mechanism, just without transitions.
 */

const REVEAL = '[data-motion] .reveal, .msg, .staterail-row';

/** One observer, reused. Elements are unobserved once shown; nothing re-hides. */
function revealOnce(): void {
  const targets = [...document.querySelectorAll<HTMLElement>(REVEAL)];
  if (targets.length === 0) return;

  if (!('IntersectionObserver' in window)) {
    for (const target of targets) target.dataset['shown'] = '';
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        target.dataset['shown'] = '';
        observer.unobserve(target);
      }
    },
    // Slightly inside the viewport, so a section is already settled by the time
    // it is comfortably readable rather than animating under the reader's eye.
    { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
  );

  for (const target of targets) observer.observe(target);
}

/**
 * The message rail, one message at a time.
 *
 * Staggered by index rather than by a timer chain, so a reader who scrolls
 * quickly past sees them all rather than waiting out a queue.
 */
function stagger(): void {
  const messages = [...document.querySelectorAll<HTMLElement>('.msg')];
  messages.forEach((message, index) => {
    message.style.transitionDelay = `${String(Math.min(index, 8) * 70)}ms`;
  });
}

/**
 * The mechanism: the centre datum follows whichever stage the reader is at.
 *
 * The stage nearest the middle of the viewport is the current one. Reading
 * position, not entry order — scrolling back up has to walk the states
 * backwards, and an observer that only ever advanced would lie about that.
 */
function mechanism(): void {
  const root = document.querySelector<HTMLElement>('[data-mech]');
  if (root === null) return;

  const steps = [...root.querySelectorAll<HTMLElement>('[data-mech-step]')];
  const state = root.querySelector<HTMLElement>('[data-mech-state]');
  const cash = root.querySelector<HTMLElement>('[data-mech-cash]');
  const asset = root.querySelector<HTMLElement>('[data-mech-asset]');
  if (steps.length === 0 || state === null || cash === null || asset === null) return;

  let current: HTMLElement | undefined;

  const apply = (step: HTMLElement): void => {
    if (step === current) return;
    current = step;
    for (const other of steps) delete other.dataset['current'];
    step.dataset['current'] = '';
    state.textContent = step.dataset['state'] ?? '';
    cash.textContent = step.dataset['cash'] ?? '';
    asset.textContent = step.dataset['asset'] ?? '';
  };

  let queued = false;
  const pick = (): void => {
    queued = false;
    const middle = window.innerHeight / 2;
    let best: HTMLElement | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const step of steps) {
      const box = step.getBoundingClientRect();
      const distance = Math.abs((box.top + box.bottom) / 2 - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = step;
      }
    }
    if (best !== undefined) apply(best);
  };

  const onScroll = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(pick);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  pick();
}

export function mountLanding(): void {
  if (document.querySelector('.landing') === null) return;

  // Only now: everything above degrades to fully visible without it.
  document.documentElement.dataset['motion'] = '';

  stagger();
  revealOnce();
  mechanism();
}
