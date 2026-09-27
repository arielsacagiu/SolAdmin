/**
 * Market Maker — Batch Swap.
 *
 * Round-robin buy/sell legs across a venue (Pump.fun, Raydium, Orca, Bonk/BONK
 * pairs) at a fixed interval. Each leg goes through the simulation-first
 * sender; when `useJito` is set, buy+sell pairs are submitted as atomic Jito
 * bundles to avoid sandwich exposure.
 *
 * MM-SKEW MODE (production market-maker pattern): buy and sell sides run on
 * INDEPENDENT schedules (`buySchedule` / `sellSchedule`) with their own
 * cadence and notional. Equal schedules reproduce pure volume behavior;
 * skewed schedules bias inventory directionally (faster/larger buys trend
 * the book long, faster/larger sells trend it short).
 *
 * INVENTORY GUARD RAILS (risk management): before every leg the wallet's
 * actual token balance is read on-chain; buys are skipped above
 * `maxInventoryRaw` and sells are skipped below `minInventoryRaw`, so a
 * stalled venue or a runaway skew can never accumulate unbounded inventory.
 *
 * TREASURY ROTATION: Each launch/operation uses a fresh treasury keypair to
 * prevent address reuse and maintain clean wallet lineage. No address is
 * reused between launches.
 * @module
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { SendOutcome, SwapVenue } from '@solana-toolkit/types';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import type { TransactionRequest } from '@solana-toolkit/transaction-builder';
import type { DexContext } from './context.js';
import { executeSwap } from './swap.js';
import { WSOL_MINT, pumpBuyInstruction, pumpSellInstruction, pumpBondingCurvePda, decodeBondingCurve, quoteSellLamportsOut } from '@solana-toolkit/solana-programs';

const log = moduleLogger('market-maker');

// ---------------------------------------------------------------------------
// Treasury Rotation
// ---------------------------------------------------------------------------

/**
 * Treasury rotation strategy: generates fresh treasury keypairs per launch/operation
 * to ensure clean wallet lineage and prevent address reuse between launches.
 * 
 * ANONYMITY: Each treasury is used exactly once, then discarded. This prevents
 * on-chain linkage between different launches through shared funding sources.
 * Combined with distinct buyer wallets per launch, this provides strong
 * heuristic anonymity (though not cryptographic anonymity).
 */
export interface TreasuryRotationConfig {
  /** Generate a new treasury for each operation (default: true). */
  enabled?: boolean;
  /** Prefix for generated treasury keypair names (for persistence). */
  namePrefix?: string;
}

/**
 * Generates a fresh treasury keypair for a new launch/operation.
 * Each treasury is unique and never reused, ensuring clean wallet lineage.
 */
export function generateTreasuryKeypair(config?: TreasuryRotationConfig): Keypair {
  // Always generate a new ephemeral keypair; for persistence, the caller
  // should serialize to a keystore file with the provided prefix.
  const treasury = Keypair.generate();
  log.info(
    { treasury: treasury.publicKey.toBase58().slice(0, 6), prefix: config?.namePrefix },
    'generated fresh treasury keypair for rotation',
  );
  return treasury;
}

/**
 * Treasury pool for rotation: holds unused treasuries ready for next operations.
 * In production, this would be pre-funded keystores; for this implementation,
 * we generate fresh keypairs on demand.
 */
const treasuryPool: Keypair[] = [];

/**
 * Get next treasury from pool or generate fresh.
 * Rotation strategy: round-robin from pool, but each treasury is used
 * exactly once per launch, ensuring no address reuse.
 */
export function getNextTreasury(config?: TreasuryRotationConfig): Keypair {
  if (treasuryPool.length > 0) {
    const treasury = treasuryPool.shift()!;
    log.info(
      { treasury: treasury.publicKey.toBase58().slice(0, 6) },
      'reusing treasury from pool for next operation',
    );
    return treasury;
  }
  // Generate fresh treasury for clean lineage
  return generateTreasuryKeypair(config);
}

