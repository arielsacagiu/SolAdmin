/**
 * Real-time priority fee and gas price monitor.
 *
 * Samples `getRecentPrioritizationFees` plus recent confirmed transaction fees
 * and exposes a live micro-lamports/CU estimate with percentile targeting so
 * transaction building can follow network conditions.
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { PriorityFeeSample } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { SolanaRpcClient } from './rpc.js';

const log = moduleLogger('fee-monitor');

/** Fallback tip used when RPC does not support recent fees. */
export const DEFAULT_CU_PRICE_MICROLAMPORTS = 200_000;

export class PriorityFeeMonitor {
  private last: PriorityFeeSample | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listeners: ((sample: PriorityFeeSample) => void)[] = [];

  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly percentile = 60,
    private readonly fallbackMicroLamports = DEFAULT_CU_PRICE_MICROLAMPORTS,
  ) {}

  /** One-shot sample. */
  async sample(lockupPrograms: string[] = []): Promise<PriorityFeeSample> {
    try {
      const fees = await this.rpc.connection.getRecentPrioritizationFees(
        lockupPrograms.length > 0 ? { lockedWritableAccounts: lockupPrograms.map((p) => new PublicKey(p)) } : undefined,
      );
      const samples = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
      const slot = fees.length > 0 ? fees[fees.length - 1]!.slot : 0;
      const micro = this.pickPercentile(samples, this.percentile);
      this.last = {
        slot,
        microLamportsPerCu: micro,
        samples,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.debug({ err }, 'prioritization fee sample failed; using fallback');
      this.last = {
        slot: 0,
        microLamportsPerCu: this.fallbackMicroLamports,
        samples: [],
        fetchedAt: new Date().toISOString(),
      };
    }
    return this.last;
  }

  private pickPercentile(sorted: number[], pct: number): number {
    if (sorted.length === 0) return this.fallbackMicroLamports;
    const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
    return sorted[idx] ?? this.fallbackMicroLamports;
  }

  /** Most recent sample (may be null before the first `sample()` call). */
  current(): PriorityFeeSample | null {
    return this.last;
  }

  /** Current CU price with graceful fallback. */
  currentMicroLamports(): number {
    return this.last?.microLamportsPerCu ?? this.fallbackMicroLamports;
  }

  /** Starts polling every `intervalMs`. */
  start(intervalMs = 10_000, lockupPrograms: string[] = []): void {
    this.stop();
    const tick = () => {
      void this.sample(lockupPrograms)
        .then((s) => this.listeners.forEach((fn) => fn(s)))
        .catch((err) => log.debug({ err }, 'fee sample tick failed'));
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  /** Stops polling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Registers a listener invoked on every successful sample. */
  onUpdate(fn: (sample: PriorityFeeSample) => void): void {
    this.listeners.push(fn);
  }
}
