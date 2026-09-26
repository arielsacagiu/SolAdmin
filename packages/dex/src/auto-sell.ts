/**
 * Token Auto Sell — automated exit strategies with configurable triggers.
 *
 * Monitors a position (entry price from the buy fill, or explicitly given)
 * and sells when a trigger fires:
 *   - take-profit multiplier (e.g. 2.0 = +100%)
 *   - stop-loss fraction (e.g. 0.5 = -50%)
 *   - TRAILING STOP: sells when price retraces `trailingStopBps` from its
 *     peak since the stop armed at `trailingActivationMultiplier` × entry —
 *     locks in upside without capping it, the standard production exit for
 *     volatile launches
 *   - timeout in seconds
 *   - bonding-curve graduation (Pump.fun)
 *
 * Trigger evaluation is a PURE function (`evaluateExitTrigger`) so the exit
 * logic is fully unit-testable without RPC. Prices are sampled from the
 * Pump.fun curve or the Jupiter price API, with exponential backoff when
 * samples fail (no RPC hammering during outages). Exits route through the
 * same venues as buys and default to Jito relay with an inline tip.
 * @module
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import type { AutoSellTrigger, SendOutcome } from '@solana-toolkit/types';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import type { DexContext } from './context.js';
import { executeSwap } from './swap.js';
import { WSOL_MINT, decodeBondingCurve, pumpBondingCurvePda, PROGRAMS } from '@solana-toolkit/solana-programs';

const log = moduleLogger('auto-sell');

export interface AutoSellOptions {
  venue: 'pumpfun' | 'pumpswap' | 'raydium-amm-v4' | 'jupiter' | 'moonit';
  wallet: Keypair;
  mint: string;
  /** Entry price (SOL per whole token) — set from the buy fill. */
  entryPriceSol: number;
  /** Token balance to sell (raw). When omitted, sells the wallet's full ATA. */
  amountRaw?: bigint;
  trigger: AutoSellTrigger;
  slippageBps: number;
  pollIntervalMs?: number;
  mode?: 'simulate' | 'execute';
  shouldStop?: () => boolean;
  /** Safety cap on poll iterations (default 100_000). */
  maxChecks?: number;
}

export interface AutoSellReport {
  sold: boolean;
  reason: string;
  priceAtExit?: number;
  /** Highest price observed while armed (trailing-stop audit trail). */
  peakPrice?: number;
  outcome?: SendOutcome | { signature: string; simulated: boolean };
  checks: number;
}

/** Mutable trigger state threaded through the poll loop. */
export interface TriggerState {
  peakPrice: number;
  trailingArmed: boolean;
}

/**
 * Pure trigger evaluation — the entire exit policy of the auto-sell in one
 * testable function. Returns the exit reason, or null while the position
 * should keep running. `state` is updated in place (peak tracking).
 *
 * Priority order (first match wins): take-profit → stop-loss → trailing stop.
 * A null `price` (failed sample) never fires a price trigger.
 */
export function evaluateExitTrigger(
  trigger: AutoSellTrigger,
  state: TriggerState,
  params: {
    entryPriceSol: number;
    price: number | null;
    elapsedSeconds: number;
    graduated?: boolean;
  },
): string | null {
  const { price } = params;

  if (price !== null) {
    const multiple = price / params.entryPriceSol;

    if (trigger.takeProfitMultiplier !== undefined && multiple >= trigger.takeProfitMultiplier) {
      return `take profit hit (${multiple.toFixed(2)}x)`;
    }
    if (trigger.stopLossFraction !== undefined && multiple <= trigger.stopLossFraction) {
      return `stop loss hit (${multiple.toFixed(2)}x)`;
    }

    // Trailing stop: track the peak once armed; fire on drawdown from peak.
    if (trigger.trailingStopBps !== undefined) {
      const activation = trigger.trailingActivationMultiplier ?? 1.0;
      if (!state.trailingArmed && multiple >= activation) {
        state.trailingArmed = true;
        state.peakPrice = price;
      } else if (state.trailingArmed) {
        if (price > state.peakPrice) {
          state.peakPrice = price;
        }
        const floor = state.peakPrice * (1 - trigger.trailingStopBps / 10_000);
        if (price <= floor) {
          const drawdown = ((state.peakPrice - price) / state.peakPrice) * 100;
          return `trailing stop hit (${drawdown.toFixed(1)}% off peak ${state.peakPrice.toExponential(3)})`;
        }
      }
    }
  }

  if (trigger.timeoutSeconds !== undefined && params.elapsedSeconds > trigger.timeoutSeconds) {
    return 'timeout';
  }
  if (trigger.onGraduation && params.graduated) {
    return 'bonding curve graduated';
  }
  return null;
}

