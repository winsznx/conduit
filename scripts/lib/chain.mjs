/**
 * Reads and writes that do not lie about what the chain has seen.
 *
 * A receipt proves inclusion at block N. It does not prove that the node
 * answering the next call has reached N, and on Base Sepolia's public endpoint
 * it frequently has not. That cost a live run: a reservation was confirmed,
 * `prepareAsset` was submitted against it, gas estimation ran on a node behind
 * the head, and the revert read as a missing reservation. The diagnosis
 * "contract refused" and the diagnosis "node had not caught up" are different
 * bugs with different fixes, and guessing between them is how the same twenty
 * minutes gets spent twice.
 *
 * So every prerequisite write goes through `submit`:
 *
 * ```text
 *   simulate  → a revert here is the contract's answer, before any gas is spent
 *   broadcast → hash printed immediately
 *   receipt   → status must be success
 *   visible   → every configured provider reports latest >= the receipt's block
 *   observed  → the expected post-state read back, from every provider
 * ```
 *
 * and only then does the next call go out. Where more than one provider is
 * configured for a chain, disagreement between them is recorded as its own
 * classification rather than folded into "the read was stale": one node behind
 * the head and two nodes on different forks are not the same problem.
 */
import { createPublicClient, createWalletClient, http } from 'viem';

/**
 * Named so a failure after a write is classified before it is explained.
 * CLAUDE.md requires the classification; decoding a revert before state
 * visibility is established produces a confident wrong answer.
 */
export const Classification = {
  RPC_STATE_LAG: 'RPC_STATE_LAG',
  RPC_ARCHIVE_UNAVAILABLE: 'RPC_ARCHIVE_UNAVAILABLE',
  RPC_PROVIDER_DISAGREEMENT: 'RPC_PROVIDER_DISAGREEMENT',
  PREREQUISITE_NOT_MINED: 'PREREQUISITE_NOT_MINED',
  PREREQUISITE_STATE_MISMATCH: 'PREREQUISITE_STATE_MISMATCH',
  CONTRACT_REVERT: 'CONTRACT_REVERT',
  UNKNOWN: 'UNKNOWN',
};

export class ClassifiedError extends Error {
  constructor(classification, message, detail = {}) {
    super(`${classification}: ${message}`);
    this.name = 'ClassifiedError';
    this.classification = classification;
    this.detail = detail;
  }
}

/**
 * Splits a comma-separated RPC list, keeping order: the first is the writer.
 *
 * Independent providers are opt-in through the plural variable rather than
 * hardcoded, because a public endpoint baked into the repository is a
 * dependency nobody chose and an outage nobody can configure around.
 */
export function rpcUrlsFrom(env, singular, plural) {
  const many = env[plural];
  if (typeof many === 'string' && many.trim() !== '') {
    return many
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url !== '');
  }
  const one = env[singular];
  if (typeof one === 'string' && one.trim() !== '') return [one.trim()];
  throw new Error(`missing environment: ${singular} (or ${plural})`);
}

/** Hides an API key in a URL, so a provider can be named in evidence. */
export function providerLabel(url) {
  const parsed = new URL(url);
  return parsed.host;
}

export function createChain({ name, chainId, rpcUrls, account, explorer }) {
  const clients = rpcUrls.map((url) =>
    createPublicClient({ transport: http(url, { retryCount: 2, timeout: 20_000 }) }),
  );

  return {
    name,
    chainId,
    explorer,
    rpcUrls,
    providers: rpcUrls.map(providerLabel),
    /** The writer, and the reader every single-provider path uses. */
    pub: clients[0],
    /** Every configured provider, for cross-checking. */
    pubs: clients,
    wallet: createWalletClient({
      account,
      transport: http(rpcUrls[0], { retryCount: 2, timeout: 20_000 }),
      chain: { id: chainId },
    }),
    txUrl: (hash) => (explorer === undefined ? undefined : `${explorer}/tx/${hash}`),
  };
}

