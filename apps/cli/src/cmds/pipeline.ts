/**
 * Profit Pipeline CLI commands — route realized SOL profit through stealth
 * relay hops, an aggregator USDC swap, and CEX deposit dispersal.
 *
 * The pipeline is one auditable operation; every leg honors simulation
 * mode, so `--execute` is required (plus SOLADMIN_SIMULATION_MODE=false)
 * before anything reaches the network.
 * @module
 */

import { Command } from 'commander';
import { Keypair } from '@solana/web3.js';
import { writeJson } from '@solana-toolkit/utils';
import { USDC_MINT } from '@solana-toolkit/solana-programs';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  startProfitPipeline,
  createFreshRelayWallets,
  type CexDispersalConfig,
  type ProfitPipelineConfig,
  type ProfitPipelineResult,
} from '@solana-toolkit/services';

export function registerPipelineCommand(program: Command): void {
  const pipelineCmd = program
    .command('pipeline')
    .description('Automatic profit routing: stealth relays → USDC swap → CEX dispersal');

  // Run the pipeline.
  pipelineCmd
    .command('run')
    .description('Run the profit pipeline (simulates unless --execute is passed)')
    .requiredOption('--source-wallet <file>', 'keystore file holding the realized profit')
    .requiredOption('--amount <lamports>', 'profit amount in lamports', (v) => BigInt(v))
    .option('--relays <count>', 'number of fresh relay wallets (terminus = last)', (v) => parseInt(v, 10), 4)
    .option('--stealth-legs <count>', 'stealth legs (capped at relay count)', (v) => parseInt(v, 10), 3)
    .option('--jitter-bps <bps>', 'per-leg amount jitter in bps', (v) => parseInt(v, 10), 1000)
    .option('--max-stealth-delay <ms>', 'max randomized inter-leg delay in ms', (v) => parseInt(v, 10), 10_000)
    .option('--no-stealth', 'skip stealth relays (direct transfer to terminus)')
    .option('--no-swap', 'skip the SOL → USDC aggregator swap')
    .option('--slippage-bps <bps>', 'swap slippage in bps', (v) => parseInt(v, 10), 50)
    .option('--cex <spec>', 'CEX deposit address (repeatable, "address[:memo][:label]")', collectCex, [])
    .option('--step-delay <ms>', 'pacing delay between pipeline steps in ms', (v) => parseInt(v, 10), 3_000)
    .action(async (opts: GlobalOptions & {
      sourceWallet: string;
      amount: bigint;
      relays?: number;
      stealthLegs?: number;
      jitterBps?: number;
      maxStealthDelay?: number;
      stealth?: boolean;
      swap?: boolean;
      slippageBps?: number;
      cex?: CexDispersalConfig[];
      stepDelay?: number;
    }) => {
      const { services, mode } = await bootstrap({ ...opts, execute: opts.execute });
      const source = await loadWallet(opts.sourceWallet);
      const relayCount = opts.relays ?? 4;

      const config: ProfitPipelineConfig = {
        stealthEnabled: opts.stealth !== false,
        relayWallets: createFreshRelayWallets(relayCount),
        stealthLegs: Math.min(opts.stealthLegs ?? 3, relayCount),
        jitterBps: opts.jitterBps ?? 1000,
        maxStealthDelayMs: opts.maxStealthDelay ?? 10_000,
        swapToUsdc: opts.swap !== false,
        swapSlippageBps: opts.slippageBps ?? 50,
        useJupiter: true,
        cexConfigs: opts.cex ?? [],
        delayBetweenStepsMs: opts.stepDelay ?? 3_000,
      };

      const result: ProfitPipelineResult = await startProfitPipeline(services, {
        sourceWallet: source,
        profitLamports: opts.amount,
        config,
        mode,
      });

      const summary = {
        success: result.success,
        mode,
        totalUsdcReceived: result.totalUsdcReceived.toString(),
        totalCexDispersed: result.totalCexDispersed.toString(),
        lamportsRouted: result.lamportsRouted.toString(),
        signatures: result.signatures,
        errors: result.errors,
        config: {
          stealthEnabled: config.stealthEnabled,
          relayCount,
          stealthLegs: config.stealthLegs,
          swapToUsdc: config.swapToUsdc,
          cexCount: config.cexConfigs.length,
        },
      };

      writeJson('output/pipeline-summary.json', summary);
      printResult(opts, summary);
    });

  // Simulate only (never reaches the network regardless of --execute).
  pipelineCmd
    .command('simulate')
    .description('Simulate the pipeline plan (no transactions are sent)')
    .requiredOption('--amount <lamports>', 'profit amount in lamports to simulate', (v) => BigInt(v))
    .option('--relays <count>', 'number of fresh relay wallets', (v) => parseInt(v, 10), 4)
    .action(async (opts: GlobalOptions & { amount: bigint; relays?: number }) => {
      const { services } = await bootstrap({ ...opts, execute: false });
      const relayCount = opts.relays ?? 4;
      const source = Keypair.generate();

      const result = await startProfitPipeline(services, {
        sourceWallet: source,
        profitLamports: opts.amount,
        mode: 'simulate',
        config: {
          stealthEnabled: true,
          relayWallets: createFreshRelayWallets(relayCount),
          stealthLegs: Math.min(3, relayCount),
          jitterBps: 1000,
          maxStealthDelayMs: 10_000,
          swapToUsdc: true,
          swapSlippageBps: 50,
          useJupiter: true,
          cexConfigs: [],
          delayBetweenStepsMs: 0,
        },
      });

      printResult(opts, {
        success: result.success,
        totalUsdcReceived: result.totalUsdcReceived.toString(),
        lamportsRouted: result.lamportsRouted.toString(),
        errors: result.errors,
        note: 'Simulated estimate — no transactions were sent',
      });
    });

  // Stablecoin reference.
  pipelineCmd
    .command('stablecoins')
    .description('Show the USDC mint used by the swap leg')
    .action(async (opts: GlobalOptions) => {
      printResult(opts, {
        usdcMint: USDC_MINT,
        decimals: 6,
      });
    });

  // Fee estimation.
  pipelineCmd
    .command('calculate-fees')
    .description('Estimate lamport fees for a stealth-routed pipeline')
    .requiredOption('--amount <lamports>', 'profit amount in lamports', (v) => BigInt(v))
    .option('--stealth-legs <count>', 'number of stealth legs', (v) => parseInt(v, 10), 3)
    .action(async (opts: GlobalOptions & { amount: bigint; stealthLegs?: number }) => {
      const legs = opts.stealthLegs ?? 3;
      // Each stealth leg = two transfers (source→relay, relay→destination);
      // the swap and one transfer per CEX destination add their own fees.
      const feePerTx = 5_000n;
      const stealthFees = feePerTx * BigInt(legs * 2);
      const swapFee = 5_000n;
      const total = stealthFees + swapFee;
      printResult(opts, {
        inputAmount: opts.amount.toString(),
        stealthLegs: legs,
        stealthFees: stealthFees.toString(),
        swapFee: swapFee.toString(),
        estimatedTotalFees: total.toString(),
        estimatedNet: (opts.amount - total).toString(),
      });
    });
}

/** Collects repeatable --cex "address[:memo][:label]" options. */
function collectCex(value: string, previous: CexDispersalConfig[]): CexDispersalConfig[] {
  const [address, memo, label] = value.split(':');
  if (!address) {
    throw new Error(`invalid --cex "${value}" — expected "address[:memo][:label]"`);
  }
  return [...previous, { address, memo: memo || undefined, label: label || undefined }];
}
