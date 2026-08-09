/**
 * The browser entry point.
 *
 * Conduit's pages are server-rendered and readable with no JavaScript at all —
 * the verifier and every public proof page must stay that way, because a proof
 * that requires a bundle to load is a weaker proof. This script adds only the
 * things that genuinely need a wallet, and attaches to markers the server put
 * in the HTML rather than rebuilding any of it.
 *
 * If this file fails to load, the product degrades to exactly what it was
 * before: a complete, honest, read-only console.
 */

import { mountWalletControls } from './wallet-ui.js';
import { wallet } from './wallet.js';

function start(): void {
  mountWalletControls();
  // Silent reconnect. Never prompts — it only asks whether this site is still
  // authorised from a previous visit.
  void wallet.restore();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
