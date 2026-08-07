#!/usr/bin/env node
/**
 * Configures the registered CVA's RuleV2 and reads it back from chain.
 * PRD 19 phase 03, v1.1 override acceptance "RuleV2 is configured and
 * independently queryable".
 *
 * Registration alone does not make a CVA operational. Right after `ISSUED` the
 * policy holds no rules for the token and `canTransfer` reverts `0x8a4e1859`
 * with the token as its argument, while `getRulesV2(token)` returns `[]`. The
 * CVA guide says the same in prose: "The CVA is fully operational only after
 * rules are configured."
 *
 * **Rules for a CVA are set on chain, not through the rule API.** That is not a
 * preference, it is which contract each path reaches. `POST /validator/add_rule`
 * accepts `{chain, contract_address, rule}` and its rule object takes
 * `countries` as a string array, which is the platform-side bitmap computation
 * the override asks for — but it drives `IAPassComplianceValidator`, and a
 * registered CVA is not a registered pool there. Submitting our token to it
 * returns `12026 AddComplianceRule failed: add validator rule: execution
 * reverted`, which is the validator refusing an address it has never registered.
 * The CVA's own rules live on `IATokenPolicy` and are set through
 * `setRuleV2FromToken`, authenticated on `msg.sender` being the token, which is
 * why `ConduitRWACVA` exposes wrappers rather than letting an admin call the
 * policy directly.
 *
 * `poolCountryBitmap` is therefore `0`. The guide defines zero as no country
 * restriction, and ASM-025 stays open: bit positions are stated to follow ISO
 * 3166-1 numeric codes, which run to 894 against a 256-bit field, and no index
 * table has been supplied. Conduit makes no country-enforcement claim rather
 * than inventing a mapping.
 *
 *   node --env-file=.env scripts/configure-cva-rule.mjs [minTier]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const TOKEN = process.env['RWA_CVA_ADDRESS'];
const POLICY = process.env['CCP_POLICY_BASE_SEPOLIA'];
const minTier = Number(process.argv[2] ?? '0');

const RULE_TUPLE = '(bytes2,bytes2,uint8,uint8,bool,uint256)';

const TOKEN_ABI = parseAbi([
  `function setRuleV2(${RULE_TUPLE} rule)`,
  `function getRulesV2() view returns (${RULE_TUPLE}[])`,
]);

const POLICY_ABI = parseAbi([
  `function getRulesV2(address token) view returns (${RULE_TUPLE}[])`,
  'function canTransfer(address token, address from, address to, uint256 amount) view returns (bool)',
  'error NoAPass(address account)',
  'error TransferNotAllowed()',
]);

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const transport = http(process.env['BASE_SEPOLIA_RPC_URL']);
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport, chain: { id: 84532 } });

const chainId = await pub.getChainId();
if (chainId !== 84532) throw new Error(`RPC reports chain ${chainId}, expected 84532`);

const rulesOnPolicy = () =>
  pub.readContract({ address: POLICY, abi: POLICY_ABI, functionName: 'getRulesV2', args: [TOKEN] });

const describe = (rules) =>
  rules.map(([group, subGroup, tier, subTier, blacklist, bitmap]) => ({
    allowedGroup: group,
    allowedSubGroup: subGroup,
    minTier: tier,
    minSubTier: subTier,
    isBlackList: blacklist,
    poolCountryBitmap: bitmap.toString(),
  }));

console.log(`Base Sepolia ${chainId}`);
console.log(`token  ${TOKEN}`);
console.log(`policy ${POLICY}\n`);

const before = await rulesOnPolicy();
console.log(`before  ${before.length} rules on the policy for this token`);

/**
 * A valid CVI with no group, sub-group, or country restriction, and an optional
 * tier floor. Six fields, because the deployed struct has six however many the
 * guides declare (ADR-0010).
 */
const rule = ['0x0000', '0x0000', minTier, 0, false, 0n];

const hash = await wallet.writeContract({
  address: TOKEN,
  abi: TOKEN_ABI,
  functionName: 'setRuleV2',
  args: [rule],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`setRuleV2  ${receipt.status}  ${hash}`);

// Read back from the policy rather than from the token, so the assertion covers
// the contract a third party would query rather than our own wrapper.
const after = await rulesOnPolicy();
console.log(`after   ${after.length} rules on the policy for this token`);
for (const r of describe(after)) console.log(`        ${JSON.stringify(r)}`);

/** The registration is only proven when the policy will answer for the token. */
const probe = async (from, to) => {
  try {
    return {
      allowed: await pub.readContract({
        address: POLICY,
        abi: POLICY_ABI,
        functionName: 'canTransfer',
        args: [TOKEN, from, to, 1n],
      }),
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      allowed: false,
      refusedWith: text.match(/Error:\s*([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/)?.[1] ?? 'revert',
      refusedAccount: text.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null,
    };
  }
};

const NOBODY = '0x000000000000000000000000000000000000dEaD';
const answers = {
  deployerToDeployer: await probe(account.address, account.address),
  deployerToNobody: await probe(account.address, NOBODY),
};

console.log('\npolicy answers for this token');
for (const [label, a] of Object.entries(answers)) {
  console.log(
    `  ${label.padEnd(20)} ${a.allowed ? 'allowed' : `refused ${a.refusedWith}${a.refusedAccount ? ` ${a.refusedAccount}` : ''}`}`,
  );
}

const evidence = {
  capturedAt: new Date().toISOString(),
  chain: { key: 'baseSepolia', nativeChainId: chainId },
  token: TOKEN,
  policy: POLICY,
  ruleSource:
    'On chain via ConduitRWACVA.setRuleV2 -> IATokenPolicy.setRuleV2FromToken. The CVA guide recommends self-management for a registered contract.',
  ruleApiFinding: {
    endpoint: 'POST /validator/add_rule',
    acceptedShape: ['chain', 'contract_address', 'rule'],
    result: '12026 AddComplianceRule failed: add validator rule: execution reverted',
    interpretation:
      'That endpoint drives IAPassComplianceValidator, where a registered CVA is not a registered pool. It is the correct path for a pool and the wrong contract for a CVA. Its rule object does accept a `countries` string array, which is where platform-side bitmap computation lives.',
  },
  countryBitmap: {
    value: 0,
    meaning: 'no country restriction, per the guide',
    open: 'ASM-025 — bit positions are stated to follow ISO 3166-1 numeric codes, which run to 894 against a 256-bit field, and no index table has been supplied. No country-enforcement claim is made.',
  },
  transaction: { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() },
  rulesBefore: describe(before),
  rulesAfter: describe(after),
  policyAnswers: answers,
  registrationProvenLive: after.length > 0,
};

const path = join(ROOT, 'docs', 'evidence', 'phase-03-cva-rulev2.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);
process.exitCode = after.length > 0 ? 0 : 1;
