#!/usr/bin/env node
/**
 * Drives the official Circle faucet UI to fund the Cleanverse deposit address.
 * ASM-035, phase 01.
 *
 * The Cleanverse team's documented workaround for obtaining aUSDC on Monad is:
 * get the deposit address from the API, send test USDC to it from the Circle
 * faucet, and Cleanverse credits aUSDC to the depositor. That last step is why
 * the sender matters, and it explains the earlier failure — sending from our own
 * wallet was classified `non_whitelist_transfer` and refunded ~40 blocks later,
 * while `query_institution_white_list` for Monad lists a `usdc_faucet` service.
 * The faucet is a whitelisted origin; we are not.
 *
 * This automates the official UI rather than calling anything private. Circle's
 * faucet is reCAPTCHA-protected, and if the challenge is interactive that is a
 * genuine human gate rather than something to work around — the script reports
 * exactly where it stopped and takes a screenshot, so the next step is a
 * decision rather than a guess.
 *
 *   node scripts/circle-faucet.mjs <recipient-address>
 *   HEADFUL=1 node scripts/circle-faucet.mjs <address>   # watch it
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { ROOT } from './lib/run.mjs';

const recipient = process.argv[2];
if (recipient === undefined || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
  console.error('usage: node scripts/circle-faucet.mjs <recipient-address>');
  process.exit(1);
}

const OUT = join(ROOT, 'docs', 'evidence', 'artifacts');
mkdirSync(OUT, { recursive: true });

const steps = [];
const record = (step, detail) => {
  steps.push({ step, detail, at: new Date().toISOString() });
  console.log(`  ${step}${detail === undefined ? '' : `: ${detail}`}`);
};

const browser = await chromium.launch({ headless: process.env['HEADFUL'] !== '1' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

let outcome = 'UNKNOWN';
let blockedBy = null;

try {
  console.log('Circle faucet, official UI');
  await page.goto('https://faucet.circle.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  record('loaded', page.url());

  // Wait for the form itself rather than a fixed sleep. The submit button's
  // label carries the amount, so its presence means the form has hydrated.
  const submit = page.getByRole('button', { name: /^send \d+ usdc$/i }).first();
  await submit.waitFor({ state: 'visible', timeout: 45_000 });
  record('form ready', await submit.innerText());

  /**
   * Consent first, and before touching anything else.
   *
   * The banner is a modal overlay that dims the page and swallows pointer
   * events. Leaving it up made the first run read the FAQ's "Limit: one request
   * per pairing" as a refusal, and the second time out clicking submit. It
   * mounts a second or two after the form, so this waits for it rather than
   * probing once and moving on.
   */
  const consent = page
    .locator('#onetrust-accept-btn-handler')
    .or(page.getByRole('button', { name: /accept cookies/i }))
    .first();
  if (
    await consent.waitFor({ state: 'visible', timeout: 20_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await consent.click({ timeout: 10_000 });
    await consent.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    record('dismissed the consent banner');
  } else {
    record('no consent banner appeared');
  }

  // The network control sits under the "Network" label; the address field under
  // "Send to". Anchoring on the visible labels means a redesign fails loudly
  // here rather than quietly selecting the wrong chain.
  /**
   * A Downshift combobox, not a `<select>`.
   *
   * Two things about it broke naive automation. The full option list is in the
   * DOM whether the menu is open or shut, so a text match finds "Monad Testnet"
   * and then times out clicking it — the class is `max-menu-items-6` and Monad
   * is item 16, present but scrolled out of view. And leaving the default in
   * place is worse than failing: a run that quietly funded Arc Testnet would
   * report success and deliver nothing to Monad.
   *
   * So: open the menu, scroll the option into view, click it, and assert the
   * trigger afterwards reads back what was asked for.
   */
  const trigger = page.locator('.cb-input').first();
  await trigger.click({ timeout: 20_000 });
  await page.waitForTimeout(1_500);

  const monad = page
    .locator('[role=listbox] [role=option]')
    .filter({ hasText: /^Monad Testnet$/ })
    .first();
  await monad.scrollIntoViewIfNeeded({ timeout: 20_000 });
  await monad.click({ timeout: 20_000 });
  await page.waitForTimeout(1_500);

  const selected = (await trigger.innerText().catch(() => '')).trim();
  if (!/monad/i.test(selected)) {
    throw new Error(`network reads "${selected}", expected Monad Testnet`);
  }
  record('selected', selected.replace(/\n/g, ' '));

  const addressField = page.getByRole('textbox').first();
  await addressField.fill(recipient, { timeout: 20_000 });
  record('entered the deposit address', recipient);

  await page.screenshot({ path: join(OUT, 'circle-faucet-filled.png'), fullPage: true });

  /**
   * The consent banner is a modal overlay: it dims the page and swallows pointer
   * events, so a click on the submit button lands on the consent layer instead.
   * The first run read that as a refusal and the second timed out on the click.
   * Dismissed here, immediately before submitting, because it mounts late.
   */
  for (const candidate of [
    page.locator('#onetrust-accept-btn-handler'),
    page.getByRole('button', { name: /accept cookies/i }),
    page.getByRole('button', { name: /^accept/i }),
  ]) {
    if (
      await candidate
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await candidate
        .first()
        .click({ timeout: 10_000 })
        .catch(() => {});
      record('dismissed the consent banner');
      await page.waitForTimeout(2_000);
      break;
    }
  }

  // Anything that gates on a human is the end of the automated path. Reporting
  // that precisely is the useful outcome; defeating it is not something to try.
  const captchaFrame = page
    .frameLocator('iframe[title*="reCAPTCHA" i]')
    .locator('#recaptcha-anchor');
  const hasInteractiveCaptcha = await captchaFrame.isVisible().catch(() => false);

  const googleSignIn = page.getByText(/sign in with google|continue with google/i).first();
  const needsGoogle = await googleSignIn.isVisible().catch(() => false);

  if (needsGoogle) {
    outcome = 'BLOCKED';
    blockedBy = 'Google sign-in';
    record('blocked', 'the faucet requires a Google account');
  } else if (hasInteractiveCaptcha) {
    outcome = 'BLOCKED';
    blockedBy = 'interactive reCAPTCHA';
    record('blocked', 'an interactive reCAPTCHA checkbox is present');
  } else {
    if (await submit.isVisible().catch(() => false)) {
      // Captured before the click so the comparison afterwards is against what
      // the page actually said, not against the FAQ. The first run classified
      // the boilerplate "Limit: One request per pairing…" as a refusal and
      // reported a failure that had not happened.
      const before = await page
        .locator('body')
        .innerText()
        .catch(() => '');

      await submit.click({ timeout: 15_000 });
      record('clicked', await submit.innerText().catch(() => 'send'));
      await page.waitForTimeout(20_000);

      const after = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const appeared = after
        .split('\n')
        .filter((line) => line.trim().length > 0 && !before.includes(line))
        .join('\n');
      writeFileSync(
        join(OUT, 'circle-faucet-result.txt'),
        appeared.slice(0, 4_000) || after.slice(0, 4_000),
      );
      record('page changed by', `${appeared.split('\n').length} lines`);

      if (/0x[0-9a-fA-F]{64}|success|sent|complete/i.test(appeared)) outcome = 'SENT';
      else if (/not a bot|unusual traffic|verify that you are/i.test(appeared)) {
        // The end of the automated path, and it is the honest one. Circle scores
        // the session and refuses it; defeating that check is not something to
        // attempt, so this is reported as the human gate it is rather than as an
        // unclassified failure.
        outcome = 'CAPTCHA_BLOCKED';
        blockedBy = 'Circle reCAPTCHA rejected the automated session, headless and headed alike';
      } else if (/limit exceeded|too many|rate limit|try again later/i.test(appeared))
        outcome = 'RATE_LIMITED';
      else if (/error|failed|invalid/i.test(appeared)) outcome = 'REFUSED';
      else outcome = 'UNKNOWN';
      record('result', outcome);
      if (appeared.trim().length > 0)
        console.log(`  page said: ${appeared.slice(0, 300).replace(/\n/g, ' | ')}`);
    } else {
      outcome = 'BLOCKED';
      blockedBy = 'no submit control found';
      record('blocked', 'no submit control found');
    }
  }

  await page.screenshot({ path: join(OUT, 'circle-faucet-final.png'), fullPage: true });
} catch (error) {
  outcome = 'ERROR';
  blockedBy = error instanceof Error ? error.message.split('\n')[0] : String(error);
  record('error', blockedBy);
  await page
    .screenshot({ path: join(OUT, 'circle-faucet-error.png'), fullPage: true })
    .catch(() => {});
} finally {
  await browser.close();
}

const evidence = {
  capturedAt: new Date().toISOString(),
  faucet: 'https://faucet.circle.com/',
  automation: 'Playwright chromium against the official UI. No private Circle API is called.',
  recipient,
  outcome,
  blockedBy,
  steps,
  screenshots: ['circle-faucet-filled.png', 'circle-faucet-final.png'],
};

const path = join(ROOT, 'docs', 'evidence', 'phase-01-circle-faucet.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\noutcome ${outcome}${blockedBy === null ? '' : ` (${blockedBy})`}`);
console.log(`written ${path}`);
process.exitCode = outcome === 'SENT' ? 0 : 1;
