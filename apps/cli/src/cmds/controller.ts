/**
 * Lifecycle Controller CLI commands for managing token launches
 * using the new controller-based architecture.
 *
 * @module
 */

import { Command } from 'commander';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  LifecycleController,
  runLifecycle,
  simulateLifecycle,
  DEFAULT_LIFECYCLE_CONFIG,
  type LifecycleConfig,
  type LifecycleResult,
  type LifecycleStage,
} from '@solana-toolkit/services';
import { writeJson } from '@solana-toolkit/utils';

export function registerControllerCommand(program: Command): void {
  // Main controller command group
  const controllerCmd = program
    .command('controller')
    .description('Lifecycle controller for token launches')
    .option('--dry-run', 'run in dry-run mode (simulate all operations)');

  // Subcommand: run full lifecycle
  controllerCmd
    .command('run')
    .description('Run the complete lifecycle using the controller')
    .requiredOption('--token-name <name>', 'token name')
    .requiredOption('--token-symbol <symbol>', 'token symbol')
    .requiredOption('--metadata-uri <uri>', 'metadata URI')
    .option('--launch-venue <venue>', 'launch venue: pumpfun | moonit | raydium', 'pumpfun')
    .option('--buyer-count <count>', 'number of buyer wallets', (v) => parseInt(v, 10), 28)
    .option('--buy-amount <lamports>', 'SOL amount per buyer in lamports (default 100000000)', (v) => BigInt(v))
    .option('--slippage-bps <bps>', 'slippage tolerance in basis points', (v) => parseInt(v, 10), 100)
    .option('--target-holders <count>', 'target number of holders before freeze', (v) => parseInt(v, 10), 100)
    .option('--max-hold-seconds <seconds>', 'maximum hold time in seconds', (v) => parseInt(v, 10), 3600)
    .option('--enable-mm', 'enable market making')
    .option('--enable-txn-gen', 'enable transaction generation')
    .option('--enable-freeze', 'enable auto-freeze when target holders reached')
    .option('--enable-exit', 'enable automatic exit')
    .option('--enable-social', 'enable social promotion')
    .option('--route-to-usdc', 'route profits to USDC')
    .option('--dry-run', 'run in dry-run mode (simulate all operations)')
    .option('--treasury-funder <file>', 'persistent root keystore that funds each fresh rotated treasury (required for execute mode)')
    .option('--freeze-authority <file>', 'keystore of the mint freeze authority (enables the freeze stage)')
    .option('--profit-wallet <file>', 'keystore holding realized SOL profits (used by the exit stage)')
    .action(async (opts: GlobalOptions & {
      tokenName: string;
      tokenSymbol: string;
      metadataUri: string;
      launchVenue?: string;
      buyerCount?: number;
      buyAmount?: bigint;
      slippageBps?: number;
      targetHolders?: number;
      maxHoldSeconds?: number;
      enableMm?: boolean;
      enableTxnGen?: boolean;
      enableFreeze?: boolean;
      enableExit?: boolean;
      enableSocial?: boolean;
      routeToUsdc?: boolean;
      dryRun?: boolean;
      treasuryFunder?: string;
      freezeAuthority?: string;
      profitWallet?: string;
    }) => {
      const { services, mode } = await bootstrap({ ...opts, execute: opts.execute });
      const dryRun = opts.dryRun || mode === 'simulate';

      // Persistent wallets loaded from keystores (optional; the controller
      // warns and degrades when they are missing).
      const treasuryFunder = opts.treasuryFunder ? await loadWallet(opts.treasuryFunder) : undefined;
      const freezeAuthority = opts.freezeAuthority ? await loadWallet(opts.freezeAuthority) : undefined;
      const profitWallet = opts.profitWallet ? await loadWallet(opts.profitWallet) : undefined;

      const config: Partial<LifecycleConfig> = {
        // Token configuration
        tokenName: opts.tokenName,
        tokenSymbol: opts.tokenSymbol,
        metadataUri: opts.metadataUri,
        tokenDecimals: 9,
        tokenSupplyRaw: 1_000_000_000_000_000_000n, // 1M tokens

        // Launch configuration
        launchVenue: opts.launchVenue as any,
        buyerWalletCount: opts.buyerCount,
        buyLamportsPerWallet: opts.buyAmount ?? 100_000_000n,
        slippageBps: opts.slippageBps,
        useJito: true,

        // Market making
        mmEnabled: opts.enableMm,
        mmBuyAmountRaw: 50_000_000n,
        mmSellAmountRaw: 100_000_000n,
        mmIntervalMs: 5_000,
        mmRounds: 10,

        // Transaction generation
        txnGenerationEnabled: opts.enableTxnGen,
        txnCycles: 5,
        txnAmountRaw: 10_000_000n,
        txnIntervalMs: 2_000,

        // Holder targets
        targetHolders: opts.targetHolders,
        freezeWhenHoldersReached: opts.enableFreeze,
        revokeAuthoritiesAfterFreeze: true,

        // Exit
        exitEnabled: opts.enableExit,
        takeProfitMultiplier: 2.0,
        stopLossFraction: 0.5,
        maxHoldSeconds: opts.maxHoldSeconds,

        // Social promotion
        socialPromotionEnabled: opts.enableSocial,

        // Profit pipeline
        routeThroughJupiter: opts.routeToUsdc,

        // Anonymity
        relayWalletCount: 5,
        anonymityConfig: {
          stealthEnabled: true,
          stealthLegs: 4,
          jitterBps: 1000,
          maxStealthDelayMs: 10_000,
          randomizedTimingEnabled: true,
          maxInterBuyerDelayMs: 8_000,
          treasuryRotationEnabled: true,
          freshBuyersPerLaunch: true,
        },
      };

      // Create and run the controller
      const controller = new LifecycleController({
        ctx: services,
        config: config as LifecycleConfig,
        dryRun,
        treasuryFunder,
        freezeAuthority,
        profitWallet,
      });

      const result: LifecycleResult = await controller.start();

      // Build summary
      const summary = {
        success: result.success,
        currentStage: result.currentStage,
        durationMs: result.durationMs,
        stages: result.stages.map(s => ({
          stage: s.stage,
          success: s.success,
          message: s.message,
          durationMs: s.durationMs,
        })),
        errors: result.errors.map(e => e.message),
        mintAddress: result.mintAddress,
      };

      writeJson('output/controller-summary.json', summary);
      printResult(opts, summary);
    });

  // Subcommand: simulate lifecycle
  controllerCmd
    .command('simulate')
    .description('Simulate the complete lifecycle without real transactions')
    .requiredOption('--token-name <name>', 'token name')
    .requiredOption('--token-symbol <symbol>', 'token symbol')
    .requiredOption('--metadata-uri <uri>', 'metadata URI')
    .option('--launch-venue <venue>', 'launch venue: pumpfun | moonit | raydium', 'pumpfun')
    .action(async (opts: GlobalOptions & {
      tokenName: string;
      tokenSymbol: string;
      metadataUri: string;
      launchVenue?: string;
    }) => {
      const { services } = await bootstrap({ ...opts, execute: false });

      const result = await simulateLifecycle(services, {
        tokenName: opts.tokenName,
        tokenSymbol: opts.tokenSymbol,
        metadataUri: opts.metadataUri,
        launchVenue: opts.launchVenue as LifecycleConfig['launchVenue'],
      });

      const summary = {
        success: result.success,
        currentStage: result.currentStage,
        durationMs: result.durationMs,
        stages: result.stages.map(s => ({
          stage: s.stage,
          success: s.success,
          message: s.message,
        })),
        note: 'All operations were simulated - no real transactions executed',
      };

      printResult(opts, summary);
    });

  // Subcommand: check current stage
  controllerCmd
    .command('stage')
    .description('Check the current stage of a running lifecycle')
    .action(async (opts: GlobalOptions) => {
      // This would connect to a running controller in a real implementation
      // For now, just show available stages
      const stages: LifecycleStage[] = [
        'creation',
        'pre-launch',
        'launch',
        'market-making',
        'monitoring',
        'freeze',
        'exit',
        'consolidation',
        'social-promo',
        'complete',
        'error',
      ];

      printResult(opts, {
        message: 'Available lifecycle stages',
        stages,
        note: 'Use the controller run command to execute the lifecycle',
      });
    });

  // Subcommand: show default configuration
  controllerCmd
    .command('config')
    .description('Show default lifecycle configuration')
    .action(async (opts: GlobalOptions) => {
      printResult(opts, {
        message: 'Default lifecycle configuration',
        config: DEFAULT_LIFECYCLE_CONFIG,
      });
    });
}