/**
 * Runs the auto-sell loop until a trigger fires or the stop predicate
 * returns true.
 */
export async function runAutoSell(ctx: DexContext, opts: AutoSellOptions): Promise<AutoSellReport> {
  const report: AutoSellReport = { sold: false, reason: '', checks: 0 };
  const mode = opts.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const startedAt = Date.now();
  const interval = opts.pollIntervalMs ?? 1_000;
  const maxChecks = opts.maxChecks ?? 100_000;

  let balance = opts.amountRaw;
  if (!balance) {
    const ata = await ctx.rpc.connection.getTokenAccountsByOwner(opts.wallet.publicKey, {
      mint: new PublicKey(opts.mint),
    });
    if (ata.value.length === 0) throw new Error('no token account to sell');
    balance = BigInt((await ctx.rpc.connection.getTokenAccountBalance(ata.value[0]!.pubkey)).value.amount);
  }

  const state: TriggerState = { peakPrice: opts.entryPriceSol, trailingArmed: false };
  let consecutiveSampleFailures = 0;

  for (;;) {
    if (opts.shouldStop?.()) {
      report.reason = 'aborted';
      return report;
    }
    if (++report.checks > maxChecks) {
      report.reason = 'max checks exceeded (safety guard)';
      break;
    }

    const price = await samplePrice(ctx, opts.mint, opts.venue);
    if (price === null) {
      // Exponential backoff on sample failures: protect the RPC and avoid
      // acting on stale state — never fire triggers while blind.
      consecutiveSampleFailures++;
      const backoff = Math.min(interval * 2 ** Math.min(consecutiveSampleFailures, 5), 60_000);
      log.warn({ consecutiveSampleFailures, backoffMs: backoff }, 'price sample failed; backing off');
      await sleep(backoff);
      continue;
    }
    consecutiveSampleFailures = 0;
    report.priceAtExit = price;

    let graduated: boolean | undefined;
    if (opts.trigger.onGraduation) {
      const curveInfo = await ctx.rpc.accountInfo(pumpBondingCurvePda(opts.mint).toBase58());
      if (curveInfo) {
        graduated = decodeBondingCurve(Buffer.from(curveInfo.data)).complete;
      }
    }

    const reason = evaluateExitTrigger(opts.trigger, state, {
      entryPriceSol: opts.entryPriceSol,
      price,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      graduated,
    });
    if (reason) {
      report.reason = reason;
      break;
    }

    await sleep(interval);
  }

  report.peakPrice = state.peakPrice;
  log.info({ reason: report.reason, price: report.priceAtExit, peak: report.peakPrice }, 'auto-sell trigger fired');

  const result = await executeSwap(ctx, {
    venue: opts.venue,
    user: opts.wallet,
    inputMint: opts.mint,
    outputMint: WSOL_MINT,
    amountInRaw: balance!,
    slippageBps: opts.slippageBps,
    mode,
    jito: true,
  });
  report.outcome = result.outcome;
  report.sold = true;
  return report;
}

/**
 * Samples the current SOL-per-token price for a mint.
 */
export async function samplePrice(
  ctx: DexContext,
  mint: string,
  venue: AutoSellOptions['venue'],
): Promise<number | null> {
  try {
    if (venue === 'pumpfun' || venue === 'pumpswap') {
      const curveInfo = await ctx.rpc.accountInfo(pumpBondingCurvePda(mint).toBase58());
      if (!curveInfo) return null;
      const curve = decodeBondingCurve(Buffer.from(curveInfo.data));
      // price = vSol / vToken (lamports per raw token), scaled to SOL/token.
      const raw = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
      return raw * 1e9; // SOL per whole token (9-decimals assumed curve math)
    }
    // Jupiter price API v3 (Lite).
    const res = await fetch(`${ctx.jupiterApiBase}/price/v3?ids=${mint}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, { price?: string }>;
    const entry = json[mint];
    return entry?.price ? Number(entry.price) : null;
  } catch (err) {
    log.debug({ err }, 'price sample failed');
    return null;
  }
}

export { PROGRAMS };
