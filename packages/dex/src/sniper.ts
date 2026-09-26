/**
 * Jito bundle sniping / early-buy.
 *
 * Watches the Pump.fun program log stream for `CreateEvent`s; when a new coin
 * matches the configured filters (creator, name/symbol pattern, or any), the
 * sniper assembles a buy bundle (funding + buy + tip) and submits it through
 * the Jito block engine in the same or next slot.
 *
 * MEV NOTICE: sniping competes with other automated traders; success depends
 * on RPC latency, tip sizing and bundle ordering — never spend funds you
 * cannot afford to lose in failed auctions.
 * @module
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import type { SendOutcome } from '@solana-toolkit/types';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import { SubscriptionManager } from '@solana-toolkit/rpc-client';
import type { DexContext } from './context.js';
import { executeSwap } from './swap.js';
import { WSOL_MINT, decodeBondingCurve, pumpBondingCurvePda, PROGRAMS } from '@solana-toolkit/solana-programs';

const log = moduleLogger('sniper');

export interface SnipeFilters {
  /** Snipe only coins created by this address. */
  creator?: string;
  /** Regex applied to the coin name. */
  nameRegex?: string;
  /** Regex applied to the symbol. */
  symbolRegex?: string;
}

export interface SniperConfig {
  /** Buyer wallets (rotate per snipe). */
  buyers: Keypair[];
  /** SOL to spend per snipe (lamports). */
  buyLamports: bigint;
  slippageBps: number;
  filters: SnipeFilters;
  /** Stop after this many successful snipes (default 1). */
  maxSnipes?: number;
  mode?: 'simulate' | 'execute';
  /** How long to listen before giving up (ms). 0 = until maxSnipes/abort. */
  listenMs?: number;
  /** Abort predicate. */
  shouldStop?: () => boolean;
}

export interface SnipeTarget {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  detectedAt: string;
}

export interface SniperReport {
  targets: SnipeTarget[];
  outcomes: (SendOutcome | { signature: string; simulated: boolean })[];
}

/**
 * Extracts mint/name/symbol from a Pump.fun create log sequence.
 * CreateEvent is emitted as program logs with base64 data; the reliable
 * on-chain signal is the "Program log: Instruction: Create" marker followed
 * by the event, but account-level mint derivation is simpler: the bonding
 * curve PDA appears in the log context via the follow-up account fetch.
 * We parse the event bytes for the mint + name + symbol.
 */
