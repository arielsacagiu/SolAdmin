/**
 * Anti-MEV Volume Bot + Bundled Buy/Sell.
 *
 * MEV model (researched against docs.jito.wtf and the Solana MEV-protection
 * guide): a sandwich attacker lands `[frontrun, victim, backrun]` inside one
 * Jito bundle, exploiting the victim's price impact. Two properties of Jito
 * bundles neutralize this for our own pairs:
 *
 *   1. ATOMICITY — a bundle is all-or-nothing and executes within a single
 *      slot (bundles cannot cross slot boundaries), and its transactions
 *      execute in the listed order. Submitting `buy → sell` as one bundle
 *      leaves no slot boundary between the legs, so no third-party
 *      transaction can be inserted between them.
 *   2. DONTFRONT — adding a `jitodontfront…` marker account to a transaction
 *      forces it to bundle index 0 (the block engine rejects any bundle
 *      that would place another transaction before it). Relayed via
 *      sendTransaction, no one else's bundle can front-run it either.
 *
 * Pair modes (`pairMode`):
 *   - 'atomic-bundle' (default): [buy(dontfront), sell(+inline tip)] in ONE
 *     Jito bundle — same slot, all-or-nothing. This is the anti-MEV mode.
 *   - 'intra-tx': buy and sell as two swaps inside a single transaction —
 *     zero inter-leg exposure, but some venues restrict same-tx round
 *     trips (the pre-flight simulation will surface those).
 *   - 'separated': buy and sell land in different slots with a randomized
 *     delay. Looks the most like organic flow, but the legs are MEV-exposed
 *     between slots; dontfront markers on each leg provide partial cover.
 *
 * Detection-economics note: round trips inside one slot are trivially
 * identifiable as non-organic flow. Choose atomic modes for MEV defence on
 * your own inventory, separated mode for natural-looking patterns, and read
 * the README before using this on assets you do not control.
 *
 * Tip sizing: Jito runs bundle auctions at 50ms ticks and enforces a minimum
 * tip of 1000 lamports; too-low tips lose auctions. `tipMode: 'tip-floor'`
 * sizes tips from Jito's public landed-tip percentile feed
 * (https://bundles.jito.wtf/api/v1/bundles/tip_floor). Per Jito guidance the
 * tip instruction rides inside the final leg transaction (standalone tip
 * transactions invite uncle-bandit risk), and priority fees are kept minimal
 * because only the tip matters for bundles.
 *
 * SAFETY: every bundle carries a tip; simulation mode is the default like
 * everywhere else in the toolkit.
 * @module
 */