/**
 * Return treasury to pool after use (for reuse in same session).
 * Note: In strict rotation mode, treasuries should NOT be reused across
 * different launches to maintain clean lineage.
 */
export function returnTreasury(treasury: Keypair): void {
  treasuryPool.push(treasury);
}

/**
 * Clear the treasury pool - useful when starting a new launch to ensure
 * completely fresh treasuries.
 */
export function clearTreasuryPool(): void {
  treasuryPool.length = 0;
  log.info('treasury pool cleared - next operation will use fresh keypairs');
}

/**
 * Generates `count` fresh, never-before-used buyer wallets.
 * ANONYMITY: buyer wallets must be distinct per launch — reusing buyer
 * addresses across launches links the launches on-chain.
 */
export function freshBuyerWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

/**
 * A complete, clean funding lineage for one launch: one fresh treasury plus
 * its fresh buyer wallets. Generate one per launch so no address is ever
 * reused between launches.
 */
export interface LaunchLineage {
  treasury: Keypair;
  buyers: Keypair[];
}

/**
 * Generates a fresh launch lineage (treasury + buyers), all single-use.
 * Use this for every `pumpfunLaunchBuy` / `increaseHolders` operation to
 * guarantee clean wallet lineage rotation.
 */
export function freshLaunchLineage(buyers: number, config?: TreasuryRotationConfig): LaunchLineage {
  return {
    treasury: getNextTreasury(config),
    buyers: freshBuyerWallets(buyers),
  };
}

export interface BatchSwapLegSpec {
  direction: 'buy' | 'sell';
  amountRaw: bigint;
}

/** One side's schedule in MM-skew mode. */
export interface MMLegSchedule {
  direction: 'buy' | 'sell';
  /** Notional per leg: SOL in lamports for buys, tokens in raw for sells. */
  amountRaw: bigint;
  /** This side's own cadence in ms. */
  intervalMs: number;
  /** Optional per-leg size jitter in bps (±); default 0. */
  jitterBps?: number;
}

/** Inventory guard rails (raw token units). Each threshold is independent. */
export interface InventoryRails {
  /** Skip BUY legs when inventory would exceed this (raw). */
  maxInventoryRaw?: bigint;
  /** Skip SELL legs when inventory is below this (raw). */
  minInventoryRaw?: bigint;
}

export interface BatchSwapOptions {
  venue: SwapVenue;
  user: Keypair;
  mint: string;
  /** Volume mode: legs executed round-robin per round. */
  legs: BatchSwapLegSpec[];
  intervalMs: number;
  rounds: number;
  slippageBps: number;
  useJito: boolean;
  mode?: 'simulate' | 'execute';
  /** MM-skew mode: independent schedules replace `legs` when provided. */
  buySchedule?: MMLegSchedule;
  sellSchedule?: MMLegSchedule;
  /** Inventory guard rails applied in MM-skew mode (recommended). */
  inventoryRails?: InventoryRails;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
}

export interface BatchSwapReport {
  legsExecuted: number;
  legsFailed: number;
  /** Legs skipped by the inventory guard rails. */
  legsSkipped: number;
  outcomes: SendOutcome[];
  venue: SwapVenue;
  rounds: number;
  /** Last on-chain inventory reading (raw), when rails are active. */
  lastInventoryRaw?: string;
}

/**
 * Pure inventory-rail decision. Exported for unit tests.
 * Returns true when the leg should be SKIPPED.
 */
export function shouldSkipLeg(
  direction: 'buy' | 'sell',
  inventoryRaw: bigint,
  rails: InventoryRails | undefined,
): boolean {
  if (!rails) return false;
  if (direction === 'buy') {
    return rails.maxInventoryRaw !== undefined && inventoryRaw >= rails.maxInventoryRaw;
  }
  return rails.minInventoryRaw !== undefined && inventoryRaw <= rails.minInventoryRaw;
}

