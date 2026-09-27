/**
 * Real-time monitoring service — ties WebSocket subscriptions to decoded
 * on-chain state so lifecycle automation and the CLI can react to:
 *   - Pump.fun bonding-curve trades and graduations (logs + account changes)
 *   - Raydium / PumpSwap pool balance changes
 *   - Signature confirmations for dispatched transactions
 *   - Priority fee market conditions (periodic sampling)
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { MonitorEvent, PriorityFeeSample } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { SubscriptionManager } from '@solana-toolkit/rpc-client';
import type { DexContext } from './context.js';
import {
  decodeBondingCurve,
  decodePumpSwapPool,
  pumpAmmPoolPda,
  pumpBondingCurvePda,
  PROGRAMS,
  WSOL_MINT,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('monitor');

export interface CurveSnapshot {
  mint: string;
  virtualTokenReserves: string;
  virtualSolReserves: string;
  realTokenReserves: string;
  realSolReserves: string;
  complete: boolean;
  /** SOL per token (market price on the curve). */
  priceSolPerToken: number;
  capturedAt: string;
  /** Bonding-curve creator. Required to price the migrated PumpSwap pool. */
  creator?: string;
}

/**
 * Pull-based price read (no WebSocket): reads on-chain state through
 * ctx.rpc, so every call inherits the SolanaRpcClient failover pool and
 * the retry layer — unlike `watchPumpfunCurve`, whose subscription binds to
 * a single endpoint.
 *
 * MINT PATH HANDLING, kept clearly separated:
 *   - PATH 1 (pre-graduation): the Pump.fun bonding curve PDA holds virtual
 *     reserves; price = virtualSOL / virtualToken (lamports per raw token,
 *     scaled to SOL per whole token).
 *   - PATH 2 (post-graduation): the curve account is gone; the migrated
 *     PumpSwap pool's vault balances give the price instead.
 * Returns null when neither venue has state for the mint.
 */
export async function readCurvePrice(
  ctx: DexContext,
  mint: string,
  creator?: string,
): Promise<CurveSnapshot | null> {
  const capturedAt = new Date().toISOString();

  const curvePda = pumpBondingCurvePda(mint);
  const curveInfo = await ctx.rpc.accountInfo(curvePda.toBase58());
  if (curveInfo) {
    const curve = decodeBondingCurve(Buffer.from(curveInfo.data));
    if (!curve.complete) {
      const price = (Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves)) * 1e9;
      return {
        mint,
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        virtualSolReserves: curve.virtualSolReserves.toString(),
        realTokenReserves: curve.realTokenReserves.toString(),
        realSolReserves: curve.realSolReserves.toString(),
        complete: false,
        priceSolPerToken: price,
        capturedAt,
        creator: curve.creator,
      };
    }
    creator = curve.creator;
  }

  if (!creator) return null;
  const poolPda = pumpAmmPoolPda({
    index: 0,
    creator,
    baseMint: mint,
    quoteMint: WSOL_MINT,
  });
  const poolInfo = await ctx.rpc.accountInfo(poolPda.toBase58());
  if (!poolInfo) return null;
  const pool = decodePumpSwapPool(Buffer.from(poolInfo.data));
  const [baseVault, quoteVault] = await Promise.all([
    ctx.rpc.connection.getTokenAccountBalance(new PublicKey(pool.poolBaseTokenAccount)).catch(() => null),
    ctx.rpc.connection.getTokenAccountBalance(new PublicKey(pool.poolQuoteTokenAccount)).catch(() => null),
  ]);
  if (!baseVault || !quoteVault) return null;
  const baseReserves = BigInt(baseVault.value.amount);
  const quoteReserves = BigInt(quoteVault.value.amount);
  if (baseReserves === 0n) return null;
  const price = (Number(quoteReserves) / Number(baseReserves)) * 1e9;
  return {
    mint,
    virtualTokenReserves: baseReserves.toString(),
    virtualSolReserves: quoteReserves.toString(),
    realTokenReserves: baseReserves.toString(),
    realSolReserves: quoteReserves.toString(),
    complete: true,
    priceSolPerToken: price,
    capturedAt,
    creator,
  };
}

/**
 * Subscribes to a bonding curve account and calls `onChange` with a decoded
 * snapshot after every update.
 */
export async function watchPumpfunCurve(
  ctx: DexContext,
  mint: string,
  onChange: (snapshot: CurveSnapshot) => void,
): Promise<{ unsubscribe: () => Promise<void>; latest: () => CurveSnapshot | null }> {  const subs = new SubscriptionManager(ctx.rpc);
  let latest: CurveSnapshot | null = null;
  const curvePda = pumpBondingCurvePda(mint);
  const sub = await subs.subscribeAccount(curvePda.toBase58(), async (ev) => {
    void ev;
    try {
      const info = await ctx.rpc.accountInfo(curvePda.toBase58());
      if (!info) return;
      const curve = decodeBondingCurve(Buffer.from(info.data));
      const price = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves) * 1e9;
      latest = {
        mint,
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        virtualSolReserves: curve.virtualSolReserves.toString(),
        realTokenReserves: curve.realTokenReserves.toString(),
        realSolReserves: curve.realSolReserves.toString(),
        complete: curve.complete,
        priceSolPerToken: price,
        capturedAt: new Date().toISOString(),
      };
      onChange(latest);
    } catch (err) {
      log.debug({ err }, 'curve snapshot failed');
    }
  });
  void sub;
  return {
    unsubscribe: () => subs.unsubscribeAll(),
    latest: () => latest,
  };
}

/**
 * Subscribes to Pump.fun program logs and calls `onEvent` for every trade /
 * create / migrate event log line.
 */
export async function watchPumpfunProgram(
  ctx: DexContext,
  onEvent: (ev: MonitorEvent) => void,
): Promise<{ unsubscribe: () => Promise<void> }> {
  const subs = new SubscriptionManager(ctx.rpc);
  await subs.subscribeLogs(PROGRAMS.PUMPFUN, (ev) => {
    onEvent({ ...ev, receivedAt: new Date().toISOString() });
    for (const line of ev.logs ?? []) {
      if (line.includes('Instruction: Buy')) log.info({ mint: '(see logs)' }, 'pump buy observed');
    }
  });
  return { unsubscribe: () => subs.unsubscribeAll() };
}

/**
 * Starts the priority fee monitor and streams samples to the handler.
 */
export async function watchPriorityFees(
  ctx: DexContext,
  intervalMs: number,
  onSample: (sample: PriorityFeeSample) => void,
): Promise<{ unsubscribe: () => void }> {
  ctx.feeMonitor.onUpdate(onSample);
  ctx.feeMonitor.start(intervalMs, [PROGRAMS.TOKEN, PROGRAMS.RAYDIUM_AMM_V4]);
  return { unsubscribe: () => ctx.feeMonitor.stop() };
}

/**
 * Watches one signature until confirmation, then calls `onDone`.
 */
export async function watchSignature(
  ctx: DexContext,
  signature: string,
  onDone: (err: unknown) => void,
): Promise<{ unsubscribe: () => Promise<void> }> {
  const subs = new SubscriptionManager(ctx.rpc);
  await subs.subscribeSignature(signature, (ev) => onDone(ev.err));
  return { unsubscribe: () => subs.unsubscribeAll() };
}