import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  type AccountMeta,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SendOutcome, SwapVenue } from '@solana-toolkit/types';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import type { TransactionRequest } from '@solana-toolkit/transaction-builder';
import { dontFrontMarkerInstruction } from '@solana-toolkit/transaction-builder';
import type { DexContext } from './context.js';
import { jupiterSwapPlan } from './jupiter.js';
import {
  PROGRAMS,
  WSOL_MINT,
  ammV4QuoteOut,
  ammV4SwapSimpleInInstruction,
  decodeBondingCurve,
  deriveAmmV4PoolKeys,
  fetchRaydiumPoolsByMints,
  pumpAmmPoolPda,
  pumpBondingCurvePda,
  pumpBuyInstruction,
  pumpSellInstruction,
  pumpSwapBuyInstruction,
  pumpSwapSellInstruction,
  quoteSellLamportsOut,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('volume-bot');

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Randomizes an amount within ±`jitterBps` basis points. Identical trade
 * sizes repeated across a session are a classic wash-trading tell, so every
 * leg is jittered (default ±30% per common heuristics).
 *
 * Accepts an injectable RNG for deterministic tests.
 */
export function jitterAmount(amount: bigint, jitterBps: number, rng: () => number = Math.random): bigint {
  if (jitterBps <= 0) return amount;
  const pct = (BigInt(Math.floor(rng() * (jitterBps * 2 + 1))) - BigInt(jitterBps)) / 10_000n;
  const jittered = amount + (amount * pct) / 10_000n;
  return jittered > 0n ? jittered : amount;
}

/**
 * Randomizes a sleep interval within ±`jitterBps`, floored at `minMs`.
 * Regular fixed cadence is a detection tell; organic flow clusters and bursts.
 */
export function jitterInterval(baseMs: number, jitterBps: number, minMs: number, rng: () => number = Math.random): number {
  if (jitterBps <= 0) return Math.max(baseMs, minMs);
  const factor = 1 + (rng() * (jitterBps * 2) - jitterBps) / 10_000;
  return Math.max(Math.floor(baseMs * factor), minMs);
}

/**
 * Estimates the round-trip cost of one pair in lamports: two tx base fees,
 * the Jito tip, and venue fees on both legs (`venueFeeBps` per leg, e.g.
 * 100 for pump.fun's 1%, 25 for Raydium/PumpSwap's 0.25%).
 */
export function estimateRoundTripCostLamports(params: {
  buyLamports: bigint;
  tipLamports: bigint;
  venueFeeBps: number;
}): bigint {
  const baseFees = 2n * 5_000n;
  const venueFees = (params.buyLamports * BigInt(params.venueFeeBps) * 2n) / 10_000n;
  return baseFees + params.tipLamports + venueFees;
}

/** Per-leg venue fee in basis points (verified against venue docs). */
export function venueFeeBps(venue: VolumeBotOptions['venue']): number {
  switch (venue) {
    case 'pumpfun':
    case 'moonit':
      return 100; // 1% bonding-curve fee
    case 'raydium-amm-v4':
    case 'pumpswap':
      return 25; // 0.25%
    default:
      return 50; // aggregator/CLMM ballpark (variable)
  }
}

// ---------------------------------------------------------------------------
// Anti-MEV volume bot
// ---------------------------------------------------------------------------

/** How each buy+sell pair is executed. */
export type VolumeBotPairMode = 'atomic-bundle' | 'intra-tx' | 'separated';

/** How the Jito bundle tip is sized. */
export type VolumeBotTipMode = 'static' | 'tip-floor';

export interface VolumeBotOptions {
  venue: SwapVenue;
  /** Wallet pool, rotated round-robin per pair (rotation spreads footprints). */
  wallets: Keypair[];
  /** Token mint being volumized (paired against SOL). */
  mint: string;
  /** Base SOL size per buy leg (lamports); jittered per pair. */
  buyLamports: bigint;
  /**
   * Token size per sell leg (raw). When omitted, sells the previous buy's
   * full output — required for the atomic modes (the sell amount is derived
   * from the buy quote at build time).
   */
  sellAmountRaw?: bigint;
  slippageBps: number;
  /**
   * Base milliseconds between pairs, jittered by `intervalJitterBps` and
   * floored at `minIntervalMs` (default 2000).
   */
  intervalMs: number;
  /** Number of buy+sell pairs to execute. */
  pairs: number;
  mode?: 'simulate' | 'execute';
  /** Abort predicate for graceful shutdown. */
  shouldStop?: () => boolean;

  // ---- anti-MEV controls (see module doc) ----
  /** Pair execution mode. Default 'atomic-bundle' (buy+sell in one Jito bundle). */
  pairMode?: VolumeBotPairMode;
  /** Attach a `jitodontfront` marker so no bundle can front-run our legs. Default true. */
  applyDontFront?: boolean;
  /** Tip sizing: 'static' uses `tipLamports`/engine config; 'tip-floor' follows Jito's landed-tip feed. */
  tipMode?: VolumeBotTipMode;
  /** Landed-tip percentile used in tip-floor mode (25|50|75|95|99). Default 75. */
  tipPercentile?: 25 | 50 | 75 | 95 | 99;
  /** Static tip override (lamports). Defaults to the engine config tip. */
  tipLamports?: bigint;
  /** Skip a pair when the estimated round-trip cost exceeds this budget (lamports). */
  maxRoundTripCostLamports?: bigint;

  // ---- pattern controls (anti-detection jitter) ----
  /** Buy-size jitter in bps (±). Default 3000 (±30%). */
  jitterBps?: number;
  /** Interval jitter in bps (±). Default 3000. */
  intervalJitterBps?: number;
  /** Minimum ms between pairs. Default 2000. */
  minIntervalMs?: number;
  /** Stop after this many consecutive failed pairs. Default 3 (0 = disabled). */
  consecutiveFailureLimit?: number;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
}

export interface VolumeBotReport {
  /** Pairs whose bundle/tx landed (or were successfully simulated). */
  pairsExecuted: number;
  pairsFailed: number;
  /** Pairs skipped by the round-trip cost budget guard. */
  pairsSkipped: number;
  outcomes: SendOutcome[];
  /** Landed Jito bundle ids (execute mode, atomic pairs). */
  bundleIds: string[];
  /** Total tips paid (or that would be paid) in lamports. */
  tipsPaidLamports: bigint;
  /** Estimated total round-trip costs in lamports (fees + tips + venue fees). */
  estimatedCostsLamports: bigint;
  /** Tip-sizing mode actually used, for auditability. */
  tipMode: VolumeBotTipMode;
  pairMode: VolumeBotPairMode;
}

/** Cached tip-floor value (Jito refreshes the feed each minute). */
let tipFloorCache: { value: bigint; fetchedAt: number } | null = null;
const TIP_FLOOR_TTL_MS = 30_000;

/**
 * Resolves the tip for the next pair: static config or Jito's landed-tip
 * percentile feed (tip-floor mode), floored at Jito's enforced minimum.
 */
async function resolveTip(ctx: DexContext, opts: VolumeBotOptions): Promise<bigint> {
  if (opts.tipMode === 'tip-floor') {
    const now = Date.now();
    if (!tipFloorCache || now - tipFloorCache.fetchedAt > TIP_FLOOR_TTL_MS) {
      const value = await ctx.jito.recommendedTipLamports(opts.tipPercentile ?? 75, {
        minLamports: opts.tipLamports,
      });
      tipFloorCache = { value, fetchedAt: now };
      log.info({ percentile: opts.tipPercentile ?? 75, tipLamports: value.toString() }, 'tip sized from Jito landed-tip feed');
    }
    return tipFloorCache.value;
  }
  return BigInt(opts.tipLamports ?? ctx.jito.config.tipLamports);
}

/**
 * Builds the buy leg for a wallet. Returns the swap instructions and the
 * token amount expected out (used as the sell amount in atomic modes).
 */
export async function buildBuyLeg(
  ctx: DexContext,
  wallet: Keypair,
  params: { venue: SwapVenue; mint: string; buyLamports: bigint; slippageBps: number },
): Promise<{ instructions: TransactionInstruction[]; tokensOutRaw: bigint }> {
  const { venue, mint, buyLamports, slippageBps } = params;
  const mintPk = new PublicKey(mint);

  if (venue === 'pumpfun') {
    const curve = await fetchCurve(ctx, mint);
    // pump.fun takes its 1% fee from the SOL side: the curve sees `buy - 1%`.
    const effectiveIn = buyLamports - (buyLamports * 100n) / 10_000n;
    const tokensOut = tokensOutForSolIn(curve.virtualSolReserves, curve.virtualTokenReserves, effectiveIn);
    return {
      instructions: [
        pumpBuyInstruction({
          user: wallet.publicKey,
          mint: mintPk,
          curveCreator: curve.creator,
          amount: tokensOut,
          maxSolCost: buyLamports,
        }),
      ],
      tokensOutRaw: tokensOut,
    };
  }

  if (venue === 'raydium-amm-v4') {
    const keys = await raydiumPool(ctx, mint);
    const [vaultA, vaultB] = await Promise.all([
      tokenBalance(ctx, keys.baseVault.toBase58()),
      tokenBalance(ctx, keys.quoteVault.toBase58()),
    ]);
    const userWsol = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), wallet.publicKey, true, TOKEN_PROGRAM_ID);
    const userBase = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, TOKEN_PROGRAM_ID);
    const tokensOut = ammV4QuoteOut({ reserveIn: vaultB, reserveOut: vaultA, amountIn: buyLamports });
    return {
      instructions: [
        ammV4SwapSimpleInInstruction({
          poolId: keys.ammId,
          auth: keys.ammAuthority,
          vaultA: keys.baseVault,
          vaultB: keys.quoteVault,
          ownerTokenIn: userWsol,
          ownerTokenOut: userBase,
          owner: wallet.publicKey,
          amountIn: buyLamports,
          minAmountOut: tokensOut - (tokensOut * BigInt(slippageBps)) / 10_000n,
        }),
      ],
      tokensOutRaw: tokensOut,
    };
  }

  if (venue === 'pumpswap') {
    const pool = pumpAmmPoolPda({ index: 0, creator: '11111111111111111111111111111111', baseMint: mint, quoteMint: WSOL_MINT });
    const { pumpSwapAccounts } = await import('@solana-toolkit/solana-programs');
    const acc = pumpSwapAccounts({ pool, user: wallet.publicKey, baseMint: mintPk, quoteMint: new PublicKey(WSOL_MINT) });
    const [baseVaultBal, quoteVaultBal] = await Promise.all([
      tokenBalance(ctx, acc.poolBaseTokenAccount.toBase58()),
      tokenBalance(ctx, acc.poolQuoteTokenAccount.toBase58()),
    ]);
    const tokensOut = ammV4QuoteOut({ reserveIn: quoteVaultBal, reserveOut: baseVaultBal, amountIn: buyLamports });
    return {
      instructions: [
        pumpSwapBuyInstruction({
          pool,
          user: wallet.publicKey,
          baseMint: mintPk,
          quoteMint: new PublicKey(WSOL_MINT),
          baseAmountOut: tokensOut,
          maxQuoteAmountIn: buyLamports + (buyLamports * BigInt(slippageBps)) / 10_000n,
        }),
      ],
      tokensOutRaw: tokensOut,
    };
  }

  // jupiter / orca / bonk / anything else → aggregator. The returned plan is
  // a signed-ready transaction; we extract its instructions to rebuild under
  // our own fee/tip/dontfront policy.
  const { quote, swapTransaction } = await jupiterSwapPlan(ctx, {
    user: wallet,
    inputMint: WSOL_MINT,
    outputMint: mint,
    amountInRaw: buyLamports,
    slippageBps,
  });
  return {
    instructions: instructionsFromVersionedTransaction(
      VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64')),
    ),
    tokensOutRaw: BigInt(quote.outAmountRaw),
  };
}

