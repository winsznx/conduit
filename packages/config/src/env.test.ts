import { describe, expect, it } from 'vitest';

import {
  assertAllChainIds,
  assertChainId,
  CHAINS,
  chainByNativeId,
  chainByWormholeId,
} from './chains.js';
import { ChainMismatchError, ConfigError } from './errors.js';
import { credentialPresence, loadCleanverseEnv, loadRuntimeEnv } from './env.js';

const VALID_CLEANVERSE = {
  CLEANVERSE_BASE_URL: 'https://sandbox.cleanverse.example',
  CLEANVERSE_API_ID: 'api-id-value',
  CLEANVERSE_API_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  CLEANVERSE_REQUEST_TIMEOUT_MS: '15000',
  CLEANVERSE_MAX_READ_RETRIES: '2',
};

describe('Cleanverse environment validation', () => {
  it('accepts a complete configuration and coerces numbers', () => {
    const env = loadCleanverseEnv(VALID_CLEANVERSE);

    expect(env.CLEANVERSE_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(env.CLEANVERSE_MAX_READ_RETRIES).toBe(2);
  });

  it('applies documented defaults for the optional tuning values', () => {
    const env = loadCleanverseEnv({
      CLEANVERSE_BASE_URL: VALID_CLEANVERSE.CLEANVERSE_BASE_URL,
      CLEANVERSE_API_ID: VALID_CLEANVERSE.CLEANVERSE_API_ID,
      CLEANVERSE_API_KEY_BASE64: VALID_CLEANVERSE.CLEANVERSE_API_KEY_BASE64,
    });

    expect(env.CLEANVERSE_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(env.CLEANVERSE_MAX_READ_RETRIES).toBe(2);
  });

  it('treats a present-but-empty variable as absent', () => {
    // `.env` files written from the template carry `KEY=` lines, and Node's
    // --env-file loads those as empty strings. Without normalization,
    // z.coerce.number() turns '' into 0 and the documented default never
    // applies, so an untouched template line fails as "too small".
    const env = loadCleanverseEnv({
      ...VALID_CLEANVERSE,
      CLEANVERSE_REQUEST_TIMEOUT_MS: '',
      CLEANVERSE_MAX_READ_RETRIES: '   ',
    });

    expect(env.CLEANVERSE_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(env.CLEANVERSE_MAX_READ_RETRIES).toBe(2);
  });

  it('still fails closed when a required variable is present but empty', () => {
    expect(() => loadCleanverseEnv({ ...VALID_CLEANVERSE, CLEANVERSE_API_ID: '' })).toThrow(
      ConfigError,
    );
  });

  it.each(['CLEANVERSE_BASE_URL', 'CLEANVERSE_API_ID', 'CLEANVERSE_API_KEY_BASE64'])(
    'fails closed when %s is absent',
    (name) => {
      const source = { ...VALID_CLEANVERSE, [name]: undefined };
      expect(() => loadCleanverseEnv(source)).toThrow(ConfigError);
    },
  );

  it('rejects a plaintext base URL', () => {
    // The AES layer encrypts the body but authenticates no endpoint, so TLS is
    // what prevents the credential being sent to an attacker-controlled host.
    expect(() =>
      loadCleanverseEnv({ ...VALID_CLEANVERSE, CLEANVERSE_BASE_URL: 'http://sandbox.example' }),
    ).toThrow(ConfigError);
  });

  it('rejects an API key that is not base64', () => {
    expect(() =>
      loadCleanverseEnv({ ...VALID_CLEANVERSE, CLEANVERSE_API_KEY_BASE64: 'not base64!' }),
    ).toThrow(ConfigError);
  });

  it('never puts a credential value in the error message', () => {
    const secret = 'super-secret-value-that-must-not-leak!!';

    try {
      loadCleanverseEnv({ ...VALID_CLEANVERSE, CLEANVERSE_API_KEY_BASE64: secret });
      expect.unreachable('expected validation to fail');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('CLEANVERSE_API_KEY_BASE64');
      expect(message).not.toContain(secret);
    }
  });

  it('names every missing variable rather than stopping at the first', () => {
    try {
      loadCleanverseEnv({});
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect((error as ConfigError).problems.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('runtime environment', () => {
  it('defaults to development and info', () => {
    const env = loadRuntimeEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects an unknown log level', () => {
    expect(() => loadRuntimeEnv({ LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });
});

describe('credential presence reporting', () => {
  it('reports configured state and length but never the value', () => {
    const presence = credentialPresence(VALID_CLEANVERSE);
    const apiId = presence.find((p) => p.name === 'CLEANVERSE_API_ID');

    expect(apiId?.configured).toBe(true);
    expect(apiId?.length).toBe(VALID_CLEANVERSE.CLEANVERSE_API_ID.length);
    expect(JSON.stringify(presence)).not.toContain(VALID_CLEANVERSE.CLEANVERSE_API_ID);
  });

  it('marks an unset variable as not configured', () => {
    const presence = credentialPresence({});
    expect(presence.every((p) => !p.configured)).toBe(true);
  });
});

describe('chain identity', () => {
  it('keeps native and Wormhole chain IDs distinct', () => {
    // Confusing the two is threat T-12. They are unrelated integers for the same
    // network and must never be interchangeable.
    expect(CHAINS.monadTestnet.nativeChainId).toBe(10_143);
    expect(CHAINS.monadTestnet.wormholeChainId).toBe(10_009);
    expect(CHAINS.arbitrumSepolia.nativeChainId).toBe(421_614);
    expect(CHAINS.arbitrumSepolia.wormholeChainId).toBe(10_003);
  });

  it('looks a chain up by either identifier', () => {
    expect(chainByNativeId(10_143)?.key).toBe('monadTestnet');
    expect(chainByWormholeId(10_003)?.key).toBe('arbitrumSepolia');
  });

  it('does not resolve a Wormhole ID through the native lookup', () => {
    expect(chainByNativeId(10_009)).toBeUndefined();
  });

  it('assigns the cash leg to Monad and the asset leg to Arbitrum', () => {
    expect(CHAINS.monadTestnet.role).toBe('cash');
    expect(CHAINS.arbitrumSepolia.role).toBe('asset');
  });
});

describe('startup chain-ID verification', () => {
  it('passes when the RPC reports the expected chain', async () => {
    await expect(
      assertChainId(CHAINS.monadTestnet, 'https://rpc.example', () => Promise.resolve(10_143)),
    ).resolves.toBeUndefined();
  });

  it('refuses to start against the wrong network', async () => {
    // An RPC pointed at the wrong chain means a settlement signed for one chain
    // is submitted to another.
    await expect(
      assertChainId(CHAINS.monadTestnet, 'https://rpc.example', () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(ChainMismatchError);
  });

  it('checks every configured chain', async () => {
    const seen: string[] = [];
    await assertAllChainIds(
      { monadTestnet: 'https://monad.example', arbitrumSepolia: 'https://arb.example' },
      (url) => {
        seen.push(url);
        return Promise.resolve(url.includes('monad') ? 10_143 : 421_614);
      },
    );

    expect(seen).toEqual(['https://monad.example', 'https://arb.example']);
  });

  it('fails the whole startup when any one chain disagrees', async () => {
    await expect(
      assertAllChainIds(
        { monadTestnet: 'https://monad.example', arbitrumSepolia: 'https://arb.example' },
        (url) => Promise.resolve(url.includes('monad') ? 10_143 : 999),
      ),
    ).rejects.toBeInstanceOf(ChainMismatchError);
  });
});