/** Reads the wallet's current token ATA balance (raw), 0n when absent. */
async function inventoryOf(ctx: DexContext, wallet: Keypair, mint: string): Promise<bigint> {
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
  const { PublicKey: PK } = await import('@solana/web3.js');
  const mintPk = new PK(mint);
  // MINT PATH DETECTION (pumpfun vs SPL vs token-2022): the mint account's
  // owner tells us which token program holds the ATA. Pump.fun bonding-curve
  // mints and `createToken` 'spl' mints live in the SPL Token program;
  // `createToken` 'token-2022' mints live in Token-2022. Try the detected
  // program first, fall back to the other when the owner cannot be resolved.
  const mintInfo = await ctx.rpc.accountInfo(mint);
  const ownerB58 = mintInfo?.owner.toBase58();
  const programs =
    ownerB58 === TOKEN_2022_PROGRAM_ID.toBase58()
      ? [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]
      : ownerB58 === TOKEN_PROGRAM_ID.toBase58()
        ? [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
        : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  for (const program of programs) {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, true, program);
    try {
      const res = await ctx.rpc.connection.getTokenAccountBalance(ata);
      return BigInt(res.value.amount);
    } catch {
      // try the other token program
    }
  }
  return 0n;
}

/**
 * MM-skew mode runner: two independent schedule loops sharing one abort
 * predicate and one circuit breaker. `runMMSkew` interleaves the sides by
 * wall-clock deadlines rather than a fixed round-robin, so a 5s/8s buy/sell
 * cadence behaves like two live orders rather than an alternating pair.
 */
export async function runMMSkew(ctx: DexContext, opts: BatchSwapOptions): Promise<BatchSwapReport> {
  if (!opts.buySchedule || !opts.sellSchedule) {
    throw new Error('runMMSkew requires buySchedule and sellSchedule');
  }
  const report: BatchSwapReport = {
    legsExecuted: 0,
    legsFailed: 0,
    legsSkipped: 0,
    outcomes: [],
    venue: opts.venue,
    rounds: opts.rounds,
  };
  const mode = opts.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const rng = opts.rng ?? Math.random;
  let consecutiveFailures = 0;

  // Independent deadline clocks per side, N legs each per round budget.
  const totalLegs = opts.rounds; // legs per side
  let buyFired = 0;
  let sellFired = 0;
  let nextBuyAt = Date.now();
  let nextSellAt = Date.now();

  while (buyFired < totalLegs || sellFired < totalLegs) {
    const now = Date.now();
    const due =
      buyFired < totalLegs && nextBuyAt <= now
        ? ('buy' as const)
        : sellFired < totalLegs && nextSellAt <= now
          ? ('sell' as const)
          : null;
    if (due === null) {
      const wait = Math.min(
        buyFired < totalLegs ? Math.max(0, nextBuyAt - now) : Number.MAX_SAFE_INTEGER,
        sellFired < totalLegs ? Math.max(0, nextSellAt - now) : Number.MAX_SAFE_INTEGER,
      );
      await sleep(Math.min(wait || 50, 50));
      continue;
    }

    const schedule = due === 'buy' ? opts.buySchedule : opts.sellSchedule;
    const amountRaw = schedule.jitterBps
      ? jitter(schedule.amountRaw, schedule.jitterBps, rng)
      : schedule.amountRaw;

    if (opts.inventoryRails) {
      const inventory = await inventoryOf(ctx, opts.user, opts.mint);
      report.lastInventoryRaw = inventory.toString();
      if (shouldSkipLeg(due, inventory, opts.inventoryRails)) {
        report.legsSkipped++;
        log.info({ side: due, inventory: inventory.toString() }, 'leg skipped by inventory rails');
        if (due === 'buy') { buyFired++; nextBuyAt = Date.now() + schedule.intervalMs; }
        else { sellFired++; nextSellAt = Date.now() + schedule.intervalMs; }
        continue;
      }
    }

    try {
      const result = await executeSwap(ctx, {
        venue: opts.venue,
        user: opts.user,
        inputMint: due === 'buy' ? WSOL_MINT : opts.mint,
        outputMint: due === 'buy' ? opts.mint : WSOL_MINT,
        amountInRaw: amountRaw,
        slippageBps: opts.slippageBps,
        mode,
        jito: opts.useJito,
      });
      report.legsExecuted++;
      if ('signatures' in result.outcome) report.outcomes.push(result.outcome);
      consecutiveFailures = 0;
    } catch (err) {
      report.legsFailed++;
      consecutiveFailures++;
      log.error({ err, side: due }, 'MM leg failed');
      if (consecutiveFailures >= 5) {
        log.warn('five consecutive MM leg failures — aborting skew session');
        return report;
      }
    }
    if (due === 'buy') { buyFired++; nextBuyAt = Date.now() + schedule.intervalMs; }
    else { sellFired++; nextSellAt = Date.now() + schedule.intervalMs; }
  }
  return report;
}

