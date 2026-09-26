/**
 * Volume-bot configuration schema: parsed from YAML/JSON, validated eagerly.
 * All lamports values are strings in the file (bigint-safe) and normalized
 * here to bigint.
 * @module
 */

import type { PriorityFeeConfig } from '@solana-toolkit/types';
import type { VenueKind } from '@solana-toolkit/venues';
import { parseConfigFile } from '@solana-toolkit/utils';

/** How a single wallet's round trip is dispatched. */
export type RoundTripExecution = 'intra-tx' | 'bundle';

export interface VolumeBotWalletsConfig {
  /**
   * Explicit keystore file paths (soladmin-keystore envelopes or legacy
   * Solana CLI arrays — the latter emit warnings when loaded).
   */
  keystorePaths?: string[];
  /** Directory scanned for *.json keystores when keystorePaths is empty. */
  keystoreDir?: string;
  /** Cap on pool size; excess keystores are ignored. */
  maxWallets?: number;
}

export interface VolumeBotSchedule {
  /** Total buy+sell round trips to attempt (across all wallets). */
  rounds: number;
  /** Wallets used per round. With execution=bundle this is the bundle size. */
  walletsPerRound: number;
  /** Base delay between rounds, ms. */
  intervalMs: number;
  /** Random extra delay 0..jitterMs added to each interval. */
  jitterMs?: number;
}

export interface VolumeBotBudget {
  /** Hard cap on cumulative net SOL cost (buy-side spend minus sell return, estimated). */
  maxNetCostLamports: bigint;
  /** Hard cap on cumulative gross notional pushed through the venue (lamports). */
  maxVolumeLamports?: bigint;
  /** Optional per-wallet lamports ceiling for a single round trip. */
  maxPerWalletLamports?: bigint;
}

export interface VolumeBotUnwind {
  /** After the run, sell any residual token balance held by pool wallets. */
  sellResidualTokens: boolean;
  /** Sweep remaining SOL from pool wallets to this address (or the funder). */
  consolidateTo?: string;
  /** Lamports to leave in each wallet after consolidation (rent buffer). */
  leaveLamports: bigint;
}

/** Normalized volume-bot configuration. */
export interface VolumeBotConfig {
  /** Venue to trade on; 'auto' probes pump.fun → pumpswap → launchlab → cpmm → jupiter. */
  venue: VenueKind;
  /** Token mint to volume (paired against SOL/WSOL). */
  mint: string;
  wallets: VolumeBotWalletsConfig;
  /** Keystore that funds pool wallets and pays Jito tips when bundleTipFromFunder. */
  funderKeystore?: string;
  /**
   * SOL size per round trip (lamports). `min`/`max` define a uniform random
   * range each round; equal values = fixed size.
   */
  tradeLamports: { min: bigint; max: bigint };
  slippageBps: number;
  schedule: VolumeBotSchedule;
  /**
   * intra-tx: buy+sell in ONE transaction (atomic, zero exposure window).
   * bundle:  one round-trip tx per wallet, all in one Jito bundle (one slot).
   */
  execution: RoundTripExecution;
  /** Dispatch channel: plain RPC, Jito tx relay, or Jito bundle of txs. */
  dispatch: 'rpc' | 'jito-tx' | 'jito-bundle';
  /** Pay the Jito bundle tip from the funder keystore (default: last wallet pays). */
  bundleTipFromFunder: boolean;
  budget: VolumeBotBudget;
  unwind: VolumeBotUnwind;
  /** Per-send priority fee override. */
  priorityFee?: PriorityFeeConfig;
  /** Explicit CPMM pool address override (skips pool discovery). */
  cpmmPoolAddress?: string;
  /** share_fee_rate forwarded to LaunchLab swaps (ppm, default 0). */
  launchlabShareFeeRate?: bigint;
}

