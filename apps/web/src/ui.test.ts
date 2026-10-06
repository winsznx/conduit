import { describe, expect, it } from 'vitest';

import { emptyState, errorState } from './ui.js';

describe.each([
  ['emptyState', (level?: 1 | 2) => emptyState('Nothing here', 'Detail.', '', level)],
  ['errorState', (level?: 1 | 2) => errorState('Broken', 'Detail.', level)],
])('%s', (_name, render) => {
  it('titles the panel with a div by default, because a page heading sits above it', () => {
    // #given a panel with no heading level
    // #when it is rendered
    const html = render();

    // #then the title is a div
    expect(html).toMatch(/<div class="empty-title">/);
  });

  it('writes no heading by default', () => {
    // #given a panel with no heading level
    // #when it is rendered
    const html = render();

    // #then no heading element appears
    expect(html).not.toMatch(/<h[1-6]\b/);
  });

  it('titles the panel with an h1 when asked for level 1', () => {
    // #given a panel that is the whole page
    // #when it is rendered with a level of 1
    const html = render(1);

    // #then the title is an h1 with the same class
    expect(html).toMatch(/<h1 class="empty-title">[^<]+<\/h1>/);
  });

  it('titles the panel with an h2 when asked for level 2', () => {
    // #given a panel under a page heading
    // #when it is rendered with a level of 2
    const html = render(2);

    // #then the title is an h2
    expect(html).toMatch(/<h2 class="empty-title">/);
  });
});