/**
 * Builds the sell leg (exact `sellAmountRaw` in, SOL out with slippage floor).
 */
export async function buildSellLeg(
  ctx: DexContext,
  wallet: Keypair,
  params: { venue: SwapVenue; mint: string; sellAmountRaw: bigint; slippageBps: number },
): Promise<TransactionInstruction[]> {
  const { venue, mint, sellAmountRaw, slippageBps } = params;
  const mintPk = new PublicKey(mint);

  if (venue === 'pumpfun') {
    const curve = await fetchCurve(ctx, mint);
    const lamportsOut = quoteSellLamportsOut(curve, sellAmountRaw);
    const minOut = lamportsOut - (lamportsOut * BigInt(slippageBps)) / 10_000n;
    return [
      pumpSellInstruction({
        user: wallet.publicKey,
        mint: mintPk,
        curveCreator: curve.creator,
        amount: sellAmountRaw,
        minSolOutput: minOut,
      }),
    ];
  }

  if (venue === 'raydium-amm-v4') {
    const keys = await raydiumPool(ctx, mint);
    const [vaultA, vaultB] = await Promise.all([
      tokenBalance(ctx, keys.baseVault.toBase58()),
      tokenBalance(ctx, keys.quoteVault.toBase58()),
    ]);
    const userWsol = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), wallet.publicKey, true, TOKEN_PROGRAM_ID);
    const userBase = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, TOKEN_PROGRAM_ID);
    const minOut = ammV4QuoteOut({ reserveIn: vaultA, reserveOut: vaultB, amountIn: sellAmountRaw });
    return [
      ammV4SwapSimpleInInstruction({
        poolId: keys.ammId,
        auth: keys.ammAuthority,
        vaultA: keys.baseVault,
        vaultB: keys.quoteVault,
        ownerTokenIn: userBase,
        ownerTokenOut: userWsol,
        owner: wallet.publicKey,
        amountIn: sellAmountRaw,
        minAmountOut: minOut - (minOut * BigInt(slippageBps)) / 10_000n,
      }),
    ];
  }

  if (venue === 'pumpswap') {
    const pool = pumpAmmPoolPda({ index: 0, creator: '11111111111111111111111111111111', baseMint: mint, quoteMint: WSOL_MINT });
    const { pumpSwapAccounts } = await import('@solana-toolkit/solana-programs');
    const acc = pumpSwapAccounts({ pool, user: wallet.publicKey, baseMint: mintPk, quoteMint: new PublicKey(WSOL_MINT) });
    const [baseVaultBal, quoteVaultBal] = await Promise.all([
      tokenBalance(ctx, acc.poolBaseTokenAccount.toBase58()),
      tokenBalance(ctx, acc.poolQuoteTokenAccount.toBase58()),
    ]);
    const minOut = ammV4QuoteOut({ reserveIn: baseVaultBal, reserveOut: quoteVaultBal, amountIn: sellAmountRaw });
    return [
      pumpSwapSellInstruction({
        pool,
        user: wallet.publicKey,
        baseMint: mintPk,
        quoteMint: new PublicKey(WSOL_MINT),
        baseAmountIn: sellAmountRaw,
        minQuoteAmountOut: minOut - (minOut * BigInt(slippageBps)) / 10_000n,
      }),
    ];
  }

  const { swapTransaction } = await jupiterSwapPlan(ctx, {
    user: wallet,
    inputMint: mint,
    outputMint: WSOL_MINT,
    amountInRaw: sellAmountRaw,
    slippageBps,
  });
  return instructionsFromVersionedTransaction(
    VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64')),
  );
}

