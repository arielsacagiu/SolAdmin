import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';
import {
  createCryptoRng,
  createSecureRng,
  generateRandomizedTip,
  PersistentWalletRegistry,
  fundBuyersAnonymously,
  DEFAULT_ANONYMITY_CONFIG,
  DEFAULT_ANTI_CORRELATION_CONFIG,
} from '../src/anonymity.js';
import { TransactionRequest } from '@solana-toolkit/transaction-builder';

/** Records every send so funding graphs can be asserted. */
function mockCtx() {
  const sent: { feePayer: string; from: string; to: string }[] = [];
  const ctx = {
    sender: {
      send: async (req: TransactionRequest) => {
        const ix = req.instructions[0] as unknown as {
          programId: { equals: (p: unknown) => boolean };
          keys: { pubkey: { toBase58: () => string } }[];
        };
        if (ix && ix.programId.equals(SystemProgram.programId)) {
          sent.push({
            feePayer: req.feePayer,
            from: ix.keys[0]!.pubkey.toBase58(),
            to: ix.keys[1]!.pubkey.toBase58(),
          });
        }
        return { signature: 'sig', signatures: ['sig'], simulated: true, elapsedMs: 1, warnings: [] };
      },
    },
  };
  return { ctx, sent };
}

describe('CSPRNG', () => {
  it('draws uniform values in [0, 1)', () => {
    const rng = createCryptoRng();
    for (let i = 0; i < 1_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic with a seed (test reproducibility)', () => {
    const a = createCryptoRng(Uint8Array.of(1, 2, 3));
    const b = createCryptoRng(Uint8Array.of(1, 2, 3));
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('produces different streams from different seeds', () => {
    const a = createCryptoRng(Uint8Array.of(1));
    const b = createCryptoRng(Uint8Array.of(2));
    expect(a()).not.toBe(b());
  });

  it('createSecureRng is crypto-backed (seeded stays deterministic)', () => {
    const a = createSecureRng(42);
    const b = createSecureRng(42);
    expect(a()).toBe(b());
    expect(a()).not.toBe(a());
  });
});

describe('generateRandomizedTip', () => {
  it('returns the base amount when jitter is 0', () => {
    expect(generateRandomizedTip(100_000n, 0)).toBe(100_000n);
  });

  it('jitters within ±jitterBps bounds', () => {
    const base = 100_000n;
    const bps = 1_000; // ±10%
    for (let i = 0; i < 200; i++) {
      const tip = generateRandomizedTip(base, bps);
      expect(tip).toBeGreaterThan((base * 9n) / 10n - 1n);
      expect(tip).toBeLessThan((base * 11n) / 10n + 1n);
    }
  });

  it('never produces a non-positive tip', () => {
    const tip = generateRandomizedTip(1n, 10_000);
    expect(tip).toBeGreaterThan(0n);
  });
});

describe('PersistentWalletRegistry', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soladmin-registry-'));

  it('persists registrations and reloads them in a fresh instance', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'registry.json');
    const reg = new PersistentWalletRegistry(file);
    reg.register('treasury', Keypair.generate().publicKey.toBase58());
    reg.register('buyer', Keypair.generate().publicKey.toBase58());
    reg.register('relay', Keypair.generate().publicKey.toBase58());
    expect(fs.existsSync(file)).toBe(true);

    const reloaded = new PersistentWalletRegistry(file);
    const stats = reloaded.getStats();
    expect(stats.treasuries).toBe(1);
    expect(stats.buyers).toBe(1);
    expect(stats.relays).toBe(1);
  });

  it('detects reuse within the expiry window and allows expired entries', () => {
    const dir = tmpDir();
    const reg = new PersistentWalletRegistry(path.join(dir, 'registry.json'));
    const addr = Keypair.generate().publicKey.toBase58();
    expect(reg.isUsed('buyer', addr)).toBe(false);
    reg.register('buyer', addr);
    expect(reg.isUsed('buyer', addr)).toBe(true);

    // Advance virtual time past the 1s window: the entry is now expired,
    // reported reusable, and pruned on read (prune-on-read design).
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(5_000);
      expect(reg.isUsed('buyer', addr, 1_000)).toBe(false);
      expect(reg.isUsed('buyer', addr)).toBe(false); // pruned above
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a missing file (starts empty)', () => {
    const reg = new PersistentWalletRegistry(path.join(tmpDir(), 'missing.json'));
    expect(reg.getStats().buyers).toBe(0);
  });
});

