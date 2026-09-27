/**
 * End-to-end lifecycle automation:
 *   create token → launch on Pump.fun/Moonit/Raydium → bundled buy/snipe →
 *   monitor → automated exit → consolidate proceeds.
 *
 * Driven entirely by a YAML or JSON configuration file.
 *
 * This module now supports both the legacy stage-based approach and the new
 * controller-based approach with enhanced anonymity, social promotion,
 * and automatic profit pipeline.
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { assertLifecycleConfigShape, parseConfigFile, writeJson } from '@solana-toolkit/utils';
import type { LifecycleConfig } from '@solana-toolkit/types';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import { createToken } from '@solana-toolkit/services';
import { pumpfunLaunchBuy, moonitLaunchBuy, raydiumAmmV4Launch } from '@solana-toolkit/dex';
import { watchPumpfunCurve } from '@solana-toolkit/dex';
import { runAutoSell } from '@solana-toolkit/dex';
import { consolidateAllAssets, fundWallet } from '@solana-toolkit/services';
import { generateBatchWallets } from '@solana-toolkit/wallet-manager';

// New imports for the refactored architecture
import {
  LifecycleController,
  type LifecycleResult,
  type AnonymityConfig,
  MINIMAL_ANONYMITY_CONFIG,
} from '@solana-toolkit/services';
import type { LifecycleConfig as LifecycleControllerConfig } from '@solana-toolkit/services';

export function registerLifecycleCommand(program: Command): void {
  program
    .command('lifecycle')
    .description('Run the full create → launch → buy → monitor → exit → consolidate lifecycle from a config file')
    .requiredOption('--config <file>', 'lifecycle config (YAML or JSON)')
    .option('--stage <name>', 'run only one stage: create | launch | monitor | exit | consolidate')
    .option('--use-controller', 'use the new controller-based lifecycle manager')
    .option('--dry-run', 'run in dry-run mode (simulate all operations)')
    .option('--anonymity <level>', 'anonymity level: default | strict | minimal')
    .action(async (opts: GlobalOptions & {
      config: string;
      stage?: string;
      useController?: boolean;
      dryRun?: boolean;
      anonymity?: string;
    }) => {
      const cfg = parseConfigFile<LifecycleConfig>(opts.config);
      assertLifecycleConfigShape(cfg);

      // Determine if we're using the new controller or legacy approach
      const useController = opts.useController ?? false;

      if (useController) {
        // Use the new controller-based lifecycle
        await runControllerLifecycle(opts, cfg);
      } else {
        // Use the legacy stage-based approach
        await runLegacyLifecycle(opts, cfg);
      }
    });
}

/**
 * Run lifecycle using the new controller-based approach.
 */
