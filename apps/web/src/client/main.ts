/**
 * The browser entry point.
 *
 * Conduit's pages are server-rendered and readable with no JavaScript at all —
 * the verifier and every public proof page must stay that way, because a proof
 * that requires a bundle to load is a weaker proof. This script adds only the
 * things that genuinely need a wallet, and attaches to markers the server put in
 * the HTML rather than rebuilding any of it.
 *
 * ## Boot order matters
 *
 * The session starts first and everything else subscribes to it. Views used to
 * discover wallets and restore accounts for themselves, which meant a page with
 * two of them did the work twice and could disagree with itself in between.
 *
 * If this file fails to load, the product degrades to exactly what it was
 * before: a complete, honest, read-only console.
 */

import { mountActivity } from './activity.js';
import { mountComposer, mountSignRequest } from './composer.js';
import { mountLanding } from './landing.js';
import { mountOnboarding } from './onboarding.js';
import { mountOverview } from './overview.js';
import { session } from './session.js';
import { mountParticipantControl } from './wallet-ui.js';
import { mountWorkspace } from './workspace.js';
import type { Deployment } from './protocol.js';

/** The deployment the server rendered onto the body, for the whole session. */
function deployment(): Deployment | undefined {
  const raw = document.body.dataset['conduit'];
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as Deployment;
  } catch {
    return undefined;
  }
}

function start(): void {
  mountParticipantControl();
  mountLanding();
  mountActivity();
  mountOnboarding();
  mountOverview();
  mountComposer();
  mountSignRequest();
  mountWorkspace();

  // Discovery and silent restore, once, for every route. `eth_accounts` never
  // prompts — it reports an authorisation a previous visit already gave.
  void session.boot(deployment());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
