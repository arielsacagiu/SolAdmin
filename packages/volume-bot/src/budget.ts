/**
 * Budget tracker — enforces hard caps on cumulative net SOL cost and gross
 * notional volume, and keeps a per-wallet ledger for audit.
 * @module
 */

import type { VolumeBotBudget } from './config.js';

export interface WalletLedger {
  publicKey: string;
  roundTrips: number;
  grossVolumeLamports: bigint;
  netCostLamports: bigint;
  failures: number;
}

export class BudgetExhausted extends Error {
  constructor(
    public readonly reason: string,
    public readonly spentSoFar: bigint,
    public readonly cap: bigint,
  ) {
    super(`budget exhausted: ${reason} (spent ${spentSoFar}, cap ${cap})`);
    this.name = 'BudgetExhausted';
  }
}

/**
 * Cumulative accounting across a run. `recordCost` is fed the *expected* cost
 * of each round trip (quote-derived) plus measured deltas when available.
 */
export class BudgetTracker {
  private readonly ledgers = new Map<string, WalletLedger>();
  private totalNetCost = 0n;
  private totalVolume = 0n;

  constructor(private readonly budget: VolumeBotBudget) {}

  /**
   * Throws BudgetExhausted when booking `netCost`/`volume` would exceed a cap.
   */
  checkRoundTrip(wallet: string, maxSolIn: bigint, expectedNetCost: bigint): void {
    if (this.budget.maxPerWalletLamports !== undefined && maxSolIn > this.budget.maxPerWalletLamports) {
      throw new BudgetExhausted(
        `per-wallet size ${maxSolIn} exceeds cap`,
        maxSolIn,
        this.budget.maxPerWalletLamports,
      );
    }
    if (this.totalNetCost + expectedNetCost > this.budget.maxNetCostLamports) {
      throw new BudgetExhausted(
        `net cost ${this.totalNetCost + expectedNetCost} exceeds cap`,
        this.totalNetCost + expectedNetCost,
        this.budget.maxNetCostLamports,
      );
    }
    if (
      this.budget.maxVolumeLamports !== undefined &&
      this.totalVolume + maxSolIn * 2n > this.budget.maxVolumeLamports
    ) {
      throw new BudgetExhausted(
        `volume ${this.totalVolume + maxSolIn * 2n} exceeds cap`,
        this.totalVolume + maxSolIn * 2n,
        this.budget.maxVolumeLamports,
      );
    }
    void wallet;
  }

  /** Books a completed round trip (gross volume = buy + sell notional). */
  recordRoundTrip(wallet: string, maxSolIn: bigint, netCost: bigint): void {
    const l = this.ledger(wallet);
    l.roundTrips++;
    l.grossVolumeLamports += maxSolIn * 2n;
    l.netCostLamports += netCost;
    this.totalNetCost += netCost;
    this.totalVolume += maxSolIn * 2n;
  }

  /** Books a failed attempt (counted, no cost assumed). */
  recordFailure(wallet: string): void {
    this.ledger(wallet).failures++;
  }

  private ledger(wallet: string): WalletLedger {
    let l = this.ledgers.get(wallet);
    if (!l) {
      l = { publicKey: wallet, roundTrips: 0, grossVolumeLamports: 0n, netCostLamports: 0n, failures: 0 };
      this.ledgers.set(wallet, l);
    }
    return l;
  }

  snapshot() {
    return {
      totalNetCostLamports: this.totalNetCost,
      totalVolumeLamports: this.totalVolume,
      wallets: [...this.ledgers.values()],
      caps: { ...this.budget },
    };
  }
}
