/**
 * Keeps the focused sidebar link in view.
 *
 * Under 1024px the sidebar is a strip that scrolls sideways. Chromium scrolls a focused
 * element into view only when it is fully hidden, so Tab can land on a link with a few
 * pixels showing and the focus ring clipped. Scrolling it in by the nearest edge fixes
 * that, and does nothing for a link that is already visible, which is every link when the
 * sidebar is the vertical column on a desktop.
 */

export function mountSidebar(): void {
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  if (sidebar === null) return;

  sidebar.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    event.target.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });
}