async function runControllerLifecycle(
  opts: GlobalOptions & {
    config: string;
    stage?: string;
    useController?: boolean;
    dryRun?: boolean;
    anonymity?: string;
  },
  cfg: LifecycleConfig,
): Promise<void> {
  const forcedSimulate = cfg.simulationMode === true;
  const { services, dex, mode } = await bootstrap({
    ...opts,
    execute: forcedSimulate ? false : opts.execute,
  });
  const runMode = forcedSimulate ? 'simulate' : mode;

  // Map anonymity level to config
  const anonymityConfig: Partial<AnonymityConfig> | undefined = opts.anonymity
    ? mapAnonymityLevel(opts.anonymity)
    : undefined;

  // Create lifecycle configuration for the controller. Fields with no
  // counterpart in the on-disk lifecycle config fall back to the
  // controller's own defaults.
  const controllerConfig = {
    // Token configuration
    tokenName: cfg.create.name,
    tokenSymbol: cfg.create.symbol,
    tokenDecimals: cfg.create.decimals,
    tokenSupplyRaw: BigInt(cfg.create.totalSupplyRaw),
    metadataUri: cfg.create.metadataUri,
    tokenProgram: cfg.create.tokenProgram,

    // Launch configuration
    launchVenue: (cfg.launch.launchpad === 'raydium-amm-v4' ? 'raydium' : cfg.launch.launchpad) as never,
    buyerWalletCount: cfg.launch.bundledBuyers,
    buyLamportsPerWallet: BigInt(cfg.launch.buyLamportsPerWallet),
    slippageBps: cfg.launch.slippageBps,
    useJito: BigInt(cfg.launch.jitoTipLamports) > 0n,

    // Exit configuration
    exitEnabled: cfg.exit.enabled,
    takeProfitMultiplier: cfg.exit.takeProfitMultiplier ?? 2.0,
    stopLossFraction: cfg.exit.stopLossFraction ?? 0.5,
    maxHoldSeconds: cfg.exit.maxHoldSeconds ?? 3600,

    // Anonymity configuration
    anonymityConfig,
    relayWalletCount: 5,

    // Profit pipeline
    routeThroughJupiter: true,

    // Social promotion
    socialConfig: [],
    socialPromotionEnabled: true,

    // Monitoring
    monitorIntervalMs: cfg.monitor.intervalMs,
    verboseMonitoring: cfg.monitor.verbose,
  } as Partial<LifecycleControllerConfig>;

  // The config's persistent treasury keystore funds every fresh rotated
  // treasury the controller generates (fresh treasuries start at 0 SOL).
  const treasuryFunder = await loadWallet(cfg.treasuryKeystore);

  // Create and run the controller
  const controller = new LifecycleController({
    ctx: services,
    config: controllerConfig as LifecycleControllerConfig,
    dryRun: opts.dryRun ?? forcedSimulate,
    anonymityConfig: anonymityConfig as AnonymityConfig,
    treasuryFunder,
  });

  const result: LifecycleResult = await controller.start();

  // Build summary output
  const summary: Record<string, unknown> = {
    stages: result.stages.map(s => ({
      stage: s.stage,
      success: s.success,
      message: s.message,
      durationMs: s.durationMs,
    })),
    currentStage: result.currentStage,
    success: result.success,
    durationMs: result.durationMs,
    mintAddress: result.mintAddress,
    errors: result.errors.map(e => e.message),
    warnings: result.errors.length > 0 ? ['Check error logs for details'] : [],
  };

  if (result.monitorData) {
    summary['monitorData'] = {
      currentPrice: result.monitorData.currentPrice,
      entryPrice: result.monitorData.entryPrice,
      holdersCount: result.monitorData.holdersCount,
      volume24h: result.monitorData.volume24h.toString(),
    };
  }

  writeJson('output/lifecycle-summary.json', summary);
  printResult(opts, summary);
}

/**
 * Run lifecycle using the legacy stage-based approach.
 * This is kept for backward compatibility.
 */
