/**
 * Profit Pipeline — chains stealth relays → aggregator USDC swap → CEX
 * dispersal into one auditable operation.
 *
 * LEGS (all driven by the same `ctx` so mode/simulation propagates):
 *
 *   leg 1  STEALTH   source wallet → relay hops → terminus relay, using
 *                    `executeStealthTransfer` from stealth.ts. Randomized
 *                    leg amounts (±jitterBps) and randomized inter-leg
 *                    delays (≤maxStealthDelayMs) break the direct
 *                    source→profit graph edge.
 *   leg 2  SWAP      terminus relay swaps SOL → USDC via the Jupiter
 *                    aggregator (`jupiterSwapPlan` + `sendPrebuiltSwap`)
 *                    when `swapToUsdc`/`useJupiter` are enabled.
 *   leg 3  DISPERSE  terminus relay sends its USDC to each configured CEX
 *                    deposit address (SPL `transfer` + optional SPL Memo —
 *                    most exchanges credit deposits by memo).
 *
 * PRIVACY / COMPLIANCE: stealth relays are heuristic obfuscation only —
 * chain analysis can still correlate legs. Nothing here guarantees
 * anonymity. CEX dispersal requires exchange deposit addresses the
 * operator controls. Simulation mode is honored end-to-end.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import { jupiterSwapPlan, sendPrebuiltSwap, type DexContext } from '@solana-toolkit/dex';
import { USDC_MINT, WSOL_MINT } from '@solana-toolkit/solana-programs';
import type { ServiceContext } from './context.js';
import { executeStealthTransfer } from './stealth.js';

const log = moduleLogger('profit-pipeline');

/** USDC has 6 decimals on mainnet. */
export const USDC_DECIMALS = 6;

/** One CEX deposit destination for the dispersal leg. */
export interface CexDispersalConfig {
  /** On-chain deposit address owning the USDC ATA. */
  address: string;
  /** Deposit memo — most exchanges route sub-account credits by memo. */
  memo?: string;
  /** Label for logs/audit (e.g. 'binance-main'). */
  label?: string;
}

/** Configuration for a single pipeline run. */
export interface ProfitPipelineConfig {
  /** Route profit through stealth relay hops first. */
  stealthEnabled: boolean;
  /** Fresh single-use relay wallets; last one becomes the terminus. */
  relayWallets: Keypair[];
  /** Number of stealth legs to split across (capped at relay count). */
  stealthLegs: number;
  /** Amount randomization per leg, ±jitterBps around equal split. */
  jitterBps: number;
  /** Max randomized delay between stealth legs (ms). */
  maxStealthDelayMs: number;
  /** Swap terminus SOL → USDC before dispersal. */
  swapToUsdc: boolean;
  /** Slippage for the aggregator swap (bps). */
  swapSlippageBps: number;
  /** Use Jupiter for the swap leg (requires jupiterApiBase on ctx or config). */
  useJupiter: boolean;
  /** Optional Jupiter base URL when ctx lacks one (ServiceContext path). */
  jupiterApiBase?: string;
  /** CEX deposit destinations for final USDC dispersal. */
  cexConfigs: CexDispersalConfig[];
  /** Pacing delay between pipeline steps (ms). */
  delayBetweenStepsMs: number;
}

/** Per-leg errors are collected, never thrown — the report is complete. */
export interface ProfitPipelineError {
  leg: 'stealth' | 'swap' | 'disperse';
  message: string;
}

export interface ProfitPipelineResult {
  success: boolean;
  /** Total USDC (raw, 6 decimals) received by the terminus swap leg. */
  totalUsdcReceived: bigint;
  /** Total USDC (raw) dispersed across CEX destinations. */
  totalCexDispersed: bigint;
  /** Lamports routed through the stealth leg. */
  lamportsRouted: bigint;
  /** Signatures produced by each leg (audit trail). */
  signatures: string[];
  errors: ProfitPipelineError[];
}

export interface StartProfitPipelineParams {
  /** Wallet holding the realized profit (funds every leg). */
  sourceWallet: Keypair;
  /** Profit amount in lamports to route. */
  profitLamports: bigint;
  config: ProfitPipelineConfig;
  mode?: 'simulate' | 'execute';
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
}