/** Asserts every provider is the chain it claims to be. */
export async function assertChainIdentity(chain) {
  const reported = await Promise.all(chain.pubs.map((client) => client.getChainId()));
  reported.forEach((id, index) => {
    if (id !== chain.chainId) {
      throw new ClassifiedError(
        Classification.RPC_PROVIDER_DISAGREEMENT,
        `${chain.name} provider ${chain.providers[index]} reports chain ${id}, expected ${chain.chainId}`,
        { provider: chain.providers[index], reported: id, expected: chain.chainId },
      );
    }
  });
  return reported;
}

/**
 * Waits until every provider has a head at or past `blockNumber`.
 *
 * The failure is `RPC_STATE_LAG` and not a revert, which is the whole point:
 * a node behind the head answers reads correctly for a state that is simply
 * older than the one being asked about.
 */
export async function awaitVisible(chain, blockNumber, { budgetMs = 180_000, log } = {}) {
  const deadline = Date.now() + budgetMs;
  const behind = new Map();

  while (Date.now() < deadline) {
    const heads = await Promise.all(chain.pubs.map((client) => client.getBlockNumber()));
    behind.clear();
    heads.forEach((head, index) => {
      if (head < blockNumber) behind.set(chain.providers[index], head);
    });
    if (behind.size === 0) return heads;

    if (log !== undefined) {
      const summary = [...behind.entries()].map(([p, h]) => `${p}@${h}`).join(' ');
      log.step(`waiting for ${blockNumber}: ${summary}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  throw new ClassifiedError(
    Classification.RPC_STATE_LAG,
    `${chain.name} never reported block ${blockNumber} on every provider within ${budgetMs / 1000}s`,
    { blockNumber: String(blockNumber), behind: Object.fromEntries(behind) },
  );
}

/**
 * Reads the same call from every provider and reports disagreement.
 *
 * Values are compared as strings, so bigints and addresses compare by content.
 * A disagreement is returned rather than thrown when `tolerate` is set, because
 * during a wait it is information and after a wait it is a fault.
 */
export async function readAcross(chain, read, { tolerate = false } = {}) {
  const results = await Promise.allSettled(chain.pubs.map((client) => read(client)));
  const values = [];
  const unavailable = [];

  results.forEach((result, index) => {
    const provider = chain.providers[index];
    if (result.status === 'fulfilled') {
      values.push({ provider, value: result.value, key: stringify(result.value) });
    } else {
      unavailable.push({ provider, error: shortMessage(result.reason) });
    }
  });

  if (values.length === 0) {
    throw new ClassifiedError(
      Classification.RPC_ARCHIVE_UNAVAILABLE,
      `${chain.name}: no provider answered the read`,
      { unavailable },
    );
  }

  const distinct = new Set(values.map((entry) => entry.key));
  const agreed = distinct.size === 1;

  if (!agreed && !tolerate) {
    throw new ClassifiedError(
      Classification.RPC_PROVIDER_DISAGREEMENT,
      `${chain.name} providers disagree: ${values.map((v) => `${v.provider}=${v.key}`).join(' ')}`,
      { values: values.map((v) => ({ provider: v.provider, value: v.key })) },
    );
  }

  return { value: values[0].value, agreed, values, unavailable };
}

/**
 * Polls a read until it satisfies `matches`, then returns it.
 *
 * Asserting the state rather than sleeping means a write that genuinely never
 * landed fails here, with the state it did observe, instead of one call later
 * wearing an error about something else.
 */
export async function until(
  label,
  read,
  matches,
  { budgetMs = 180_000, log, everyMs = 3_000 } = {},
) {
  const deadline = Date.now() + budgetMs;
  let last;
  let reads = 0;
  while (Date.now() < deadline) {
    last = await read();
    reads += 1;
    if (matches(last)) return last;
    if (log !== undefined && reads % 5 === 0) log.step(`${label}: still ${stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new ClassifiedError(
    Classification.PREREQUISITE_STATE_MISMATCH,
    `${label}: never observed; last read ${stringify(last)}`,
    { observed: stringify(last) },
  );
}

/**
 * A protocol step: simulated, broadcast, confirmed, made visible, asserted.
 *
 * `postState` is not optional in spirit. A write whose effect is never read
 * back is a write that might not have happened, and CLAUDE.md is explicit that
 * minting, registration, funding, approval, reservation, preparation, commit
 * and release are protocol steps rather than setup.
 */
export async function submit(chain, { label, log, request, postState, budgetMs = 180_000 }) {
  // 1. Simulate. A revert here is the contract's answer and costs nothing, and
  //    it is only meaningful once the previous step's state is visible — which
  //    is what the previous `submit` guaranteed before returning.
  let simulated;
  try {
    simulated = await chain.pub.simulateContract({ ...request, account: chain.wallet.account });
  } catch (error) {
    throw new ClassifiedError(Classification.CONTRACT_REVERT, `${label} would revert`, {
      chain: chain.name,
      reason: shortMessage(error),
    });
  }

  // 2. Broadcast, and say so before waiting on anything.
  const hash = await chain.wallet.writeContract(simulated.request);
  log.broadcast(label, hash, chain.txUrl(hash));

  // 3. Receipt.
  let receipt;
  try {
    receipt = await chain.pub.waitForTransactionReceipt({ hash, timeout: budgetMs });
  } catch (error) {
    throw new ClassifiedError(Classification.PREREQUISITE_NOT_MINED, `${label} never mined`, {
      chain: chain.name,
      hash,
      reason: shortMessage(error),
    });
  }
  if (receipt.status !== 'success') {
    throw new ClassifiedError(Classification.CONTRACT_REVERT, `${label} reverted on chain`, {
      chain: chain.name,
      hash,
      blockNumber: String(receipt.blockNumber),
    });
  }
  log.step(`${label} mined in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);

  // 4. Visible everywhere before anything depends on it.
  await awaitVisible(chain, receipt.blockNumber, { budgetMs, log });

  // 5. The state the write was for, read back and asserted.
  if (postState !== undefined) {
    const observed = await until(
      `${label}: ${postState.describe}`,
      async () => (await readAcross(chain, postState.read, { tolerate: true })).value,
      postState.matches,
      { budgetMs, log },
    );
    const cross = await readAcross(chain, postState.read, { tolerate: true });
    if (!cross.agreed) {
      log.warn(
        `${label}: providers disagree after confirmation — ` +
          cross.values.map((v) => `${v.provider}=${v.key}`).join(' '),
      );
    }
    log.ok(`${label}: ${postState.describe} — ${stringify(observed)}`);
    return { hash, receipt, observed, providerAgreement: cross.agreed, simulated };
  }

  log.ok(`${label}: confirmed`);
  return { hash, receipt, providerAgreement: true, simulated };
}

/** Classifies an error that escaped a step, so a report never guesses. */
export function classify(error) {
  if (error instanceof ClassifiedError) return error.classification;
  const message = shortMessage(error);
  if (/reverted|execution reverted|custom error/i.test(message)) {
    return Classification.CONTRACT_REVERT;
  }
  if (/missing trie node|state (is )?not available|archive/i.test(message)) {
    return Classification.RPC_ARCHIVE_UNAVAILABLE;
  }
  return Classification.UNKNOWN;
}

function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value, (_key, inner) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    );
  }
  return String(value);
}

/**
 * The custom error a revert actually carried, by name.
 *
 * viem's `shortMessage` is "The contract function X reverted." and the decoded
 * error lives further down the cause chain. Matching on the message text is how
 * a check ends up asserting the wrong thing about the right revert.
 */
export function revertName(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const name = current.data?.errorName;
    if (typeof name === 'string') return name;
    current = current.cause;
  }
  const match = /Error:\s*([A-Za-z0-9_]+)\(/.exec(String(error?.message ?? ''));
  return match === null ? undefined : match[1];
}

function shortMessage(error) {
  if (error instanceof Error) {
    return (error.shortMessage ?? error.message).split('\n')[0];
  }
  return String(error);
}

export { stringify, shortMessage };
