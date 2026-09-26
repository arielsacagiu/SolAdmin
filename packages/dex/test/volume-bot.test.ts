import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  DONTFRONT_MARKER_ADDRESS,
  SPL_MEMO_PROGRAM_ID,
  dontFrontMarkerInstruction,
  withDontFrontMarker,
} from '@solana-toolkit/transaction-builder';
import {
  estimateRoundTripCostLamports,
  jitterAmount,
  jitterInterval,
  venueFeeBps,
  instructionsFromVersionedTransaction,
} from '../src/volume-bot.js';
import {
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

/** Deterministic PRNG (mulberry32) for reproducible jitter tests. */
function seededRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('DontFront marker', () => {
  it('uses a valid on-chain-deployable marker address with the jitodontfront prefix', () => {
    expect(DONTFRONT_MARKER_ADDRESS.startsWith('jitodontfront')).toBe(true);
    // Must parse as a valid pubkey (block engine rejects invalid addresses).
    expect(() => new PublicKey(DONTFRONT_MARKER_ADDRESS)).not.toThrow();
  });

  it('uses the verified executable SPL Memo program as carrier', () => {
    expect(SPL_MEMO_PROGRAM_ID.startsWith('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')).toBe(true);
    expect(() => new PublicKey(SPL_MEMO_PROGRAM_ID)).not.toThrow();
  });

  it('builds a memo instruction carrying the read-only marker account', () => {
    const ix = dontFrontMarkerInstruction();
    expect(ix.programId.toBase58()).toBe(SPL_MEMO_PROGRAM_ID);
    const marker = ix.keys.find((k) => k.pubkey.toBase58() === DONTFRONT_MARKER_ADDRESS)!;
    expect(marker.isSigner).toBe(false);
    expect(marker.isWritable).toBe(false);
  });

  it('appends the marker to an existing instruction without mutating the original', () => {
    const payer = Keypair.generate();
    const transfer = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    const marked = withDontFrontMarker(transfer);
    expect(marked).not.toBe(transfer);
    expect(marked.keys).toHaveLength(transfer.keys.length + 1);
    expect(transfer.keys.some((k) => k.pubkey.toBase58() === DONTFRONT_MARKER_ADDRESS)).toBe(false);
    const marker = marked.keys[marked.keys.length - 1]!;
    expect(marker.pubkey.toBase58()).toBe(DONTFRONT_MARKER_ADDRESS);
    expect(marker.isSigner).toBe(false);
    expect(marker.isWritable).toBe(false);
    // Idempotent: marking twice does not duplicate the account.
    expect(withDontFrontMarker(marked).keys).toHaveLength(marked.keys.length);
  });
});

describe('volume bot jitter and cost helpers', () => {
  it('jitters amounts strictly within ±jitterBps', () => {
    const base = 1_000_000n;
    for (let i = 0; i < 200; i++) {
      const j = jitterAmount(base, 3_000, seededRng(i + 1));
      expect(j).toBeGreaterThanOrEqual(base - (base * 3_000n) / 10_000n);
      expect(j).toBeLessThanOrEqual(base + (base * 3_000n) / 10_000n);
    }
  });

  it('returns the base amount when jitter is disabled or the draw is degenerate', () => {
    expect(jitterAmount(100n, 0)).toBe(100n);
    // rng()=0.5 with ±3000bps: pct = 0 → base (with this implementation the
    // midpoint draw produces exactly zero deviation).
    const j = jitterAmount(100n, 3_000, () => 0.5);
    expect(j).toBe(100n);
  });

  it('never produces a non-positive amount', () => {
    const j = jitterAmount(1n, 9_999, () => 0);
    expect(j).toBeGreaterThan(0n);
  });

  it('jitters intervals with a floor', () => {
    for (let i = 0; i < 100; i++) {
      const t = jitterInterval(10_000, 3_000, 2_000, seededRng(i + 7));
      expect(t).toBeGreaterThanOrEqual(2_000);
      expect(t).toBeLessThanOrEqual(13_000);
    }
    expect(jitterInterval(1_000, 0, 5_000)).toBe(5_000);
  });

  it('estimates round-trip costs = 2 base fees + tip + both venue fees', () => {
    const cost = estimateRoundTripCostLamports({
      buyLamports: 1_000_000_000n,
      tipLamports: 100_000n,
      venueFeeBps: 100, // pump.fun 1% per leg
    });
    expect(cost).toBe(10_000n + 100_000n + 20_000_000n);
  });

  it('maps venues to their verified per-leg fee tiers', () => {
    expect(venueFeeBps('pumpfun')).toBe(100);
    expect(venueFeeBps('moonit')).toBe(100);
    expect(venueFeeBps('raydium-amm-v4')).toBe(25);
    expect(venueFeeBps('pumpswap')).toBe(25);
    expect(venueFeeBps('jupiter')).toBe(50);
  });
});

describe('instruction extraction (aggregator legs)', () => {
  it('reconstructs instructions with correct metas (regression)', () => {
    const payer = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 123 });
    const budget = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: 'EETub36tYt4Qh6t4tDfV7ysnjfeGjVjPfFQHqKsetMNK',
      instructions: [budget, transfer],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const ixs = instructionsFromVersionedTransaction(vtx);
    expect(ixs).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(ixs[1]!.data), Buffer.from(transfer.data))).toBe(0);
  });
});

// Keep the Transaction import referenced for consumers that compile with
// noUnusedLocals-style checks.
void Transaction;
