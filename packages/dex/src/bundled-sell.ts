/**
 * Bundled Sell Token — coordinated multi-wallet exit.
 *
 * Two production architectures (verified against current bundled-sell tools
 * and the Jito rules in docs/anti-mev-volume-bot.md):
 *
 *  - PARALLEL: every wallet sells its own bag as its own transaction; legs
 *    are grouped into atomic Jito bundles (≤5 txs, sequential, same-slot,
 *    all-or-nothing). Slippage is spread across N smaller sells.
 *  - COLLECT-THEN-SELL: all wallets first transfer their tokens to one
 *    concentrator wallet, and the concentrator sells everything — the
 *    collects and the sell land in ONE bundle (single block). This is the
 *    pattern used by production Pump.fun bundle-sell tools; it concentrates
 *    the exit into a single market order.
 *
 * MEV protection (per Jito DontFront + bundle rules):
 *  - every bundle's FIRST leg carries a `jitodontfront` marker, so no other
 *    bundle may be ordered before it;
 *  - the tip rides inline in the FINAL leg of each bundle (Jito guidance:
 *    standalone tip transactions invite uncle-bandit risk);
 *  - bundles are chunked to Jito's hard 5-transaction limit — each chunk is
 *    atomic within itself; chunks are submitted sequentially and each is
 *    re-quoted fresh, so a failed chunk never poisons the rest;
 *  - every leg is pre-flight simulated by the sender before submission.
 *
 * All amounts are re-read from the chain at build time (ATA balances), so a
 * wallet that received a partial transfer or was already drained simply
 * contributes what it actually holds.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SendOutcome } from '@solana-toolkit/types';
import { chunk, moduleLogger, sleep } from '@solana-toolkit/utils';
import type { TransactionRequest } from '@solana-toolkit/transaction-builder';
import { dontFrontMarkerInstruction } from '@solana-toolkit/transaction-builder';
import type { DexContext } from './context.js';
import { buildSellLeg } from './volume-bot.js';

const log = moduleLogger('bundled-sell');

/** Jito hard limit on transactions per bundle (docs.jito.wtf). */
export const JITO_BUNDLE_MAX_TXS = 5;

export type BundledSellMode = 'parallel' | 'collect-then-sell';

export interface BundledSellOptions {
  /** Wallets holding the token to exit (each signs its own leg). */
  wallets: Keypair[];
  /** Wallet that sells the concentrated amount in collect-then-sell mode.
   *  Defaults to wallets[0]. */
  concentrator?: Keypair;
  /** Token mint to sell (paired against SOL). */
  mint: string;
  /** 'parallel' (default): each wallet sells its own balance.
   *  'collect-then-sell': concentrate into `concentrator`, then one sell. */
  mode?: BundledSellMode;
  /** Swap venue for the sell legs. */
  venue: 'pumpfun' | 'pumpswap' | 'raydium-amm-v4' | 'jupiter';
  slippageBps: number;
  /** Static tip per bundle (lamports). When omitted, tips are sized from
   *  Jito's landed-tip percentile feed at the 75th percentile. */
  tipLamports?: bigint;
  /** Landed-tip percentile used when `tipLamports` is omitted. */
  tipPercentile?: 25 | 50 | 75 | 95 | 99;
  /** Sell the FULL ATA balance per wallet (default) or a fixed raw amount. */
  amountPerWalletRaw?: bigint;
  mode_runtime?: 'simulate' | 'execute';
  /** Abort predicate checked between chunks. */
  shouldStop?: () => boolean;
  /** Pause between sequential chunks in ms (default 1000; only relevant when
   *  the wallet count forces multiple bundles). */
  chunkDelayMs?: number;
}

export interface BundledSellReport {
  mode: BundledSellMode;
  /** Bundles submitted (one per chunk; collect-then-sell is always 1). */
  bundles: number;
  /** Bundles that landed (execute mode) or simulated cleanly. */
  landed: number;
  failed: number;
  /** Wallets that were included with a non-zero sell balance. */
  walletsSold: number;
  /** Total token amount sold (raw units). */
  tokensSoldRaw: bigint;
  /** Total tips paid or that would be paid (lamports). */
  tipsPaidLamports: bigint;
  outcomes: SendOutcome[];
  /** Per-wallet detail for auditability. */
  legs: { wallet: string; amountRaw: string; included: boolean }[];
}

/**
 * Pure chunking policy: legs are grouped so that a chunk never exceeds
 * Jito's 5-transaction limit. Exported for unit tests.
 */
export function chunkLegs<T>(legs: T[], maxPerBundle = JITO_BUNDLE_MAX_TXS): T[][] {
  if (maxPerBundle < 1) throw new Error('maxPerBundle must be >= 1');
  return chunk(legs, maxPerBundle);
}

/**
 * Pure layout policy for collect-then-sell: collects + the final sell must
 * fit in one bundle (≤5 txs). Returns how many source wallets can be served
 * by a single atomic collect-then-sell bundle.
 */