export function parseCreateEvent(logs: string[]): SnipeTarget | null {
  // Anchor events are base64-encoded in "Program log: <base64>" lines. The
  // Pump.fun CreateEvent layout:
  //   8-byte event discriminator (144, 174, 88, 225, 202, 66, 189, 183)
  //   name: 32-byte fixed UTF-8 (Metaplex-style, no length prefix)
  //   symbol: 10 bytes
  //   uri: 200 bytes
  //   mint: 32 bytes pubkey
  //   bonding curve: 32 bytes
  //   user: 32 bytes
  const disc = [144, 174, 88, 225, 202, 66, 189, 183];
  for (const line of logs) {
    const m = line.match(/^Program log: ([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    let data: Buffer;
    try {
      data = Buffer.from(m[1]!, 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 + 32 + 10 + 200 + 32) continue;
    if (!disc.every((b, i) => data[i] === b)) continue;
    let o = 8;
    const name = data.subarray(o, o + 32).toString('utf8').replace(/\0+$/, '');
    o += 32;
    const symbol = data.subarray(o, o + 10).toString('utf8').replace(/\0+$/, '');
    o += 10;
    const uri = data.subarray(o, o + 200).toString('utf8').replace(/\0+$/, '');
    o += 200;
    const mint = new PublicKey(data.subarray(o, o + 32)).toBase58();
    o += 32;
    const bondingCurve = new PublicKey(data.subarray(o, o + 32)).toBase58();
    o += 32;
    const user = new PublicKey(data.subarray(o, o + 32)).toBase58();
    return { mint, name, symbol, uri, creator: user, detectedAt: new Date().toISOString() };
  }
  return null;
}

/**
 * Runs the sniper until maxSnipes/timeout/abort.
 */
export async function runPumpfunSniper(ctx: DexContext, config: SniperConfig): Promise<SniperReport> {
  const report: SniperReport = { targets: [], outcomes: [] };
  const subs = new SubscriptionManager(ctx.rpc);
  const mode = config.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const maxSnipes = config.maxSnipes ?? 1;
  const deadline = config.listenMs ? Date.now() + config.listenMs : 0;
  let nameRegex: RegExp | null = null;
  let symbolRegex: RegExp | null = null;
  if (config.filters.nameRegex) {
    try { nameRegex = new RegExp(config.filters.nameRegex); } catch { log.warn('invalid name regex; ignoring'); }
  }
  if (config.filters.symbolRegex) {
    try { symbolRegex = new RegExp(config.filters.symbolRegex); } catch { log.warn('invalid symbol regex; ignoring'); }
  }

  let snipes = 0;
  let buyerIdx = 0;

  await subs.subscribeLogs(PROGRAMS.PUMPFUN, async (ev) => {
    if (!ev.logs) return;
    if (!ev.logs.some((l) => l.includes('Instruction: Create'))) return;
    const target = parseCreateEvent(ev.logs);
    if (!target) return;
    if (config.filters.creator && target.creator !== config.filters.creator) return;
    if (nameRegex && !nameRegex.test(target.name)) return;
    if (symbolRegex && !symbolRegex.test(target.symbol)) return;
    if (report.targets.some((t) => t.mint === target.mint)) return;

    log.info({ mint: target.mint, name: target.name, symbol: target.symbol }, 'SNIPE TARGET DETECTED');
    report.targets.push(target);

    const buyer = config.buyers[buyerIdx++ % config.buyers.length]!;
    try {
      const result = await executeSwap(ctx, {
        venue: 'pumpfun',
        user: buyer,
        inputMint: WSOL_MINT,
        outputMint: target.mint,
        amountInRaw: config.buyLamports,
        slippageBps: config.slippageBps,
        mode,
        jito: true,
      });
      report.outcomes.push(result.outcome);
      snipes++;
    } catch (err) {
      log.error({ err, mint: target.mint }, 'snipe buy failed');
    }
  });

  log.info('sniper listening on Pump.fun create events');
  while (snipes < maxSnipes) {
    if (config.shouldStop?.()) break;
    if (deadline && Date.now() > deadline) break;
    await sleep(500);
  }
  await subs.unsubscribeAll();
  log.info({ snipes }, 'sniper finished');
  return report;
}

/**
 * Early-buy helper: buy an existing (already-created) coin immediately via
 * Jito, after verifying the curve exists and is not complete.
 */
export async function earlyBuy(
  ctx: DexContext,
  params: { buyer: Keypair; mint: string; buyLamports: bigint; slippageBps: number; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome | { signature: string; simulated: boolean }> {
  const curveInfo = await ctx.rpc.accountInfo(pumpBondingCurvePda(params.mint).toBase58());
  if (!curveInfo) throw new Error('no bonding curve for mint');
  const curve = decodeBondingCurve(Buffer.from(curveInfo.data));
  if (curve.complete) {
    log.warn({ mint: params.mint }, 'curve already graduated — buying on PumpSwap route instead');
  }
  const result = await executeSwap(ctx, {
    venue: curve.complete ? 'pumpswap' : 'pumpfun',
    user: params.buyer,
    inputMint: WSOL_MINT,
    outputMint: params.mint,
    amountInRaw: params.buyLamports,
    slippageBps: params.slippageBps,
    mode: params.mode,
    jito: true,
  });
  return result.outcome;
}
