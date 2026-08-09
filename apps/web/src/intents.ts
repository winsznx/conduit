/**
 * Storing a signed intent, so a counterparty can find it.
 *
 * A bilateral settlement needs two signatures from two keys that are almost
 * never in the same browser. This is the coordination layer that lets the
 * second party open the same settlement from their own machine.
 *
 * ## It authorises nothing
 *
 * CLAUDE.md: application database state never authorizes value movement. The
 * coordinator verifies both signatures against the digest on chain, and if this
 * table disagreed with it the table would be wrong. What is stored here is a
 * convenience for finding a settlement, not a claim about one.
 *
 * That said, it is still validated before it is written. Recomputing the
 * settlement id from the submitted terms and recovering the signer means the
 * store cannot be filled with intents nobody signed, or with an id that does
 * not match its own contents — neither of which would fool the chain, but both
 * of which would waste a counterparty's time and pollute a public projection.
 */

import { createSettlementIntent, SETTLEMENT_INTENT_TYPE } from '@conduit-protocol/domain';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';

import { withDb, type Env } from './data.js';
import { deploymentConfig, MONAD_TESTNET } from './deployment.js';
import { DOMAIN_NAME, DOMAIN_VERSION } from '@conduit-protocol/domain';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

interface Submission {
  readonly intent: Record<string, string>;
  readonly signer: string;
  readonly signature: string;
}

const TERM_KEYS = [
  'version',
  'cashChainId',
  'cashEscrow',
  'cashAsset',
  'cashAmount',
  'cashPayer',
  'cashReceiver',
  'assetChainId',
  'assetEscrow',
  'assetToken',
  'assetAmount',
  'assetSeller',
  'assetReceiver',
  'cashPolicyHash',
  'assetPolicyHash',
  'prepareDeadline',
  'commitDeadline',
  'releaseDeadline',
  'nonce',
] as const;

export interface StoreResult {
  readonly status: number;
  readonly body: unknown;
}