/** Applies the DontFront marker carrier when enabled. */
function withMarker(instructions: TransactionInstruction[], enabled: boolean): TransactionInstruction[] {
  return enabled ? [...instructions, dontFrontMarkerInstruction()] : instructions;
}

async function fetchCurve(ctx: DexContext, mint: string) {
  const info = await ctx.rpc.accountInfo(pumpBondingCurvePda(mint).toBase58());
  if (!info) throw new Error(`bonding curve not found for ${mint}`);
  return decodeBondingCurve(Buffer.from(info.data));
}

async function raydiumPool(ctx: DexContext, mint: string) {
  const pools = await fetchRaydiumPoolsByMints(ctx.raydiumApiBase, WSOL_MINT, mint);
  const pool = pools.find((p) => p.programId === PROGRAMS.RAYDIUM_AMM_V4 && p.marketId);
  if (!pool || !pool.marketId) throw new Error('no Raydium AMM v4 pool for pair');
  return deriveAmmV4PoolKeys(new PublicKey(pool.marketId), new PublicKey(PROGRAMS.OPENBOOK_V1));
}

async function tokenBalance(ctx: DexContext, tokenAccount: string): Promise<bigint> {
  const info = await ctx.rpc.connection.getTokenAccountBalance(new PublicKey(tokenAccount));
  return BigInt(info.value.amount);
}