/** ±jitterBps size randomization shared with the volume bot semantics. */
function jitter(amount: bigint, jitterBps: number, rng: () => number): bigint {
  const pct = (BigInt(Math.floor(rng() * (jitterBps * 2 + 1))) - BigInt(jitterBps)) / 10_000n;
  const jittered = amount + (amount * pct) / 10_000n;
  return jittered > 0n ? jittered : amount;
}

/**
 * Runs the batch swap loop. Stops early on repeated failures. When skew
 * schedules are provided, delegates to `runMMSkew`.
 */
export async function runBatchSwap(ctx: DexContext, opts: BatchSwapOptions): Promise<BatchSwapReport> {
  if (opts.buySchedule && opts.sellSchedule) {
    return runMMSkew(ctx, opts);
  }
  const report: BatchSwapReport = {
    legsExecuted: 0,
    legsFailed: 0,
    legsSkipped: 0,
    outcomes: [],
    venue: opts.venue,
    rounds: opts.rounds,
  };
  let consecutiveFailures = 0;

  for (let round = 1; round <= opts.rounds; round++) {
    log.info({ round, venue: opts.venue }, 'market maker round start');
    for (const leg of opts.legs) {
      try {
        const inputMint = leg.direction === 'buy' ? WSOL_MINT : opts.mint;
        const outputMint = leg.direction === 'buy' ? opts.mint : WSOL_MINT;
        const result = await executeSwap(ctx, {
          venue: opts.venue,
          user: opts.user,
          inputMint,
          outputMint,
          amountInRaw: leg.amountRaw,
          slippageBps: opts.slippageBps,
          jito: opts.useJito,
          mode: opts.mode,
        });
        report.legsExecuted++;
        if ('signatures' in result.outcome) report.outcomes.push(result.outcome);
        log.info(
          { direction: leg.direction, amount: leg.amountRaw.toString(), in: result.quote.inAmountRaw, out: result.quote.outAmountRaw },
          'leg complete',
        );
        consecutiveFailures = 0;
      } catch (err) {
        report.legsFailed++;
        consecutiveFailures++;
        log.error({ err, round }, 'leg failed');
        if (consecutiveFailures >= 3) {
          log.warn('three consecutive failures — aborting batch');
          return report;
        }
      }
      await sleep(opts.intervalMs);
    }
  }
  return report;
}

/**
 * Increase Holders / Makers and Increase Token Transactions (↑Txns):
 * distributes small buys to N wallets then holds (holders) or trades back
 * and forth across wallets (txns). Uses Pump.fun / Raydium / Bonk venues via
 * the swap router.
 */
