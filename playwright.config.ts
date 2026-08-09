import { defineConfig } from '@playwright/test';

/**
 * Phase 00 wired the Playwright harness required by PRD 15.5 so the end-to-end
 * gate existed before the first screen did. The `harness` project still holds
 * the self-checks that need no browser.
 *
 * The `web-visual` project is the design gate `design.md` requires: every
 * surface rendered at four viewports, audited for token drift, and captured.
 * It needs the console already running on `WEB_BASE_URL` (default
 * `http://localhost:8787`, which is `pnpm --filter @conduit-protocol/app-web
 * dev`), because starting it here would hide a bundling failure behind a
 * timeout.
 */
const isCi = process.env['CI'] !== undefined;
const webBaseUrl = process.env['WEB_BASE_URL'] ?? 'http://localhost:8787';

export default defineConfig({
  fullyParallel: true,
  forbidOnly: isCi,
  // Retries hide flakes. A settlement gate that passes on the second attempt
  // has not passed.
  retries: 0,
  workers: isCi ? 1 : '50%',
  reporter: isCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
  projects: [
    { name: 'harness', testDir: 'e2e' },
    {
      name: 'web-visual',
      testDir: 'apps/web/qa',
      use: { baseURL: webBaseUrl },
    },
  ],
});
