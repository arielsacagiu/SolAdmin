/**
 * Swap, market-making, and monitoring types.
 * @module
 */

import type { RuntimeMode } from './common.js';

/** Supported swap venues. */
export type SwapVenue =
  | 'jupiter'
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'pumpfun'
  | 'pumpswap'
  | 'moonit'
  | 'orca'
  | 'bonk';

/** A quoted swap. */
export interface SwapQuote {
  venue: SwapVenue;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  /** Price impact in basis points when known. */
  priceImpactBps?: number;
  /** Slippage basis points applied to min-out. */
  slippageBps: number;
  /** Venue-specific route payload (Jupiter plan, Raydium pool keys, ...). */
  routeData?: unknown;
}

/** Swap request. */
export interface SwapRequest {
  venue: SwapVenue;
  inputMint: string;
  outputMint: string;
  /** Amount in raw base units. */
  amountInRaw: bigint;
  /** Explicit min out; when omitted computed from quote + slippage. */
  minAmountOutRaw?: bigint;
  slippageBps: number;
  mode?: RuntimeMode;
}

/** Auto-sell trigger configuration. */
export interface AutoSellTrigger {
  /** Trigger on price multiple over entry (e.g. 2 = +100%). */
  takeProfitMultiplier?: number;
  /** Trigger on price fraction of entry (e.g. 0.5 = -50%). */
  stopLossFraction?: number;
  /**
   * Trailing stop: sell when price falls this many bps below the peak seen
   * since activation (e.g. 2000 = 20% drawdown from peak). The peak only
   * starts tracking once price >= entry * trailingActivationMultiplier
   * (default 1.0, i.e. immediately).
   */
  trailingStopBps?: number;
  /** Multiple of entry at which the trailing stop arms (default 1.0). */
  trailingActivationMultiplier?: number;
  /** Trigger after N seconds since start. */
  timeoutSeconds?: number;
  /** Trigger when bonding curve graduates (Pump.fun). */
  onGraduation?: boolean;
}

/** Market-maker batch swap configuration. */
export interface BatchSwapSpec {
  venue: SwapVenue;
  /** Buy/sell pairs executed round-robin. Each entry is one leg. */
  legs: {
    direction: 'buy' | 'sell';
    /** Raw token amount per leg. */
    amountRaw: bigint;
  }[];
  /** Milliseconds between legs. */
  intervalMs: number;
  /** Number of rounds. */
  rounds: number;
  /** Route through Jito bundles when true. */
  useJito: boolean;
}

/** Real-time priority fee sample. */
export interface PriorityFeeSample {
  slot: number;
  /** Micro-lamports per CU at the configured percentile. */
  microLamportsPerCu: number;
  /** Raw fee distribution samples. */
  samples: number[];
  fetchedAt: string;
}

/** Subscription kinds exposed by the monitoring service. */
export type SubscriptionKind =
  | 'logs'
  | 'account'
  | 'program'
  | 'signature'
  | 'slots'
  | 'root';

/** Monitoring event delivered to handlers. */
export interface MonitorEvent {
  kind: SubscriptionKind;
  /** Emitting subscription id. */
  subscription: number;
  slot?: number;
  signature?: string;
  publicKey?: string;
  logs?: string[];
  err?: unknown;
  data?: unknown;
  receivedAt: string;
}