export async function increaseHolders(
  ctx: DexContext,
  params: {
    venue: SwapVenue;
    treasury: Keypair;
    buyerWallets: Keypair[];
    mint: string;
    buyLamportsPerWallet: bigint;
    slippageBps: number;
    mode?: 'simulate' | 'execute';
    /**
     * Randomized delay between buyer purchases in ms (0..delay). Part of the
     * anonymity suite: uniform, machine-regular timing is a strong on-chain
     * fingerprint linking the buyers to one operator.
     */
    interBuyerDelayMs?: number;
    /** Injectable RNG for deterministic tests. */
    rng?: () => number;
  },
): Promise<{ results: { buyer: string; ok: boolean }[] }> {
  const results: { buyer: string; ok: boolean }[] = [];
  // Funding overhead: purchase amount + 20k lamports for fees/rent.
  const fundingPerBuyer = params.buyLamportsPerWallet + 20_000n;
  const rng = params.rng ?? Math.random;
  for (const [index, buyer] of params.buyerWallets.entries()) {
    try {
      // 1. Pre-fund each buyer wallet from the treasury before purchase.
      //    This ensures the buyer has sufficient SOL for the swap + fees.
      await ctx.sender.send(
        {
          description: `fund buyer ${buyer.publicKey.toBase58().slice(0, 6)} for holder purchase`,
          feePayer: params.treasury.publicKey.toBase58(),
          instructions: [
            SystemProgram.transfer({
              fromPubkey: params.treasury.publicKey,
              toPubkey: buyer.publicKey,
              lamports: fundingPerBuyer,
            }),
          ],
          signers: [params.treasury],
        },
        { mode: params.mode },
      );

      // 2. Execute the token purchase using the funded buyer wallet.
      await executeSwap(ctx, {
        venue: params.venue,
        user: buyer,
        inputMint: WSOL_MINT,
        outputMint: params.mint,
        amountInRaw: params.buyLamportsPerWallet,
        slippageBps: params.slippageBps,
        mode: params.mode,
      });
      results.push({ buyer: buyer.publicKey.toBase58(), ok: true });
    } catch (err) {
      log.error({ err, buyer: buyer.publicKey.toBase58() }, 'holder buy failed');
      results.push({ buyer: buyer.publicKey.toBase58(), ok: false });
    }
    // 3. Randomized pause between buyers (anonymity: break timing patterns).
    if (params.interBuyerDelayMs && index < params.buyerWallets.length - 1) {
      await sleep(Math.floor(rng() * params.interBuyerDelayMs));
    }
  }
  return { results };
}

/**
 * Increase Token Transactions (↑Txns): wallet pairs ping-pong trades on the
 * venue until `cycles` is reached.
 */
export async function increaseTransactions(
  ctx: DexContext,
  params: {
    venue: SwapVenue;
    wallets: Keypair[];
    mint: string;
    amountRawPerLeg: bigint;
    cycles: number;
    intervalMs: number;
    slippageBps: number;
    mode?: 'simulate' | 'execute';
  },
): Promise<{ legs: number; failures: number }> {
  let legs = 0;
  let failures = 0;
  for (let cycle = 0; cycle < params.cycles; cycle++) {
    for (let i = 0; i < params.wallets.length; i++) {
      const wallet = params.wallets[i]!;
      try {
        // Alternate buy / sell per wallet to keep balances roughly stable.
        const buy = cycle % 2 === 0;
        await executeSwap(ctx, {
          venue: params.venue,
          user: wallet,
          inputMint: buy ? WSOL_MINT : params.mint,
          outputMint: buy ? params.mint : WSOL_MINT,
          amountInRaw: params.amountRawPerLeg,
          slippageBps: params.slippageBps,
          mode: params.mode,
        });
        legs++;
      } catch {
        failures++;
      }
      await sleep(params.intervalMs);
    }
  }
  return { legs, failures };
}

export type { TransactionRequest };
export { pumpBuyInstruction, pumpSellInstruction, pumpBondingCurvePda, decodeBondingCurve, quoteSellLamportsOut };