/**
 * Runs the full profit pipeline and returns a complete audit result.
 * A failure in one leg is recorded and the pipeline stops — downstream
 * legs can't run without their upstream output (e.g. no USDC to disperse
 * if the swap leg failed).
 */
export async function startProfitPipeline(
  ctx: ServiceContext | DexContext,
  params: StartProfitPipelineParams,
): Promise<ProfitPipelineResult> {
  const { sourceWallet, profitLamports, config } = params;
  const mode = params.mode ?? 'simulate';
  const rng = params.rng ?? Math.random;

  const result: ProfitPipelineResult = {
    success: false,
    totalUsdcReceived: 0n,
    totalCexDispersed: 0n,
    lamportsRouted: 0n,
    signatures: [],
    errors: [],
  };

  if (profitLamports <= 0n) {
    result.errors.push({ leg: 'stealth', message: 'nothing to route: profitLamports <= 0' });
    return result;
  }

  // Terminus = last relay. When stealth is disabled or no relays exist,
  // the source wallet itself is the terminus (direct route, no obfuscation).
  const terminus = config.stealthEnabled && config.relayWallets.length > 0
    ? config.relayWallets[config.relayWallets.length - 1]!
    : sourceWallet;

  // -------------------------------------------------------------- leg 1: STEALTH
  // source → relay hops → terminus. We reuse `executeStealthTransfer`
  // (stealth.ts) which splits `totalLamports` into `legs` randomized
  // amounts and inserts randomized per-leg delays. Hops are the relays
  // BEFORE the terminus so the terminus is the unique destination.
  if (config.stealthEnabled && config.relayWallets.length > 1) {
    try {
      const hops = config.relayWallets.slice(0, -1);
      const { plan, outcomes } = await executeStealthTransfer(ctx, {
        source: sourceWallet,
        destination: terminus.publicKey.toBase58(),
        totalLamports: profitLamports,
        relays: hops,
        legs: Math.min(config.stealthLegs, config.relayWallets.length - 1),
        jitterBps: config.jitterBps,
        maxDelayMs: config.maxStealthDelayMs,
        mode,
        rng,
      });
      result.lamportsRouted = plan.totalLamports;
      for (const o of outcomes) if (o.signature) result.signatures.push(o.signature);
      log.info({ legs: plan.legs.length }, 'profit pipeline: stealth leg complete');
    } catch (err) {
      result.errors.push({ leg: 'stealth', message: msg(err) });
      return result; // can't swap/disperse funds that never arrived
    }
    await sleep(config.delayBetweenStepsMs);
  } else {
    // Direct transfer source → terminus only needed if terminus != source.
    if (terminus !== sourceWallet) {
      try {
        const { SystemProgram } = await import('@solana/web3.js');
        const outcome = await ctx.sender.send(
          {
            description: 'direct profit transfer to terminus (stealth disabled)',
            feePayer: sourceWallet.publicKey.toBase58(),
            instructions: [
              SystemProgram.transfer({
                fromPubkey: sourceWallet.publicKey,
                toPubkey: terminus.publicKey,
                lamports: profitLamports,
              }),
            ],
            signers: [sourceWallet],
          },
          { mode },
        );
        result.lamportsRouted = profitLamports;
        if (outcome.signature) result.signatures.push(outcome.signature);
      } catch (err) {
        result.errors.push({ leg: 'stealth', message: msg(err) });
        return result;
      }
      await sleep(config.delayBetweenStepsMs);
    } else {
      result.lamportsRouted = profitLamports;
    }
  }

  // -------------------------------------------------------------- leg 2: SWAP
  // SOL → USDC via the Jupiter aggregator so dispersal lands in a stable
  // asset. The terminus keeps ~0.001 SOL for the dispersal transfer fees.
  const usdcMint = new PublicKey(USDC_MINT);
  const jupiterApiBase =
    'jupiterApiBase' in ctx ? ctx.jupiterApiBase : config.jupiterApiBase;
  let usdcToDisperse = 0n;

  if (config.swapToUsdc && config.useJupiter) {
    if (!jupiterApiBase) {
      result.errors.push({
        leg: 'swap',
        message: 'useJupiter enabled but no jupiterApiBase available on ctx or config',
      });
      return result;
    }
    try {
      const relayBalance = await ctx.rpc.balance(terminus.publicKey.toBase58());
      const swapIn = relayBalance - 1_000_000n; // fee headroom for leg 3
      if (swapIn <= 0n) throw new Error(`terminus balance too low: ${relayBalance}`);
      // Jupiter needs a DexContext (jupiterApiBase + rpc/sender). `ctx` is
      // either a real DexContext or a ServiceContext, which is structurally
      // compatible for quote+swap calls; only jupiterApiBase is guaranteed
      // by the guard above.
      const jupiterCtx = { ...(ctx as unknown as DexContext), jupiterApiBase };
      const { swapTransaction } = await jupiterSwapPlan(jupiterCtx, {
        user: terminus,
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amountInRaw: swapIn,
        slippageBps: config.swapSlippageBps,
        wrapAndUnwrapSol: true,
      });
      const sent = await sendPrebuiltSwap(
        jupiterCtx,
        { user: terminus, swapTransaction, mode, jito: false },
      );
      result.signatures.push(sent.signature);
      // Read the terminus USDC ATA post-swap to learn the dispersal total.
      if (mode === 'execute') {
        const ata = getAssociatedTokenAddressSync(usdcMint, terminus.publicKey, true, TOKEN_PROGRAM_ID);
        const bal = await ctx.rpc.connection.getTokenAccountBalance(ata);
        usdcToDisperse = BigInt(bal.value.amount);
      } else {
        usdcToDisperse = swapIn / 2n; // simulated estimate for reporting
      }
      result.totalUsdcReceived = usdcToDisperse;
      log.info({ sig: sent.signature, usdc: usdcToDisperse.toString() }, 'profit pipeline: USDC swap complete');
    } catch (err) {
      result.errors.push({ leg: 'swap', message: msg(err) });
      return result;
    }
    await sleep(config.delayBetweenStepsMs);
  } else {
    // No USDC leg — dispersal operates on native SOL instead.
    const relayBalance = await ctx.rpc.balance(terminus.publicKey.toBase58()).catch(() => 0n);
    usdcToDisperse = relayBalance - 1_000_000n;
    result.totalUsdcReceived = 0n;
  }

  // -------------------------------------------------------------- leg 3: DISPERSE
  // Send the terminus' USDC to each CEX deposit address. Equal split
  // across destinations; the SPL Memo instruction rides alongside the
  // transfer so exchange sub-accounts credit correctly.
  if (config.cexConfigs.length === 0) {
    log.info('no CEX dispersal configs — pipeline ends at terminus wallet');
    result.success = result.errors.length === 0;
    return result;
  }

  const perCex = usdcToDisperse > 0n ? usdcToDisperse / BigInt(config.cexConfigs.length) : 0n;
  for (const cex of config.cexConfigs) {
    try {
      const amount = mode === 'simulate' ? 1n : perCex;
      if (amount <= 0n) continue;
      const terminusAta = getAssociatedTokenAddressSync(usdcMint, terminus.publicKey, true, TOKEN_PROGRAM_ID);
      const destAta = getAssociatedTokenAddressSync(
        usdcMint,
        new PublicKey(cex.address),
        true,
        TOKEN_PROGRAM_ID,
      );
      const instructions: TransactionInstruction[] = [
        createTransferInstruction(terminusAta, destAta, terminus.publicKey, amount, [], TOKEN_PROGRAM_ID),
      ];
      // SPL Memo v2 — required by exchanges that credit by deposit memo.
      if (cex.memo) {
        instructions.push(
          new TransactionInstruction({
            programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            keys: [],
            data: Buffer.from(cex.memo, 'utf8'),
          }),
        );
      }
      const outcome = await ctx.sender.send(
        {
          description: `disperse USDC → ${cex.label ?? cex.address.slice(0, 8)}`,
          feePayer: terminus.publicKey.toBase58(),
          instructions,
          signers: [terminus],
        },
        { mode },
      );
      if (outcome.signature) result.signatures.push(outcome.signature);
      result.totalCexDispersed += perCex;
      log.info({ destination: cex.label ?? cex.address.slice(0, 8) }, 'profit pipeline: CEX dispersal sent');
    } catch (err) {
      result.errors.push({ leg: 'disperse', message: `${cex.address}: ${msg(err)}` });
    }
    await sleep(config.delayBetweenStepsMs);
  }

  result.success = result.errors.length === 0;
  return result;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
