/**
 * Minimal JSON-RPC reads for the doctor.
 *
 * viem would do this, but the doctor has to work when configuration is broken,
 * and a client that validates a chain before it will talk to it cannot report
 * that the chain is wrong. These two calls are deliberately dumb.
 */

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${String(response.status)}`);
  }

  const body = (await response.json()) as JsonRpcResponse;
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message}`);
  }
  return body.result;
}

export async function readChainId(rpcUrl: string): Promise<number> {
  const result = await rpcCall(rpcUrl, 'eth_chainId', []);
  if (typeof result !== 'string') {
    throw new Error('eth_chainId did not return a hex string');
  }
  return Number.parseInt(result, 16);
}

export async function readCode(rpcUrl: string, address: string): Promise<string> {
  const result = await rpcCall(rpcUrl, 'eth_getCode', [address, 'latest']);
  if (typeof result !== 'string') {
    throw new Error('eth_getCode did not return a hex string');
  }
  return result;
}