export async function storeSignedIntent(env: Env, submission: unknown): Promise<StoreResult> {
  const config = deploymentConfig(env);
  if (config === undefined) {
    return { status: 503, body: { error: { code: 'not_configured', message: 'no deployment' } } };
  }

  const parsed = submission as Partial<Submission>;
  if (
    parsed.intent === undefined ||
    typeof parsed.signer !== 'string' ||
    typeof parsed.signature !== 'string' ||
    !ADDRESS.test(parsed.signer) ||
    !/^0x[0-9a-fA-F]+$/.test(parsed.signature)
  ) {
    return { status: 400, body: { error: { code: 'invalid_request', message: 'malformed body' } } };
  }

  for (const key of TERM_KEYS) {
    if (parsed.intent[key] === undefined) {
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: `missing term: ${key}` } },
      };
    }
  }

  // Rebuild the terms in their real types, then re-derive the id. A submitted
  // `settlementId` is never trusted — it is recomputed and compared.
  const terms = {
    version: Number(parsed.intent['version']),
    cashChainId: BigInt(parsed.intent['cashChainId'] ?? '0'),
    cashEscrow: parsed.intent['cashEscrow'] as Hex,
    cashAsset: parsed.intent['cashAsset'] as Hex,
    cashAmount: BigInt(parsed.intent['cashAmount'] ?? '0'),
    cashPayer: parsed.intent['cashPayer'] as Hex,
    cashReceiver: parsed.intent['cashReceiver'] as Hex,
    assetChainId: BigInt(parsed.intent['assetChainId'] ?? '0'),
    assetEscrow: parsed.intent['assetEscrow'] as Hex,
    assetToken: parsed.intent['assetToken'] as Hex,
    assetAmount: BigInt(parsed.intent['assetAmount'] ?? '0'),
    assetSeller: parsed.intent['assetSeller'] as Hex,
    assetReceiver: parsed.intent['assetReceiver'] as Hex,
    cashPolicyHash: parsed.intent['cashPolicyHash'] as Hex,
    assetPolicyHash: parsed.intent['assetPolicyHash'] as Hex,
    prepareDeadline: BigInt(parsed.intent['prepareDeadline'] ?? '0'),
    commitDeadline: BigInt(parsed.intent['commitDeadline'] ?? '0'),
    releaseDeadline: BigInt(parsed.intent['releaseDeadline'] ?? '0'),
    nonce: BigInt(parsed.intent['nonce'] ?? '0'),
  };

  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: BigInt(MONAD_TESTNET),
    verifyingContract: config.coordinator,
  };
  const intent = createSettlementIntent(terms, domain);

  const claimed = parsed.intent['settlementId'];
  if (claimed !== undefined && claimed.toLowerCase() !== intent.settlementId.toLowerCase()) {
    return {
      status: 400,
      body: {
        error: {
          code: 'id_mismatch',
          message: 'the settlement id does not match the terms it claims to identify',
        },
      },
    };
  }

  // The signature must actually be over this digest, by the address claiming it.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: MONAD_TESTNET,
        verifyingContract: config.coordinator,
      },
      types: SETTLEMENT_INTENT_TYPE,
      primaryType: 'SettlementIntent',
      message: intent,
      signature: parsed.signature as Hex,
    });
  } catch {
    return {
      status: 400,
      body: { error: { code: 'bad_signature', message: 'the signature could not be recovered' } },
    };
  }

  if (recovered.toLowerCase() !== parsed.signer.toLowerCase()) {
    return {
      status: 400,
      body: {
        error: {
          code: 'signer_mismatch',
          message: 'the signature does not belong to the address that submitted it',
        },
      },
    };
  }

  // Only the two parties the terms name can sign for this settlement.
  const isPayer = recovered.toLowerCase() === intent.cashPayer.toLowerCase();
  const isSeller = recovered.toLowerCase() === intent.assetSeller.toLowerCase();
  if (!isPayer && !isSeller) {
    return {
      status: 403,
      body: {
        error: {
          code: 'not_a_party',
          message: 'this address is neither the payer nor the seller in these terms',
        },
      },
    };
  }

  const id = intent.settlementId.toLowerCase();
  if (!HEX32.test(id)) {
    return { status: 400, body: { error: { code: 'invalid_request', message: 'bad id' } } };
  }

  // `undefined` is not a SQL parameter; the absent signature must be an
  // explicit null so the upsert's COALESCE keeps whatever is already stored.
  const payerSignature: string | null = isPayer ? parsed.signature : null;
  const sellerSignature: string | null = isSeller ? parsed.signature : null;

  await withDb(env, async (sql) => {
    await sql`
      INSERT INTO conduit.intents (
        intent_hash, version, cash_chain_id, cash_escrow, cash_asset, cash_amount,
        cash_payer, cash_receiver, asset_chain_id, asset_escrow, asset_token,
        asset_amount, asset_seller, asset_receiver, cash_policy_hash, asset_policy_hash,
        prepare_deadline, commit_deadline, release_deadline, nonce, terms_source,
        buyer_signature, seller_signature
      ) VALUES (
        ${id}, ${terms.version}, ${terms.cashChainId.toString()},
        ${terms.cashEscrow.toLowerCase()}, ${terms.cashAsset.toLowerCase()},
        ${terms.cashAmount.toString()}, ${terms.cashPayer.toLowerCase()},
        ${terms.cashReceiver.toLowerCase()}, ${terms.assetChainId.toString()},
        ${terms.assetEscrow.toLowerCase()}, ${terms.assetToken.toLowerCase()},
        ${terms.assetAmount.toString()}, ${terms.assetSeller.toLowerCase()},
        ${terms.assetReceiver.toLowerCase()}, ${terms.cashPolicyHash},
        ${terms.assetPolicyHash}, ${terms.prepareDeadline.toString()},
        ${terms.commitDeadline.toString()}, ${terms.releaseDeadline.toString()},
        ${terms.nonce.toString()}, 'signed',
        ${payerSignature}, ${sellerSignature}
      )
      ON CONFLICT (intent_hash) DO UPDATE SET
        buyer_signature  = COALESCE(EXCLUDED.buyer_signature,  conduit.intents.buyer_signature),
        seller_signature = COALESCE(EXCLUDED.seller_signature, conduit.intents.seller_signature),
        terms_source     = 'signed'
    `;
  });

  return {
    status: 200,
    body: {
      settlementId: intent.settlementId,
      signer: recovered,
      role: isPayer ? 'payer' : 'seller',
      signingUrl: `/app/settlements/${intent.settlementId}/sign`,
    },
  };
}

export interface WorkspaceIntent {
  readonly terms: Record<string, string>;
  readonly payerSigned: boolean;
  readonly sellerSigned: boolean;
  readonly payerSignature: string | undefined;
  readonly sellerSignature: string | undefined;
  readonly termsSource: string;
}

/**
 * The terms a workspace acts on, whatever produced them.
 *
 * `signRequest` deliberately serves only intents a party signed, because
 * offering a reconstructed one for countersignature would invite somebody to
 * agree to terms the first party never proposed. The workspace has the opposite
 * need: a settlement recovered from a run artifact still has to be readable, and
 * its terms are what the chain acted on. So this serves both and says which it
 * is, and the resolver refuses to prepare anything that is not `signed`.
 */