/**
 * Runs the anti-MEV volume loop.
 *
 * Default mode submits each buy+sell pair as ONE atomic Jito bundle
 * `[buy(dontfront), sell(+tip)]`: sequential, same-slot, all-or-nothing —
 * no sandwich can be inserted between the legs, and no other bundle may be
 * ordered before the dontfront-marked buy. Tips ride inside the final leg
 * per Jito guidance, sized either statically or from the landed-tip feed.
 */
export async function runVolumeBot(ctx: DexContext, opts: VolumeBotOptions): Promise<VolumeBotReport> {
  const mode = opts.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const pairMode = opts.pairMode ?? 'atomic-bundle';
  const applyDontFront = opts.applyDontFront ?? true;
  const jitterBps = opts.jitterBps ?? 3_000;
  const rng = opts.rng ?? Math.random;
  const report: VolumeBotReport = {
    pairsExecuted: 0,
    pairsFailed: 0,
    pairsSkipped: 0,
    outcomes: [],
    bundleIds: [],
    tipsPaidLamports: 0n,
    estimatedCostsLamports: 0n,
    tipMode: opts.tipMode ?? 'static',
    pairMode,
  };
  let consecutiveFailures = 0;
  const failureLimit = opts.consecutiveFailureLimit ?? 3;

  log.info(
    {
      venue: opts.venue,
      pairMode,
      dontFront: applyDontFront,
      tipMode: report.tipMode,
      pairs: opts.pairs,
      wallets: opts.wallets.length,
      mode,
    },
    'volume bot started',
  );

  for (let pair = 0; pair < opts.pairs; pair++) {
    if (opts.shouldStop?.()) {
      log.info('stop signal received');
      break;
    }
    // Wallet rotation + size jitter: never the same wallet/size back-to-back.
    const wallet = opts.wallets[pair % opts.wallets.length]!;
    const buyLamports = jitterAmount(opts.buyLamports, jitterBps, rng);
    const tipLamports = await resolveTip(ctx, opts);

    // Round-trip cost budget guard.
    const cost = estimateRoundTripCostLamports({
      buyLamports,
      tipLamports,
      venueFeeBps: venueFeeBps(opts.venue),
    });
    if (opts.maxRoundTripCostLamports !== undefined && cost > opts.maxRoundTripCostLamports) {
      report.pairsSkipped++;
      log.warn(
        { pair, cost: cost.toString(), budget: opts.maxRoundTripCostLamports.toString() },
        'skipping pair — round-trip cost exceeds budget',
      );
      await sleep(jitterInterval(opts.intervalMs, opts.intervalJitterBps ?? jitterBps, opts.minIntervalMs ?? 2_000, rng));
      continue;
    }
    report.estimatedCostsLamports += cost;

    try {
      // Fresh quotes at build time — the sell amount derives from the buy
      // quote so the pair is internally consistent within one slot.
      const buy = await buildBuyLeg(ctx, wallet, {
        venue: opts.venue,
        mint: opts.mint,
        buyLamports,
        slippageBps: opts.slippageBps,
      });
      const sellAmount = opts.sellAmountRaw ?? buy.tokensOutRaw;
      const sellIxs = await buildSellLeg(ctx, wallet, {
        venue: opts.venue,
        mint: opts.mint,
        sellAmountRaw: sellAmount,
        slippageBps: opts.slippageBps,
      });

      const buyIxs = withMarker(buy.instructions, applyDontFront);
      const markedSellIxs = withMarker(sellIxs, applyDontFront && pairMode === 'separated');

      let outcome: SendOutcome;
      if (pairMode === 'atomic-bundle') {
        // [buy(dontfront), sell(+inline tip)] — one slot, all-or-nothing.
        // The dontfront rule "index 0" is satisfied: the buy is first.
        const legs: TransactionRequest[] = [
          {
            description: `volume buy ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: buyIxs,
            signers: [wallet] as never[],
          },
          {
            description: `volume sell ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: markedSellIxs,
            signers: [wallet] as never[],
            jitoTipLamports: tipLamports,
          },
        ];
        outcome = await ctx.sender.sendBundle(legs, { mode });
        if (outcome.bundleId) report.bundleIds.push(outcome.bundleId);
      } else if (pairMode === 'intra-tx') {
        // Both swaps in one transaction; tip rides with it via the relay.
        outcome = await ctx.sender.send(
          {
            description: `volume pair (intra-tx) ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: [...buyIxs, ...sellIxs],
            signers: [wallet],
          },
          { mode, jito: true, priorityFee: { jitoTipLamports: Number(tipLamports) } },
        );
      } else {
        // separated: legs land in different slots with a randomized gap.
        // MEV-exposed between slots; dontfront on each leg is partial cover.
        outcome = await ctx.sender.send(
          {
            description: `volume buy (separated) ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: buyIxs,
            signers: [wallet],
          },
          { mode, jito: true, priorityFee: { jitoTipLamports: Number(tipLamports / 2n) } },
        );
        if (mode !== 'simulate') {
          await sleep(jitterInterval(opts.intervalMs, opts.intervalJitterBps ?? jitterBps, opts.minIntervalMs ?? 2_000, rng));
        }
        const sellOutcome = await ctx.sender.send(
          {
            description: `volume sell (separated) ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: markedSellIxs,
            signers: [wallet],
          },
          { mode, jito: true, priorityFee: { jitoTipLamports: Number(tipLamports / 2n) } },
        );
        report.outcomes.push(sellOutcome);
      }

      report.outcomes.push(outcome);
      report.tipsPaidLamports += pairMode === 'separated' ? tipLamports : tipLamports;

      const landed = outcome.simulated
        ? !outcome.warnings.some((w) => w.includes('failed'))
        : outcome.bundleStatus === undefined || outcome.bundleStatus === 'Landed';
      if (landed) {
        report.pairsExecuted++;
        consecutiveFailures = 0;
        log.info({ pair, bundleStatus: outcome.bundleStatus ?? 'tx' }, 'volume pair complete');
      } else {
        report.pairsFailed++;
        consecutiveFailures++;
        log.warn({ pair, bundleStatus: outcome.bundleStatus }, 'volume pair did not land');
      }
    } catch (err) {
      report.pairsFailed++;
      consecutiveFailures++;
      log.error({ err, pair }, 'volume pair failed');
    }

    if (failureLimit > 0 && consecutiveFailures >= failureLimit) {
      log.warn({ consecutiveFailures }, 'consecutive failure limit reached — stopping volume bot');
      break;
    }

    await sleep(jitterInterval(opts.intervalMs, opts.intervalJitterBps ?? jitterBps, opts.minIntervalMs ?? 2_000, rng));
  }

  log.info(
    {
      executed: report.pairsExecuted,
      failed: report.pairsFailed,
      skipped: report.pairsSkipped,
      tips: report.tipsPaidLamports.toString(),
      estimatedCosts: report.estimatedCostsLamports.toString(),
    },
    'volume bot finished',
  );
  return report;
}

// ---------------------------------------------------------------------------
// Bundled buy / sell
// ---------------------------------------------------------------------------

export interface BundledTradeParams {
  direction: 'buy' | 'sell';
  venue: 'pumpfun' | 'raydium-amm-v4' | 'jupiter' | 'pumpswap';
  wallets: Keypair[];
  mint: string;
  /** SOL per wallet (buys) or token amount per wallet (sells), raw. */
  amountPerWalletRaw: bigint;
  slippageBps: number;
  mode?: 'simulate' | 'execute';
  /** Attach DontFront markers to every leg (default true — protects the
   * whole bundle from being front-run; all legs share no signer with the
   * first marker tx only when wallets differ, so markers are attached to the
   * FIRST wallet's leg only when needed). */
  applyDontFront?: boolean;
}

/**
 * Executes a bundled buy or sell across all wallets in one atomic Jito
 * bundle. Each wallet signs its own leg; the tip rides inline with the final
 * leg per Jito guidance. The first leg carries a DontFront marker so the
 * bundle cannot be front-run.
 */
export async function bundledTrade(
  ctx: DexContext,
  params: BundledTradeParams,
): Promise<SendOutcome> {
  const mode = params.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const legs = [];
  for (const [i, wallet] of params.wallets.entries()) {
    const ixs = await buildLegInstructions(ctx, wallet, params);
    // DontFront: only the FIRST leg carries the marker — multiple marker txs
    // must share signers, and multi-wallet legs do not. The marker on leg 0
    // already pins the whole bundle to start with our first transaction.
    const instructions = params.applyDontFront !== false && i === 0
      ? [...ixs, dontFrontMarkerInstruction()]
      : ixs;
    legs.push({
      description: `bundled ${params.direction} ${wallet.publicKey.toBase58().slice(0, 6)}`,
      feePayer: wallet.publicKey.toBase58(),
      instructions,
      signers: [wallet] as never[],
    });
  }
  log.info({ legs: legs.length, venue: params.venue, direction: params.direction }, 'submitting bundled trade');
  return ctx.sender.sendBundle(legs, { mode });
}

async function buildLegInstructions(
  ctx: DexContext,
  wallet: Keypair,
  params: BundledTradeParams,
): Promise<TransactionInstruction[]> {
  if (params.venue === 'pumpfun' || params.venue === 'pumpswap') {
    if (params.direction === 'buy') {
      const { instructions } = await buildBuyLeg(ctx, wallet, {
        venue: params.venue,
        mint: params.mint,
        buyLamports: params.amountPerWalletRaw,
        slippageBps: params.slippageBps,
      });
      return instructions;
    }
    return buildSellLeg(ctx, wallet, {
      venue: params.venue,
      mint: params.mint,
      sellAmountRaw: params.amountPerWalletRaw,
      slippageBps: params.slippageBps,
    });
  }

  if (params.venue === 'raydium-amm-v4') {
    if (params.direction === 'buy') {
      const { instructions } = await buildBuyLeg(ctx, wallet, {
        venue: 'raydium-amm-v4',
        mint: params.mint,
        buyLamports: params.amountPerWalletRaw,
        slippageBps: params.slippageBps,
      });
      return instructions;
    }
    return buildSellLeg(ctx, wallet, {
      venue: 'raydium-amm-v4',
      mint: params.mint,
      sellAmountRaw: params.amountPerWalletRaw,
      slippageBps: params.slippageBps,
    });
  }

  // jupiter
  const { swapTransaction } = await jupiterSwapPlan(ctx, {
    user: wallet,
    inputMint: params.direction === 'buy' ? WSOL_MINT : params.mint,
    outputMint: params.direction === 'buy' ? params.mint : WSOL_MINT,
    amountInRaw: params.amountPerWalletRaw,
    slippageBps: params.slippageBps,
  });
  return instructionsFromVersionedTransaction(
    VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64')),
  );
}

/** Constant-product tokens-out for exact SOL in (pump.fun curve helper). */
function tokensOutForSolIn(vSol: bigint, vToken: bigint, lamportsIn: bigint): bigint {
  return (vToken * lamportsIn) / (vSol + lamportsIn);
}

/**
 * Reconstructs web3.js `TransactionInstruction`s from a compiled versioned
 * message (account metas resolved from the message header).
 */
export function instructionsFromVersionedTransaction(vtx: VersionedTransaction): TransactionInstruction[] {
  const msg = vtx.message;
  const header = (msg as unknown as {
    header: {
      numRequiredSignatures: number;
      numReadonlySignedAccounts: number;
      numReadonlyUnsignedAccounts: number;
    };
  }).header;
  const total = msg.staticAccountKeys.length;
  const isWritable = (index: number): boolean => {
    if (index < header.numRequiredSignatures) {
      return index < header.numRequiredSignatures - header.numReadonlySignedAccounts;
    }
    return index < total - header.numReadonlyUnsignedAccounts;
  };
  return msg.compiledInstructions.map((ci) => {
    const keys: AccountMeta[] = ci.accountKeyIndexes.map((idx) => ({
      pubkey: msg.staticAccountKeys[idx]!,
      isSigner: idx < header.numRequiredSignatures,
      isWritable: isWritable(idx),
    }));
    return new TransactionInstruction({
      programId: msg.staticAccountKeys[ci.programIdIndex]!,
      keys,
      data: Buffer.from(ci.data),
    });
  });
}