export function maxCollectSourcesPerBundle(maxPerBundle = JITO_BUNDLE_MAX_TXS): number {
  return Math.max(0, maxPerBundle - 1);
}

/** Reads a wallet's token ATA balance (raw units); 0n when no account. */
async function ataBalance(
  ctx: DexContext,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, wallet, true, tokenProgram);
  try {
    const res = await ctx.rpc.connection.getTokenAccountBalance(ata);
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

async function detectTokenProgram(ctx: DexContext, mint: string): Promise<PublicKey> {
  const info = await ctx.rpc.accountInfo(mint);
  if (!info) throw new Error(`mint ${mint} not found`);
  return info.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

async function resolveTip(ctx: DexContext, opts: BundledSellOptions): Promise<bigint> {
  if (opts.tipLamports !== undefined) return opts.tipLamports;
  return ctx.jito.recommendedTipLamports(opts.tipPercentile ?? 75, {});
}

/**
 * Bundled Sell Token.
 *
 * PARALLEL mode: wallets are chunked into atomic Jito bundles; within each
 * bundle every wallet sells its own (freshly read) balance. The first leg
 * carries the DontFront marker; the tip rides inline on the last leg.
 *
 * COLLECT-THEN-SELL mode: source wallets transfer their full balance to the
 * concentrator, and the concentrator sells everything — all collects plus
 * the sell in ONE bundle (sources beyond the 5-tx budget are skipped with a
 * warning rather than silently splitting the atomicity guarantee).
 */
export async function bundledSell(ctx: DexContext, opts: BundledSellOptions): Promise<BundledSellReport> {
  const mode = opts.mode ?? 'parallel';
  const runtimeMode = opts.mode_runtime ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  if (opts.wallets.length === 0) throw new Error('bundled sell needs at least one wallet');

  const mintPk = new PublicKey(opts.mint);
  const tokenProgram = await detectTokenProgram(ctx, opts.mint);
  const tipLamports = await resolveTip(ctx, opts);

  const report: BundledSellReport = {
    mode,
    bundles: 0,
    landed: 0,
    failed: 0,
    walletsSold: 0,
    tokensSoldRaw: 0n,
    tipsPaidLamports: 0n,
    outcomes: [],
    legs: [],
  };

  // ---- Read every wallet's real balance up front (audit trail) ----
  const balances = new Map<string, bigint>();
  for (const wallet of opts.wallets) {
    const bal = opts.amountPerWalletRaw ?? (await ataBalance(ctx, wallet.publicKey, mintPk, tokenProgram));
    balances.set(wallet.publicKey.toBase58(), bal);
    report.legs.push({
      wallet: wallet.publicKey.toBase58(),
      amountRaw: bal.toString(),
      included: bal > 0n,
    });
  }

  if (mode === 'collect-then-sell') {
    return collectThenSell(ctx, opts, {
      mint: mintPk,
      tokenProgram,
      tipLamports,
      balances,
      report,
      runtimeMode,
    });
  }

  // ---------------- PARALLEL: chunked atomic sells ----------------
  const activeWallets = opts.wallets.filter((w) => (balances.get(w.publicKey.toBase58()) ?? 0n) > 0n);
  if (activeWallets.length === 0) {
    log.warn('no wallet holds a non-zero balance — nothing to sell');
    return report;
  }

  const groups = chunkLegs(activeWallets);
  log.info({ wallets: activeWallets.length, bundles: groups.length, mode }, 'parallel bundled sell planned');

  for (const [gi, group] of groups.entries()) {
    if (opts.shouldStop?.()) {
      log.info('stop signal received between chunks');
      break;
    }
    const legs: TransactionRequest[] = [];
    let chunkTokens = 0n;
    for (const [li, wallet] of group.entries()) {
      const amountRaw = balances.get(wallet.publicKey.toBase58())!;
      const ixs = await buildSellLeg(ctx, wallet, {
        venue: opts.venue,
        mint: opts.mint,
        sellAmountRaw: amountRaw,
        slippageBps: opts.slippageBps,
      });
      // First leg of the bundle carries the DontFront marker; the last leg
      // carries the inline tip (Jito ordering + tip-placement guidance).
      legs.push({
        description: `bundled sell ${wallet.publicKey.toBase58().slice(0, 6)} (${amountRaw.toString()} raw)`,
        feePayer: wallet.publicKey.toBase58(),
        instructions: li === 0 ? [...ixs, dontFrontMarkerInstruction()] : ixs,
        signers: [wallet] as never[],
        jitoTipLamports: li === group.length - 1 ? tipLamports : undefined,
      });
      chunkTokens += amountRaw;
    }

    try {
      const outcome = await ctx.sender.sendBundle(legs, { mode: runtimeMode });
      report.outcomes.push(outcome);
      report.bundles++;
      report.tipsPaidLamports += tipLamports;
      const ok = outcome.simulated
        ? !outcome.warnings.some((w) => w.includes('failed'))
        : outcome.bundleStatus === undefined || outcome.bundleStatus === 'Landed';
      if (ok) {
        report.landed++;
        report.walletsSold += group.length;
        report.tokensSoldRaw += chunkTokens;
        log.info({ chunk: gi + 1, bundleId: outcome.bundleId }, 'sell chunk landed');
      } else {
        report.failed++;
        log.warn({ chunk: gi + 1, status: outcome.bundleStatus }, 'sell chunk did not land');
      }
    } catch (err) {
      report.failed++;
      log.error({ err, chunk: gi + 1 }, 'sell chunk submission failed');
    }

    if (gi < groups.length - 1 && opts.chunkDelayMs !== 0) {
      await sleep(opts.chunkDelayMs ?? 1_000);
    }
  }

  return report;
}

/**
 * Collect-then-sell internals: all collects + one sell in a single bundle.
 * Sources beyond the single-bundle budget are skipped (explicitly reported)
 * so the exit stays atomic — splitting into multiple bundles would defeat
 * the single-block guarantee that justifies this mode.
 */
async function collectThenSell(
  ctx: DexContext,
  opts: BundledSellOptions,
  deps: {
    mint: PublicKey;
    tokenProgram: PublicKey;
    tipLamports: bigint;
    balances: Map<string, bigint>;
    report: BundledSellReport;
    runtimeMode: 'simulate' | 'execute';
  },
): Promise<BundledSellReport> {
  const { mint, tokenProgram, tipLamports, balances, report, runtimeMode } = deps;
  const concentrator = opts.concentrator ?? opts.wallets[0]!;
  const concentratorAddr = concentrator.publicKey.toBase58();

  const sources = opts.wallets.filter((w) => {
    const addr = w.publicKey.toBase58();
    return addr !== concentratorAddr && (balances.get(addr) ?? 0n) > 0n;
  });

  const budget = maxCollectSourcesPerBundle();
  const served = sources.slice(0, budget);
  const skipped = sources.slice(budget);
  if (skipped.length > 0) {
    report.legs = report.legs.map((leg) =>
      skipped.some((w) => w.publicKey.toBase58() === leg.wallet) ? { ...leg, included: false } : leg,
    );
    log.warn(
      { skipped: skipped.length, budget },
      'collect-then-sell is single-bundle atomic; extra source wallets skipped (run again or use parallel mode)',
    );
  }

  const concentratorAta = getAssociatedTokenAddressSync(mint, concentrator.publicKey, true, tokenProgram);
  const legs: TransactionRequest[] = [];
  let collected = 0n;

  for (const [i, source] of served.entries()) {
    const amountRaw = opts.amountPerWalletRaw ?? balances.get(source.publicKey.toBase58())!;
    const sourceAta = getAssociatedTokenAddressSync(mint, source.publicKey, true, tokenProgram);
    const transferIx: TransactionInstruction = createTransferInstruction(
      sourceAta,
      concentratorAta,
      source.publicKey,
      amountRaw,
      [],
      tokenProgram,
    );
    legs.push({
      description: `collect ${source.publicKey.toBase58().slice(0, 6)} → concentrator`,
      feePayer: source.publicKey.toBase58(),
      instructions: i === 0 ? [transferIx, dontFrontMarkerInstruction()] : [transferIx],
      signers: [source] as never[],
    });
    collected += amountRaw;
  }

  // Freshly read the concentrator balance so the sell covers what it held
  // BEFORE this bundle too (pre-existing bags), not just the collects.
  const concentratorExisting = await ataBalance(ctx, concentrator.publicKey, mint, tokenProgram);
  const sellAmount = concentratorExisting + collected;
  if (sellAmount <= 0n) {
    log.warn('nothing to sell after collection');
    return report;
  }

  const sellIxs = await buildSellLeg(ctx, concentrator, {
    venue: opts.venue,
    mint: opts.mint,
    sellAmountRaw: sellAmount,
    slippageBps: opts.slippageBps,
  });
  legs.push({
    description: `concentrated sell ${concentratorAddr.slice(0, 6)} (${sellAmount.toString()} raw)`,
    feePayer: concentratorAddr,
    instructions: served.length === 0 ? [...sellIxs, dontFrontMarkerInstruction()] : sellIxs,
    signers: [concentrator] as never[],
    jitoTipLamports: tipLamports,
  });

  report.bundles = 1;
  try {
    const outcome = await ctx.sender.sendBundle(legs, { mode: runtimeMode });
    report.outcomes.push(outcome);
    report.tipsPaidLamports = tipLamports;
    const ok = outcome.simulated
      ? !outcome.warnings.some((w) => w.includes('failed'))
      : outcome.bundleStatus === undefined || outcome.bundleStatus === 'Landed';
    if (ok) {
      report.landed = 1;
      report.walletsSold = served.length + 1;
      report.tokensSoldRaw = sellAmount;
      log.info({ bundleId: outcome.bundleId, sellAmount: sellAmount.toString() }, 'collect-then-sell landed');
    } else {
      report.failed = 1;
      log.warn({ status: outcome.bundleStatus }, 'collect-then-sell did not land');
    }
  } catch (err) {
    report.failed = 1;
    log.error({ err }, 'collect-then-sell submission failed');
  }

  return report;
}