export async function workspaceIntent(
  env: Env,
  settlementId: string,
): Promise<WorkspaceIntent | undefined> {
  return withDb(env, async (sql) => {
    const [row] = (await sql`
      SELECT version, cash_chain_id, cash_escrow, cash_asset, cash_amount, cash_payer,
             cash_receiver, asset_chain_id, asset_escrow, asset_token, asset_amount,
             asset_seller, asset_receiver, cash_policy_hash, asset_policy_hash,
             prepare_deadline, commit_deadline, release_deadline, nonce,
             buyer_signature, seller_signature, terms_source
        FROM conduit.intents WHERE intent_hash = ${settlementId}
    `) as unknown as readonly Record<string, unknown>[];
    if (row === undefined) return undefined;

    const text = (key: string): string => {
      const value = row[key];
      return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    };

    return {
      terms: {
        version: text('version') || '1',
        cashChainId: text('cash_chain_id'),
        cashEscrow: text('cash_escrow'),
        cashAsset: text('cash_asset'),
        cashAmount: text('cash_amount'),
        cashPayer: text('cash_payer'),
        cashReceiver: text('cash_receiver'),
        assetChainId: text('asset_chain_id'),
        assetEscrow: text('asset_escrow'),
        assetToken: text('asset_token'),
        assetAmount: text('asset_amount'),
        assetSeller: text('asset_seller'),
        assetReceiver: text('asset_receiver'),
        cashPolicyHash: text('cash_policy_hash'),
        assetPolicyHash: text('asset_policy_hash'),
        prepareDeadline: text('prepare_deadline'),
        commitDeadline: text('commit_deadline'),
        releaseDeadline: text('release_deadline'),
        nonce: text('nonce'),
      },
      payerSigned: text('buyer_signature') !== '',
      sellerSigned: text('seller_signature') !== '',
      payerSignature: text('buyer_signature') === '' ? undefined : text('buyer_signature'),
      sellerSignature: text('seller_signature') === '' ? undefined : text('seller_signature'),
      termsSource: text('terms_source') || 'unknown',
    };
  });
}

export interface SignRequestView {
  readonly cashAmount: string;
  readonly assetAmount: string;
  readonly cashPayer: string;
  readonly cashReceiver: string;
  readonly assetSeller: string;
  readonly assetReceiver: string;
  readonly prepareDeadline: string;
  readonly commitDeadline: string;
  readonly releaseDeadline: string;
  readonly payerSigned: boolean;
  readonly sellerSigned: boolean;
  readonly intent: Record<string, string>;
}

/** Formats base units for display without floating point. */
function units(raw: string, decimals = 6): string {
  const digits = raw.padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * A stored settlement request, for the counterparty to review.
 *
 * Only intents that someone actually signed are served here. A row whose
 * `terms_source` is anything else was reconstructed from evidence rather than
 * agreed by a party, and offering it as a signing request would invite someone
 * to countersign a settlement the first party never proposed.
 */
export async function signRequest(
  env: Env,
  settlementId: string,
): Promise<SignRequestView | undefined> {
  return withDb(env, async (sql) => {
    const [row] = (await sql`
      SELECT cash_amount, asset_amount, cash_payer, cash_receiver, asset_seller,
             asset_receiver, prepare_deadline, commit_deadline, release_deadline,
             nonce, version, cash_chain_id, cash_escrow, cash_asset, asset_chain_id,
             asset_escrow, asset_token, cash_policy_hash, asset_policy_hash,
             buyer_signature, seller_signature, terms_source
        FROM conduit.intents
       WHERE intent_hash = ${settlementId} AND terms_source = 'signed'
    `) as unknown as readonly Record<string, unknown>[];
    if (row === undefined) return undefined;

    const text = (key: string): string => {
      const value = row[key];
      return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    };

    const intent: Record<string, string> = {
      version: text('version') || '1',
      cashChainId: text('cash_chain_id'),
      cashEscrow: text('cash_escrow'),
      cashAsset: text('cash_asset'),
      cashAmount: text('cash_amount'),
      cashPayer: text('cash_payer'),
      cashReceiver: text('cash_receiver'),
      assetChainId: text('asset_chain_id'),
      assetEscrow: text('asset_escrow'),
      assetToken: text('asset_token'),
      assetAmount: text('asset_amount'),
      assetSeller: text('asset_seller'),
      assetReceiver: text('asset_receiver'),
      cashPolicyHash: text('cash_policy_hash'),
      assetPolicyHash: text('asset_policy_hash'),
      prepareDeadline: text('prepare_deadline'),
      commitDeadline: text('commit_deadline'),
      releaseDeadline: text('release_deadline'),
      nonce: text('nonce'),
    };

    return {
      cashAmount: units(text('cash_amount')),
      assetAmount: units(text('asset_amount')),
      cashPayer: text('cash_payer'),
      cashReceiver: text('cash_receiver'),
      assetSeller: text('asset_seller'),
      assetReceiver: text('asset_receiver'),
      prepareDeadline: text('prepare_deadline'),
      commitDeadline: text('commit_deadline'),
      releaseDeadline: text('release_deadline'),
      payerSigned: text('buyer_signature') !== '',
      sellerSigned: text('seller_signature') !== '',
      intent,
    };
  });
}
