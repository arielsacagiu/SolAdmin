/**
 * Real-time monitoring service — ties WebSocket subscriptions to decoded
 * on-chain state so lifecycle automation and the CLI can react to:
 *   - Pump.fun bonding-curve trades and graduations (logs + account changes)
 *   - Raydium / PumpSwap pool balance changes
 *   - Signature confirmations for dispatched transactions
 *   - Priority fee market conditions (periodic sampling)
 * @module
 */

import type { MonitorEvent, PriorityFeeSample } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { SubscriptionManager } from '@solana-toolkit/rpc-client';
import type { DexContext } from './context.js';
import { decodeBondingCurve, pumpBondingCurvePda, PROGRAMS } from '@solana-toolkit/solana-programs';

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
}

/**
 * Subscribes to a bonding curve account and calls `onChange` with a decoded
 * snapshot after every update.
 */
export async function watchPumpfunCurve(
  ctx: DexContext,
  mint: string,
  onChange: (snapshot: CurveSnapshot) => void,
): Promise<{ unsubscribe: () => Promise<void>; latest: () => CurveSnapshot | null }> {
  const subs = new SubscriptionManager(ctx.rpc);
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
