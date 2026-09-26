import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  BudgetExhausted,
  BudgetTracker,
  parseVolumeBotConfig,
  planFunding,
} from '../src/index.js';

const MINT = Keypair.generate().publicKey.toBase58();

function validRaw(): Record<string, unknown> {
  return {
    venue: 'auto',
    mint: MINT,
    wallets: { keystoreDir: './wallets/volbot' },
    tradeLamports: { min: '1000000', max: '5000000' },
    slippageBps: 300,
    schedule: { rounds: 10, walletsPerRound: 2, intervalMs: 1000, jitterMs: 500 },
    execution: 'intra-tx',
    dispatch: 'rpc',
    budget: { maxNetCostLamports: '100000000' },
    unwind: { sellResidualTokens: true, leaveLamports: '1000000' },
  };
}

describe('volume-bot config parsing', () => {
  it('parses a valid config with defaults', () => {
    const cfg = parseVolumeBotConfig(validRaw());
    expect(cfg.venue).toBe('auto');
    expect(cfg.tradeLamports.min).toBe(1_000_000n);
    expect(cfg.tradeLamports.max).toBe(5_000_000n);
    expect(cfg.schedule.rounds).toBe(10);
    expect(cfg.execution).toBe('intra-tx');
    expect(cfg.budget.maxNetCostLamports).toBe(100_000_000n);
    expect(cfg.unwind.leaveLamports).toBe(1_000_000n);
  });

  it('rejects a bad mint', () => {
    const raw = validRaw();
    raw['mint'] = 'not-a-mint';
    expect(() => parseVolumeBotConfig(raw)).toThrow(/mint/);
  });

  it('rejects missing wallet sources', () => {
    const raw = validRaw();
    raw['wallets'] = {};
    expect(() => parseVolumeBotConfig(raw)).toThrow(/wallets/);
  });

  it('rejects zero/missing net-cost cap', () => {
    const raw = validRaw();
    raw['budget'] = {};
    expect(() => parseVolumeBotConfig(raw)).toThrow(/maxNetCostLamports/);
  });

  it('rejects bundle execution without jito-bundle dispatch', () => {
    const raw = validRaw();
    raw['execution'] = 'bundle';
    raw['dispatch'] = 'rpc';
    expect(() => parseVolumeBotConfig(raw)).toThrow(/dispatch/);
  });

  it('defaults dispatch to jito-bundle for bundle execution', () => {
    const raw = validRaw();
    raw['execution'] = 'bundle';
    delete raw['dispatch'];
    expect(parseVolumeBotConfig(raw).dispatch).toBe('jito-bundle');
  });

  it('rejects tradeLamports.max < min', () => {
    const raw = validRaw();
    raw['tradeLamports'] = { min: '9000', max: '100' };
    expect(() => parseVolumeBotConfig(raw)).toThrow(/max/);
  });

  it('accepts keystorePaths list', () => {
    const raw = validRaw();
    raw['wallets'] = { keystorePaths: ['./a.json', './b.json'], maxWallets: 1 };
    const cfg = parseVolumeBotConfig(raw);
    expect(cfg.wallets.keystorePaths).toHaveLength(2);
    expect(cfg.wallets.maxWallets).toBe(1);
  });
});

describe('budget tracker', () => {
  const budget = {
    maxNetCostLamports: 1_000_000n,
    maxVolumeLamports: 10_000_000n,
    maxPerWalletLamports: 3_000_000n,
  };

  it('permits round trips under the caps', () => {
    const t = new BudgetTracker(budget);
    expect(() => t.checkRoundTrip('w1', 1_000_000n, 100_000n)).not.toThrow();
    t.recordRoundTrip('w1', 1_000_000n, 100_000n);
    expect(t.snapshot().totalNetCostLamports).toBe(100_000n);
    expect(t.snapshot().totalVolumeLamports).toBe(2_000_000n);
  });

  it('throws BudgetExhausted when the net-cost cap would be exceeded', () => {
    const t = new BudgetTracker(budget);
    t.recordRoundTrip('w1', 1_000_000n, 900_000n);
    expect(() => t.checkRoundTrip('w1', 1_000_000n, 200_000n)).toThrow(BudgetExhausted);
  });

  it('throws when a single trip exceeds the per-wallet cap', () => {
    const t = new BudgetTracker(budget);
    expect(() => t.checkRoundTrip('w1', 3_000_001n, 0n)).toThrow(BudgetExhausted);
  });

  it('throws when the volume cap would be exceeded', () => {
    const t = new BudgetTracker(budget);
    t.recordRoundTrip('w1', 3_000_000n, 0n); // 6 SOL volume
    t.recordRoundTrip('w1', 1_500_000n, 0n); // 3 SOL → 9 total
    expect(() => t.checkRoundTrip('w1', 1_000_000n, 0n)).toThrow(/volume/);
  });

  it('tracks failures separately', () => {
    const t = new BudgetTracker(budget);
    t.recordFailure('w1');
    t.recordFailure('w1');
    const w = t.snapshot().wallets.find((x) => x.publicKey === 'w1')!;
    expect(w.failures).toBe(2);
    expect(w.roundTrips).toBe(0);
  });
});

describe('funding planner', () => {
  it('tops up only wallets below target', () => {
    const plan = planFunding(
      [
        { publicKey: 'a', lamports: 0n },
        { publicKey: 'b', lamports: 5_000_000n },
        { publicKey: 'c', lamports: 10_000_000n },
      ],
      8_000_000n,
    );
    expect(plan).toEqual([
      { wallet: 'a', currentLamports: 0n, deficitLamports: 8_000_000n },
      { wallet: 'b', currentLamports: 5_000_000n, deficitLamports: 3_000_000n },
    ]);
  });

  it('returns empty when all funded', () => {
    expect(planFunding([{ publicKey: 'a', lamports: 10n }], 5n)).toEqual([]);
  });
});