async function runLegacyLifecycle(
  opts: GlobalOptions & {
    config: string;
    stage?: string;
    useController?: boolean;
    dryRun?: boolean;
    anonymity?: string;
  },
  cfg: LifecycleConfig,
): Promise<void> {
  const forcedSimulate = cfg.simulationMode === true;
  const { services, dex, mode } = await bootstrap({
    ...opts,
    execute: forcedSimulate ? false : opts.execute,
  });
  const runMode = forcedSimulate ? 'simulate' : mode;
  const stage = opts.stage;
  const summary: Record<string, unknown> = { stages: [] };

  const treasury = await loadWallet(cfg.treasuryKeystore);

  // Ensure buyer wallets exist.
  let buyerFiles: string[];
  const batchFile = path.join(cfg.buyerKeystoreDir, 'batch.json');
  if (!fs.existsSync(batchFile)) {
    const password = process.env['SOLADMIN_KEYSTORE_PASSWORD'] ?? 'change-me';
    const generated = generateBatchWallets({
      outDir: cfg.buyerKeystoreDir,
      count: cfg.launch.bundledBuyers,
      labelPrefix: 'buyer',
      password,
    });
    buyerFiles = generated.keystores;
    summary['buyerWallets'] = { generated: generated.wallets.length, dir: cfg.buyerKeystoreDir };
  } else {
    buyerFiles = (JSON.parse(fs.readFileSync(batchFile, 'utf8')) as { wallets: { label: string }[] }).wallets.map(
      (w) => path.join(cfg.buyerKeystoreDir, `${w.label}.keystore.json`),
    );
  }
  const buyers = [];
  for (const f of buyerFiles) buyers.push(await loadWallet(f));

  // ---------------------------------------------------------------- create
  let mint: string | undefined;
  if (cfg.create.enabled && (!stage || stage === 'create')) {
    const creation = await createToken(services, {
      payer: treasury,
      mode: runMode,
      metadata: {
        name: cfg.create.name,
        symbol: cfg.create.symbol,
        uri: cfg.create.metadataUri,
      },
      decimals: cfg.create.decimals,
      initialSupplyRaw: BigInt(cfg.create.totalSupplyRaw),
      tokenProgram: cfg.create.tokenProgram,
      transferFee: cfg.create.extensions?.transferFeeBps
        ? { bps: cfg.create.extensions.transferFeeBps, maxFeeRaw: BigInt(cfg.create.extensions.transferFeeMaxRaw ?? '1000000000') }
        : undefined,
      transferHookProgramId: undefined,
      keepMintAuthority: false,
      keepFreezeAuthority: false,
      revokeMetadataAuthority: true,
    });
    mint = creation.mint;
    summary['create'] = creation;
    (summary['stages'] as string[]).push('create');
  }

  // ---------------------------------------------------------------- launch
  let launchMint = mint;
  if ((!stage || stage === 'launch') && cfg.launch.launchpad) {
    const buySolPer = BigInt(cfg.launch.buyLamportsPerWallet);
    // Fund buyers (execution mode only; simulation skips transfers).
    if (runMode === 'execute') {
      for (const buyer of buyers) {
        await fundWallet(services, {
          funder: treasury,
          destination: buyer.publicKey,
          lamports: buySolPer + 20_000n,
          mode: runMode,
        });
      }
    }
    const slippage = cfg.launch.slippageBps;
    if (cfg.launch.launchpad === 'pumpfun') {
      const result = await pumpfunLaunchBuy(dex, {
        treasury,
        name: cfg.create.name,
        symbol: cfg.create.symbol,
        uri: cfg.create.metadataUri,
        buyers,
        buyLamportsPerBuyer: buySolPer,
        slippageBps: slippage,
        mode: runMode,
      });
      launchMint ??= result.mint;
      summary['launch'] = { launchpad: 'pumpfun', mint: result.mint, outcomes: result.outcomes.length };
    } else if (cfg.launch.launchpad === 'moonit') {
      const result = await moonitLaunchBuy(dex, {
        treasury,
        launch: {
          name: cfg.create.name,
          symbol: cfg.create.symbol,
          description: `${cfg.create.name} on Moonit`,
          imageFilePath: cfg.create.imageFilePath ?? cfg.create.metadataUri,
          decimals: cfg.create.decimals,
          totalSupplyRaw: BigInt(cfg.create.totalSupplyRaw),
          collateralCollectedLamports: buySolPer,
          curveType: 'classic',
        },
        buyers,
        buyLamportsPerBuyer: buySolPer,
        slippageBps: slippage,
        mode: runMode,
      });
      launchMint ??= result.mint;
      summary['launch'] = { launchpad: 'moonit', mint: result.mint };
    } else if (cfg.launch.launchpad === 'raydium-amm-v4') {
      if (!launchMint) throw new Error('raydium launch requires the create stage or an existing mint');
      const { PublicKey } = await import('@solana/web3.js');
      const { WSOL_MINT } = await import('@solana-toolkit/solana-programs');
      const result = await raydiumAmmV4Launch(dex, {
        treasury,
        baseMint: new PublicKey(launchMint),
        quoteMint: new PublicKey(WSOL_MINT),
        baseDecimals: cfg.create.decimals,
        quoteDecimals: 9,
        baseAmountRaw: BigInt(cfg.create.totalSupplyRaw) / 2n,
        quoteAmountRaw: buySolPer * BigInt(buyers.length),
        mode: runMode,
      });
      summary['launch'] = { launchpad: 'raydium-amm-v4', market: result.marketId, pool: result.poolId };
    }
    (summary['stages'] as string[]).push('launch');
  }

  // --------------------------------------------------------------- monitor
  if (cfg.monitor.enabled && (!stage || stage === 'monitor') && launchMint) {
    const watch = await watchPumpfunCurve(dex, launchMint, (snapshot) => {
      // eslint-disable-next-line no-console
      console.log(
        `[monitor] price=${snapshot.priceSolPerToken.toExponential(3)} SOL/tok complete=${snapshot.complete}`,
      );
    });
    const deadline = Date.now() + (cfg.monitor.intervalMs > 0 ? Math.min(cfg.monitor.intervalMs, 60_000) : 30_000);
    while (Date.now() < deadline && !watch.latest()?.complete) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await watch.unsubscribe();
    summary['monitor'] = watch.latest();
    (summary['stages'] as string[]).push('monitor');
  }

  // ------------------------------------------------------------------ exit
  if (cfg.exit.enabled && (!stage || stage === 'exit') && launchMint) {
    const exits = [];
    for (const buyer of buyers) {
      const report = await runAutoSell(dex, {
        wallet: buyer,
        mint: launchMint,
        venue: cfg.exit.route === 'pumpfun' ? 'pumpfun' : cfg.exit.route as never,
        entryPriceSol: 0.000000001, // placeholder; production reads the launch fill
        slippageBps: cfg.exit.slippageBps,
        mode: runMode,
        trigger: {
          takeProfitMultiplier: cfg.exit.takeProfitMultiplier,
          stopLossFraction: cfg.exit.stopLossFraction,
          timeoutSeconds: cfg.exit.maxHoldSeconds,
        },
      });
      exits.push({ wallet: buyer.publicKey.toBase58(), sold: report.sold, reason: report.reason });
    }
    summary['exit'] = exits;
    (summary['stages'] as string[]).push('exit');
  }

  // ----------------------------------------------------------- consolidate
  if (cfg.consolidate.enabled && (!stage || stage === 'consolidate')) {
    const destinationKp = await loadWallet(cfg.consolidate.destinationKeystore);
    const report = await consolidateAllAssets(services, {
      wallets: buyers,
      destination: destinationKp.publicKey.toBase58(),
      swapTokensToSol: cfg.consolidate.swapTokensToSol,
      leaveLamportsPerWallet: cfg.consolidate.leaveLamportsPerWallet
        ? BigInt(cfg.consolidate.leaveLamportsPerWallet)
        : 0n,
      slippageBps: cfg.consolidate.slippageBps,
      mode: runMode,
    });
    summary['consolidate'] = {
      solTransferred: report.solTransferred.toString(),
      outcomes: report.outcomes.length,
      failures: report.failures.length,
    };
    (summary['stages'] as string[]).push('consolidate');
  }

  writeJson('output/lifecycle-summary.json', summary);
  printResult(opts, summary);
}

/**
 * Map anonymity level string to configuration.
 */
function mapAnonymityLevel(level: string): Partial<AnonymityConfig> {
  switch (level.toLowerCase()) {
    case 'strict':
      return {
        stealthEnabled: true,
        stealthLegs: 5,
        jitterBps: 2000,
        maxStealthDelayMs: 15_000,
        randomizedTimingEnabled: true,
        maxInterBuyerDelayMs: 12_000,
        treasuryRotationEnabled: true,
        freshBuyersPerLaunch: true,
        randomizeFundingAmounts: true,
        maxFundingDeviationBps: 2000,
      };
    case 'minimal':
      return MINIMAL_ANONYMITY_CONFIG;
    case 'default':
    default:
      return {};
  }
}