function num(v: unknown, name: string, { min, max }: { min?: number; max?: number } = {}): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) throw new Error(`config: "${name}" must be a number, got ${JSON.stringify(v)}`);
  if (min !== undefined && n < min) throw new Error(`config: "${name}" must be >= ${min}`);
  if (max !== undefined && n > max) throw new Error(`config: "${name}" must be <= ${max}`);
  return n;
}

function bigintField(v: unknown, name: string, { min }: { min?: bigint } = {}): bigint {
  let n: bigint;
  try {
    n = typeof v === 'bigint' ? v : BigInt(String(v));
  } catch {
    throw new Error(`config: "${name}" must be an integer (lamports), got ${JSON.stringify(v)}`);
  }
  if (min !== undefined && n < min) throw new Error(`config: "${name}" must be >= ${min}`);
  return n;
}

const VENUES = new Set(['pumpfun', 'pumpswap', 'launchlab', 'cpmm', 'jupiter', 'auto']);
const EXECUTIONS = new Set(['intra-tx', 'bundle']);
const DISPATCHES = new Set(['rpc', 'jito-tx', 'jito-bundle']);

/**
 * Validates a raw parsed YAML/JSON object into a VolumeBotConfig.
 * Throws with a descriptive message on the first hard error.
 */
export function parseVolumeBotConfig(raw: unknown): VolumeBotConfig {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== 'object') throw new Error('volume-bot config must be an object');

  const venue = String(c['venue'] ?? 'auto');
  if (!VENUES.has(venue)) throw new Error(`config: "venue" must be one of ${[...VENUES].join(', ')}`);

  const mint = String(c['mint'] ?? '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new Error('config: "mint" must be a base58 public key');
  }

  const w = (c['wallets'] ?? {}) as Record<string, unknown>;
  const keystorePaths = Array.isArray(w['keystorePaths'])
    ? (w['keystorePaths'] as unknown[]).map(String)
    : undefined;
  const wallets: VolumeBotWalletsConfig = {
    keystorePaths,
    keystoreDir: w['keystoreDir'] !== undefined ? String(w['keystoreDir']) : undefined,
    maxWallets: w['maxWallets'] !== undefined ? num(w['maxWallets'], 'wallets.maxWallets', { min: 1 }) : undefined,
  };
  if (!keystorePaths?.length && !wallets.keystoreDir) {
    throw new Error('config: "wallets" needs keystorePaths or keystoreDir');
  }

  const trade = (c['tradeLamports'] ?? {}) as Record<string, unknown>;
  const tradeMin = bigintField(trade['min'] ?? trade['size'] ?? '0', 'tradeLamports.min', { min: 1n });
  const tradeMax = bigintField(trade['max'] ?? trade['size'] ?? trade['min'], 'tradeLamports.max', { min: tradeMin });
  if (tradeMax < tradeMin) throw new Error('config: tradeLamports.max must be >= min');

  const sched = (c['schedule'] ?? {}) as Record<string, unknown>;
  const schedule: VolumeBotSchedule = {
    rounds: num(sched['rounds'] ?? 1, 'schedule.rounds', { min: 1 }),
    walletsPerRound: num(sched['walletsPerRound'] ?? 1, 'schedule.walletsPerRound', { min: 1 }),
    intervalMs: num(sched['intervalMs'] ?? 0, 'schedule.intervalMs', { min: 0 }),
    jitterMs: sched['jitterMs'] !== undefined ? num(sched['jitterMs'], 'schedule.jitterMs', { min: 0 }) : undefined,
  };

  const execution = String(c['execution'] ?? 'intra-tx');
  if (!EXECUTIONS.has(execution)) throw new Error(`config: "execution" must be ${[...EXECUTIONS].join(' | ')}`);
  const dispatch = String(c['dispatch'] ?? (execution === 'bundle' ? 'jito-bundle' : 'rpc'));
  if (!DISPATCHES.has(dispatch)) throw new Error(`config: "dispatch" must be ${[...DISPATCHES].join(' | ')}`);
  if (execution === 'bundle' && dispatch !== 'jito-bundle') {
    throw new Error('config: execution "bundle" requires dispatch "jito-bundle"');
  }

  const b = (c['budget'] ?? {}) as Record<string, unknown>;
  const budget: VolumeBotBudget = {
    maxNetCostLamports: bigintField(b['maxNetCostLamports'] ?? '0', 'budget.maxNetCostLamports', { min: 0n }),
    maxVolumeLamports: b['maxVolumeLamports'] !== undefined ? bigintField(b['maxVolumeLamports'], 'budget.maxVolumeLamports', { min: 0n }) : undefined,
    maxPerWalletLamports: b['maxPerWalletLamports'] !== undefined ? bigintField(b['maxPerWalletLamports'], 'budget.maxPerWalletLamports', { min: 1n }) : undefined,
  };
  if (budget.maxNetCostLamports === 0n) {
    throw new Error('config: "budget.maxNetCostLamports" is required (set an explicit loss cap, even in simulation)');
  }

  const u = (c['unwind'] ?? {}) as Record<string, unknown>;
  const unwind: VolumeBotUnwind = {
    sellResidualTokens: u['sellResidualTokens'] !== false,
    consolidateTo: u['consolidateTo'] !== undefined ? String(u['consolidateTo']) : undefined,
    leaveLamports: bigintField(u['leaveLamports'] ?? '0', 'unwind.leaveLamports', { min: 0n }),
  };

  const cfg: VolumeBotConfig = {
    venue: venue as VenueKind,
    mint,
    wallets,
    funderKeystore: c['funderKeystore'] !== undefined ? String(c['funderKeystore']) : undefined,
    tradeLamports: { min: tradeMin, max: tradeMax },
    slippageBps: num(c['slippageBps'] ?? 300, 'slippageBps', { min: 0, max: 10_000 }),
    schedule,
    execution: execution as RoundTripExecution,
    dispatch: dispatch as VolumeBotConfig['dispatch'],
    bundleTipFromFunder: c['bundleTipFromFunder'] === true,
    budget,
    unwind,
    cpmmPoolAddress: c['cpmmPoolAddress'] !== undefined ? String(c['cpmmPoolAddress']) : undefined,
    launchlabShareFeeRate: c['launchlabShareFeeRate'] !== undefined ? bigintField(c['launchlabShareFeeRate'], 'launchlabShareFeeRate', { min: 0n }) : undefined,
  };

  const pf = c['priorityFee'] as Record<string, unknown> | undefined;
  if (pf && typeof pf === 'object') {
    cfg.priorityFee = {
      computeUnitLimit: pf['computeUnitLimit'] !== undefined ? num(pf['computeUnitLimit'], 'priorityFee.computeUnitLimit', { min: 0 }) : undefined,
      microLamportsPerCu: pf['microLamportsPerCu'] !== undefined ? num(pf['microLamportsPerCu'], 'priorityFee.microLamportsPerCu', { min: 0 }) : undefined,
      dynamic: pf['dynamic'] === true ? true : undefined,
      percentile: pf['percentile'] !== undefined ? num(pf['percentile'], 'priorityFee.percentile', { min: 1, max: 100 }) : undefined,
      maxMicroLamportsPerCu: pf['maxMicroLamportsPerCu'] !== undefined ? num(pf['maxMicroLamportsPerCu'], 'priorityFee.maxMicroLamportsPerCu', { min: 0 }) : undefined,
      jitoTipLamports: pf['jitoTipLamports'] !== undefined ? num(pf['jitoTipLamports'], 'priorityFee.jitoTipLamports', { min: 0 }) : undefined,
    };
  }
  return cfg;
}

/** Loads and validates a YAML/JSON volume-bot config file. */
export function loadVolumeBotConfig(file: string): VolumeBotConfig {
  return parseVolumeBotConfig(parseConfigFile(file));
}
