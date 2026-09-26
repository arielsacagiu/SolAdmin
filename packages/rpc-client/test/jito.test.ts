import { describe, expect, it } from 'vitest';
import { JITO_TIP_ACCOUNTS_FALLBACK, createJitoClient } from '../src/jito.js';

describe('Jito bundle client', () => {
  it('exposes the pinned tip accounts fallback list with 8 entries', () => {
    expect(JITO_TIP_ACCOUNTS_FALLBACK).toHaveLength(8);
  });

  it('builds endpoint URLs from config', () => {
    const client = createJitoClient({
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipLamports: 1000,
      relaySingleTxs: true,
    });
    expect(client.bundlesUrl).toBe('https://mainnet.block-engine.jito.wtf/api/v1/bundles');
    expect(client.transactionsUrl).toBe('https://mainnet.block-engine.jito.wtf/api/v1/transactions');
  });
});

describe('anti-MEV tip constants', () => {
  it('pins the Jito enforced minimum bundle tip', async () => {
    const mod = await import('../src/jito.js');
    expect(mod.JITO_MIN_TIP_LAMPORTS).toBe(1000n);
    expect(mod.JITO_TIP_FLOOR_URL_DEFAULT).toBe('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
  });

  it('falls back to the configured tip when the feed is unreachable', async () => {
    const { createJitoClient } = await import('../src/jito.js');
    const client = createJitoClient({
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipLamports: 123_456,
      relaySingleTxs: true,
    });
    const tip = await client.recommendedTipLamports(75, {
      tipFloorUrl: 'https://invalid.invalid.invalid/api/v1/bundles/tip_floor',
    });
    expect(tip).toBe(123_456n);
  });

  it('never recommends below the Jito minimum', async () => {
    const { createJitoClient } = await import('../src/jito.js');
    const client = createJitoClient({
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipLamports: 1, // below the enforced minimum
      relaySingleTxs: true,
    });
    const tip = await client.recommendedTipLamports(75, {
      tipFloorUrl: 'https://invalid.invalid.invalid/api/v1/bundles/tip_floor',
    });
    expect(tip).toBeGreaterThanOrEqual(1000n);
  });
});
