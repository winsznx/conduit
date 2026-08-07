import { defineConfig } from '@playwright/test';

/**
 * Phase 00 wires the Playwright harness required by PRD 15.5 so the end-to-end
 * gate exists before the first screen does. The suite currently holds only
 * harness self-checks that need no browser. Browser-driven journeys land with
 * apps/web in phase 06; the `use.baseURL` and project list are deliberately
 * absent until a real application is served.
 */
const isCi = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: isCi,
  // Retries hide flakes. A settlement gate that passes on the second attempt
  // has not passed.
  retries: 0,
  workers: isCi ? 1 : '50%',
  reporter: isCi ? [['list'], ['html', { open: 'never' }]] : [['list']],
});