describe('fundBuyersAnonymously anti-correlation', () => {
  const anonymity = { ...DEFAULT_ANONYMITY_CONFIG, randomizedTimingEnabled: false };

  it('routes funding treasury→relay→buyer with distinct feePayers (no direct edge)', async () => {
    const { ctx, sent } = mockCtx();
    const treasury = Keypair.generate();
    const buyer = Keypair.generate();
    const registry = new PersistentWalletRegistry(null);

    const result = await fundBuyersAnonymously({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: ctx as any,
      treasury,
      buyers: [buyer],
      lamportsPerBuyer: 50_000n,
      anonymity,
      antiCorrelation: { breakFundingGraph: true, distinctFeePayers: true },
      registry,
      mode: 'simulate',
    });

    expect(result.failures).toHaveLength(0);
    expect(result.funded).toContain(buyer.publicKey.toBase58());
    expect(sent).toHaveLength(2);

    const [leg1, leg2] = sent;
    // Leg 1: treasury → relay, treasury pays.
    expect(leg1!.from).toBe(treasury.publicKey.toBase58());
    expect(leg1!.feePayer).toBe(treasury.publicKey.toBase58());
    expect(leg1!.to).not.toBe(buyer.publicKey.toBase58());
    // Leg 2: relay → buyer, the RELAY pays (distinct feePayer).
    expect(leg2!.to).toBe(buyer.publicKey.toBase58());
    expect(leg2!.from).not.toBe(treasury.publicKey.toBase58());
    expect(leg2!.feePayer).toBe(leg2!.from);
    // No direct treasury→buyer edge anywhere in the graph.
    for (const leg of sent) {
      expect(leg.from === treasury.publicKey.toBase58() && leg.to === buyer.publicKey.toBase58()).toBe(false);
    }
    // The relay was registered for reuse detection.
    expect(registry.isUsed('relay', leg2!.from)).toBe(true);
    expect(registry.isUsed('buyer', buyer.publicKey.toBase58())).toBe(true);
  });

  it('substitutes a fresh keypair for a buyer already in the registry', async () => {
    const { ctx, sent } = mockCtx();
    const treasury = Keypair.generate();
    const staleBuyer = Keypair.generate();
    const registry = new PersistentWalletRegistry(null);
    registry.register('buyer', staleBuyer.publicKey.toBase58());

    const result = await fundBuyersAnonymously({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: ctx as any,
      treasury,
      buyers: [staleBuyer],
      lamportsPerBuyer: 50_000n,
      anonymity,
      antiCorrelation: { breakFundingGraph: true },
      registry,
      mode: 'simulate',
    });

    expect(result.funded).not.toContain(staleBuyer.publicKey.toBase58());
    expect(result.funded).toHaveLength(1);
    expect(sent[1]!.to).not.toBe(staleBuyer.publicKey.toBase58());
  });

  it('keeps the legacy direct path when breakFundingGraph is disabled', async () => {
    const { ctx, sent } = mockCtx();
    const treasury = Keypair.generate();
    const buyer = Keypair.generate();

    const result = await fundBuyersAnonymously({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: ctx as any,
      treasury,
      buyers: [buyer],
      lamportsPerBuyer: 50_000n,
      anonymity,
      antiCorrelation: { breakFundingGraph: false },
      mode: 'simulate',
    });

    expect(result.failures).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe(treasury.publicKey.toBase58());
    expect(sent[0]!.to).toBe(buyer.publicKey.toBase58());
  });

  it('defaults to the anti-correlation config (relay routing on)', () => {
    expect(DEFAULT_ANTI_CORRELATION_CONFIG.breakFundingGraph).toBe(true);
    expect(DEFAULT_ANTI_CORRELATION_CONFIG.cryptoRng).toBe(true);
    expect(DEFAULT_ANTI_CORRELATION_CONFIG.distinctFeePayers).toBe(true);
    expect(DEFAULT_ANTI_CORRELATION_CONFIG.tipJitterBps).toBeGreaterThan(0);
  });
});
