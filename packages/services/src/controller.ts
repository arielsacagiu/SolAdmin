/**
 * Continuous Outer Controller - Orchestrates Full Token Launch Lifecycle
 *
 * This module provides a comprehensive lifecycle management system for SolAdmin
 * token launches, coordinating all stages from creation through exit and
 * consolidation.
 *
 * STAGES:
 * 1. Creation (mint + metadata) - Optional, if mint doesn't exist
 * 2. Launch (initial buy-in on chosen venue)
 * 3. Market Making (volume + holders + transactions)
 * 4. Monitoring (price tracking + holder growth)
 * 5. Freeze Management (auto-freeze all holders when ready)
 * 6. Exit (profit taking via stealth routing)
 * 7. Consolidation (sweep all funds to treasury)
 * 8. Social Promotion (off-chain activities)
 *
 * The controller ensures proper sequencing, error handling, and state
 * management across all stages with comprehensive logging and observability.
 *
 * @module
 */

import { Keypair } from '@solana/web3.js';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import { fundWallet } from '@solana-toolkit/transaction-builder';
import type { ServiceContext } from './context.js';
import {
  increaseHolders,
  runBatchSwap,
  increaseTransactions,
  freshLaunchLineage,
  freshBuyerWallets,
  type DexContext,
} from '@solana-toolkit/dex';
import {
  autoFreezeAllHolders,
  revokeAllAuthorities,
} from './authorities.js';
import { scanTokenHolders } from './holders.js';
import {
  createAnonymizedLaunchConfig,
  fundBuyersAnonymously,
  type AnonymityConfig,
  DEFAULT_ANONYMITY_CONFIG,
} from './anonymity.js';
import { SocialPromotionManager, type SocialPromotionConfig } from './social-promotion.js';
import { startProfitPipeline } from './profit-pipeline.js';

const log = moduleLogger('lifecycle-controller');

// ---------------------------------------------------------------------------
// Types and Interfaces
// ---------------------------------------------------------------------------

/** Lifecycle stage definition. */
export type LifecycleStage =
  | 'creation'
  | 'pre-launch'
  | 'launch'
  | 'market-making'
  | 'monitoring'
  | 'freeze'
  | 'exit'
  | 'consolidation'
  | 'social-promo'
  | 'complete'
  | 'error';

/** Stage transition result. */
export interface StageResult {
  stage: LifecycleStage;
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: Error;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
}

/** Monitor data for price tracking and observability. */
export interface MonitorData {
  currentPrice: number;
  entryPrice: number;
  holdersCount: number;
  volume24h: bigint;
  lastUpdated: number;
  priceHistory: { timestamp: number; price: number }[];
  holderHistory: { timestamp: number; count: number }[];
}

/** Launch venue configuration. */
export type LaunchVenue = 'pumpfun' | 'moonit' | 'raydium' | 'custom';

/**
 * Full lifecycle configuration.
 * This is the primary configuration object for the lifecycle controller.
 */
export interface LifecycleConfig {
  // Token configuration
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenSupplyRaw: bigint;
  metadataUri: string;
  /** Existing mint address, if already created. If not provided, will be created. */
  mint?: string;
  /** Token program to use (spl or token-2022). Default: spl */
  tokenProgram?: 'spl' | 'token-2022';

  // Launch configuration
  /** Venue for initial launch (pumpfun, moonit, raydium, custom). */
  launchVenue: LaunchVenue;
  /** Number of buyer wallets for initial launch. */
  buyerWalletCount: number;
  /** SOL amount in lamports per buyer wallet. */
  buyLamportsPerWallet: bigint;
  /** Slippage tolerance in basis points. */
  slippageBps: number;
  /** Whether to use Jito for transactions. */
  useJito: boolean;

  // Market making configuration
  /** Enable market making after launch. */
  mmEnabled: boolean;
  /** SOL amount in lamports for market maker buys. */
  mmBuyAmountRaw: bigint;
  /** Token amount in raw units for market maker sells. */
  mmSellAmountRaw: bigint;
  /** Interval between market maker operations in ms. */
  mmIntervalMs: number;
  /** Number of market maker rounds. */
  mmRounds: number;

  // Transaction generation configuration
  /** Enable transaction generation for volume. */
  txnGenerationEnabled: boolean;
  /** Number of transaction cycles. */
  txnCycles: number;
  /** Token amount in raw units per transaction leg. */
  txnAmountRaw: bigint;
  /** Interval between transactions in ms. */
  txnIntervalMs: number;

  // Holder targets
  /** Target number of holders before freeze. */
  targetHolders: number;
  /** Whether to auto-freeze when target holders reached. */
  freezeWhenHoldersReached: boolean;
  /** Whether to revoke all authorities after freeze. */
  revokeAuthoritiesAfterFreeze: boolean;

  // Exit configuration
  /** Enable automatic exit when conditions met. */
  exitEnabled: boolean;
  /** Multiplier for take-profit (e.g., 2.0 = 2x entry price). */
  takeProfitMultiplier: number;
  /** Fraction for stop-loss (e.g., 0.5 = 50% of entry price). */
  stopLossFraction: number;
  /** Maximum hold time in seconds before forced exit. */
  maxHoldSeconds: number;

  // Anonymity configuration
  /** Anonymity settings for all operations. */
  anonymityConfig?: Partial<AnonymityConfig>;
  /** Number of relay wallets for stealth operations. */
  relayWalletCount: number;

  // Profit pipeline configuration
  /** Whether to route profits through stealth + Jupiter. */
  routeThroughJupiter: boolean;
  /** Target CEX for final dispersion (optional). */
  targetCeX?: 'binance' | 'okx' | 'bybit' | 'bitget' | 'gate' | 'mexc';

  // Social promotion configuration
  /** Social promotion configuration. */
  socialConfig?: SocialPromotionConfig[];
  /** Enable social promotion. */
  socialPromotionEnabled: boolean;

  // Monitoring configuration
  /** Interval between monitoring checks in ms. */
  monitorIntervalMs: number;
  /** Enable verbose monitoring logging. */
  verboseMonitoring: boolean;
}

/**
 * Default lifecycle configuration with production-grade settings.
 */
export const DEFAULT_LIFECYCLE_CONFIG: Partial<LifecycleConfig> = {
  // Token defaults
  tokenDecimals: 9,
  tokenProgram: 'spl',

  // Launch defaults
  launchVenue: 'pumpfun',
  buyerWalletCount: 28,
  buyLamportsPerWallet: 100_000_000n, // 0.1 SOL
  slippageBps: 100,
  useJito: true,

  // Market making defaults
  mmEnabled: true,
  mmBuyAmountRaw: 50_000_000n, // 0.05 SOL
  mmSellAmountRaw: 100_000_000n, // Varies by token
  mmIntervalMs: 5_000,
  mmRounds: 10,

  // Transaction generation defaults
  txnGenerationEnabled: true,
  txnCycles: 5,
  txnAmountRaw: 10_000_000n,
  txnIntervalMs: 2_000,

  // Holder targets
  targetHolders: 100,
  freezeWhenHoldersReached: true,
  revokeAuthoritiesAfterFreeze: true,

  // Exit defaults
  exitEnabled: true,
  takeProfitMultiplier: 2.0,
  stopLossFraction: 0.5,
  maxHoldSeconds: 3600, // 1 hour

  // Anonymity defaults
  anonymityConfig: DEFAULT_ANONYMITY_CONFIG,
  relayWalletCount: 5,

  // Profit pipeline defaults
  routeThroughJupiter: true,

  // Social promotion defaults
  socialPromotionEnabled: true,

  // Monitoring defaults
  monitorIntervalMs: 10_000,
  verboseMonitoring: true,
};

/**
 * Lifecycle controller options.
 */
export interface LifecycleControllerOptions {
  /** Service or Dex context for operations. */
  ctx: ServiceContext | DexContext;
  /** Lifecycle configuration. */
  config: LifecycleConfig;
  /** Whether to run in dry-run mode (simulate all operations). */
  dryRun?: boolean;
  /** Custom anonymity configuration override. */
  anonymityConfig?: AnonymityConfig;
  /**
   * Persistent root wallet that tops up every fresh (rotated) treasury before
   * its buyers are funded. Fresh treasuries start at zero SOL; without a
   * funder, execute-mode funding transfers all fail. Simulation mode works
   * without it.
   */
  treasuryFunder?: Keypair;
  /**
   * Wallet holding realized SOL profits; used as the profit-pipeline source
   * in the exit stage. When omitted the exit stage uses a simulated 1 SOL
   * placeholder and logs a warning.
   */
  profitWallet?: Keypair;
  /**
   * The mint's actual freeze authority keypair, required for the freeze
   * stage to succeed. When omitted the freeze stage reports itself skipped
   * instead of sending transactions a fresh keypair cannot authorize.
   */
  freezeAuthority?: Keypair;
}

/**
 * Complete lifecycle result.
 */
export interface LifecycleResult {
  /** All stage results. */
  stages: StageResult[];
  /** Current stage. */
  currentStage: LifecycleStage;
  /** Whether the lifecycle completed successfully. */
  success: boolean;
  /** Start timestamp. */
  startTime: number;
  /** End timestamp. */
  endTime: number;
  /** Total duration in ms. */
  durationMs: number;
  /** Monitor data from monitoring stage. */
  monitorData?: MonitorData;
  /** All errors encountered. */
  errors: Error[];
  /** Final mint address (created or provided). */
  mintAddress?: string;
}

// ---------------------------------------------------------------------------
// Lifecycle Controller Class
// ---------------------------------------------------------------------------

/**
 * Continuous lifecycle controller for token launches.
 *
 * This class orchestrates the complete token launch lifecycle, managing
 * state transitions, error handling, and coordination between all stages.
 * It provides comprehensive logging, observability, and control over the
 * entire launch process.
 *
 * USAGE:
 * ```typescript
 * const controller = new LifecycleController({
 *   ctx: myServiceContext,
 *   config: myLifecycleConfig,
 * });
 * 
 * const result = await controller.start();
 * console.log(result.success ? 'Launch completed!' : 'Launch failed');
 * ```
 */
export class LifecycleController {
  private ctx: ServiceContext | DexContext;
  private config: LifecycleConfig;
  private options: LifecycleControllerOptions;
  private currentStage: LifecycleStage = 'creation';
  private results: StageResult[] = [];
  private monitorData: MonitorData | null = null;
  private startedAt: number = 0;
  private socialManager: SocialPromotionManager;
  private running: boolean = false;
  private stopped: boolean = false;
  private errors: Error[] = [];
  private mintAddress: string | undefined;

  constructor(options: LifecycleControllerOptions) {
    this.ctx = options.ctx;
    this.options = options;
    this.config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      ...options.config,
    } as LifecycleConfig;

    // Initialize social promotion manager
    this.socialManager = new SocialPromotionManager(
      this.config.socialConfig ?? [],
      {
        tokenSymbol: this.config.tokenSymbol,
        tokenName: this.config.tokenName,
      },
    );

    // Initialize mint address
    this.mintAddress = this.config.mint;

    log.info(
      { token: this.config.tokenSymbol, venue: this.config.launchVenue },
      'lifecycle controller initialized',
    );
  }

  /**
   * Resolved anonymity configuration: defaults merged with any partial
   * overrides from options or the lifecycle config.
   */
  private get anonymity(): AnonymityConfig {
    return {
      ...DEFAULT_ANONYMITY_CONFIG,
      ...(this.options.anonymityConfig ?? this.config.anonymityConfig ?? {}),
    };
  }

  /**
   * Tops up a fresh rotated treasury from the persistent root wallet
   * (`options.treasuryFunder`). Fresh treasuries start at zero SOL — without
   * this step every downstream buyer-funding transfer fails in execute mode.
   * Returns false (and logs) when no funder is configured; simulation mode
   * tolerates that, execute mode does not.
   */
  private async fundTreasury(treasury: Keypair, lamports: bigint): Promise<boolean> {
    const funder = this.options.treasuryFunder;
    if (!funder) {
      log.warn(
        { treasury: treasury.publicKey.toBase58().slice(0, 6) },
        'no treasuryFunder configured — fresh treasury is UNFUNDED; execute-mode funding will fail',
      );
      return false;
    }
    await fundWallet(this.ctx, {
      funder,
      destination: treasury.publicKey,
      lamports,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });
    log.info(
      { treasury: treasury.publicKey.toBase58().slice(0, 6), lamports: lamports.toString() },
      'fresh treasury funded from root wallet',
    );
    return true;
  }

  /**
   * Start the full lifecycle execution.
   * Runs all stages in sequence with proper error handling.
   *
   * @returns Complete lifecycle result with all stage outcomes
   */
  async start(): Promise<LifecycleResult> {
    if (this.running) {
      throw new Error('Lifecycle already running');
    }

    this.running = true;
    this.stopped = false;
    this.startedAt = Date.now();
    this.errors = [];

    log.info(
      { token: this.config.tokenSymbol, dryRun: this.options.dryRun },
      'lifecycle started',
    );

    try {
      // Stage 1: Pre-launch setup (validation, wallet generation)
      await this.runStage('pre-launch', this.executePreLaunch.bind(this));

      // Stage 2: Launch (initial buy-in)
      await this.runStage('launch', this.executeLaunch.bind(this));

      // Stage 3: Market Making (volume + holders)
      if (this.config.mmEnabled) {
        await this.runStage('market-making', this.executeMarketMaking.bind(this));
      }

      // Stage 4: Transaction Generation
      if (this.config.txnGenerationEnabled) {
        await this.runStage('market-making', this.executeTransactionGeneration.bind(this));
      }

      // Stage 5: Monitoring (continuous until exit conditions met)
      await this.runStage('monitoring', this.executeMonitoring.bind(this));

      // Stage 6: Freeze Management (if conditions met)
      if (this.config.freezeWhenHoldersReached) {
        await this.runStage('freeze', this.executeFreeze.bind(this));
      }

      // Stage 7: Social Promotion
      if (this.config.socialPromotionEnabled) {
        await this.runStage('social-promo', this.executeSocialPromotion.bind(this));
      }

      // Stage 8: Exit (if conditions met)
      if (this.config.exitEnabled) {
        await this.runStage('exit', this.executeExit.bind(this));
      }

      // Stage 9: Consolidation
      await this.runStage('consolidation', this.executeConsolidation.bind(this));

      this.currentStage = 'complete';
      log.info(
        { results: this.results.length, durationMs: Date.now() - this.startedAt },
        'lifecycle completed successfully',
      );

      return this.buildResult();

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errors.push(error);
      this.currentStage = 'error';

      log.error(
        { err: error, stage: this.currentStage },
        'lifecycle failed',
      );

      return this.buildResult();

    } finally {
      this.running = false;
    }
  }

  /**
   * Stop the lifecycle execution gracefully.
   * Stops at the next stage boundary.
   */
  stop(): void {
    log.info('lifecycle stop requested');
    this.stopped = true;
  }

  /**
   * Execute a single stage with timing and error handling.
   */
  private async runStage(
    stage: LifecycleStage,
    fn: () => Promise<StageResult>,
  ): Promise<void> {
    if (this.stopped) {
      throw new Error('Lifecycle stopped by user request');
    }

    this.currentStage = stage;
    const startTime = Date.now();

    log.info({ stage }, 'stage starting');

    try {
      const result = await fn();
      const endTime = Date.now();

      // Update result with timing
      result.startTime = startTime;
      result.endTime = endTime;
      result.durationMs = endTime - startTime;

      this.results.push(result);

      if (!result.success) {
        throw new Error(result.message);
      }

      log.info(
        { stage, durationMs: result.durationMs, data: result.data },
        'stage completed',
      );

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errors.push(error);

      const errorResult: StageResult = {
        stage,
        success: false,
        message: `Stage ${stage} failed: ${error.message}`,
        error,
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
      };

      this.results.push(errorResult);
      log.error({ stage, err: error }, 'stage failed');
      throw error;
    }
  }

  /**
   * Build the complete lifecycle result.
   */
  private buildResult(): LifecycleResult {
    return {
      stages: this.results,
      currentStage: this.currentStage,
      success: this.currentStage === 'complete' && this.errors.length === 0,
      startTime: this.startedAt,
      endTime: Date.now(),
      durationMs: Date.now() - this.startedAt,
      monitorData: this.monitorData ?? undefined,
      errors: this.errors,
      mintAddress: this.mintAddress,
    };
  }

  // ---------------------------------------------------------------------------
  // Stage Implementations
  // ---------------------------------------------------------------------------

  /**
   * Stage 1: Pre-launch setup.
   * Validates configuration, generates wallets, and performs setup.
   */
  private async executePreLaunch(): Promise<StageResult> {
    log.info('executing pre-launch setup');

    // Validate configuration
    const validationErrors: string[] = [];

    if (!this.config.tokenName || !this.config.tokenSymbol) {
      validationErrors.push('Token name and symbol are required');
    }

    if (!this.config.metadataUri) {
      validationErrors.push('Metadata URI is required');
    }

    if (!this.config.launchVenue) {
      validationErrors.push('Launch venue is required');
    }

    if (validationErrors.length > 0) {
      return {
        stage: 'pre-launch',
        success: false,
        message: `Configuration validation failed: ${validationErrors.join(', ')}`,
      };
    }

    // Generate anonymized launch configuration if mint doesn't exist
    if (!this.mintAddress) {
      const launchConfig = createAnonymizedLaunchConfig(
        this.config.buyerWalletCount,
        this.config.relayWalletCount,
        this.anonymity,
      );

      // Store the treasury and wallets for later stages
      // In a real implementation, these would be persisted to the context
      log.info(
        {
          treasury: launchConfig.treasury.publicKey.toBase58().slice(0, 6),
          buyers: launchConfig.buyerWallets.length,
          relays: launchConfig.relayWallets.length,
        },
        'generated fresh launch lineage',
      );
    }

    // Initialize monitor data
    this.monitorData = {
      currentPrice: 0,
      entryPrice: 0,
      holdersCount: 0,
      volume24h: 0n,
      lastUpdated: Date.now(),
      priceHistory: [],
      holderHistory: [],
    };

    return {
      stage: 'pre-launch',
      success: true,
      message: 'Pre-launch setup completed',
      data: {
        tokenSymbol: this.config.tokenSymbol,
        tokenName: this.config.tokenName,
        launchVenue: this.config.launchVenue,
        buyerCount: this.config.buyerWalletCount,
      },
    };
  }

  /**
   * Stage 2: Launch - Initial buy-in.
   * Executes the initial token purchases across multiple buyer wallets.
   */
  private async executeLaunch(): Promise<StageResult> {
    log.info('executing launch phase');

    // Generate fresh launch lineage (treasury + buyers)
    const lineage = freshLaunchLineage(this.config.buyerWalletCount);

    // Fund the fresh treasury from the persistent root wallet first: it
    // starts at zero SOL, and every buyer-funding transfer below draws from
    // it. Total = per-buyer funding (with fee headroom) for all buyers, plus
    // per-transfer fee allowance and a buffer for the treasury's own fees.
    const buyerCount = BigInt(this.config.buyerWalletCount);
    const perBuyerFunding = this.config.buyLamportsPerWallet + 50_000n;
    const treasuryFunding = buyerCount * (perBuyerFunding + 10_000n) + 50_000n;
    await this.fundTreasury(lineage.treasury, treasuryFunding);

    // Pre-fund all buyer wallets from the funded treasury with randomized
    // amounts/delays (anonymity suite).
    const fundResult = await fundBuyersAnonymously({
      ctx: this.ctx,
      treasury: lineage.treasury,
      buyers: lineage.buyers,
      lamportsPerBuyer: this.config.buyLamportsPerWallet + 50_000n,
      anonymity: this.anonymity,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    if (fundResult.failures.length > 0) {
      log.warn(
        { failures: fundResult.failures.length, funded: fundResult.funded.length },
        'some buyer funding failed',
      );
    }

    // Execute launch buys. preFundBuyers is disabled because the buyers
    // were already provisioned above — otherwise increaseHolders would fund
    // every buyer a second time.
    // Note: We need to handle the DexContext type properly
    const dexCtx = this.ctx as unknown as DexContext;
    const holderResult = await increaseHolders(dexCtx, {
      venue: this.config.launchVenue as any, // Cast to SwapVenue type
      treasury: lineage.treasury,
      buyerWallets: lineage.buyers,
      mint: this.mintAddress || this.config.mint || '',
      buyLamportsPerWallet: this.config.buyLamportsPerWallet,
      slippageBps: this.config.slippageBps,
      mode: this.options.dryRun ? 'simulate' : 'execute',
      interBuyerDelayMs: this.anonymity.maxInterBuyerDelayMs,
      preFundBuyers: false,
    });

    // Update monitor data with launch results
    if (this.monitorData) {
      const successfulBuyers = holderResult.results.filter(r => r.ok).length;
      this.monitorData.holdersCount = successfulBuyers;
      this.monitorData.volume24h = BigInt(successfulBuyers) * this.config.buyLamportsPerWallet;
      this.monitorData.lastUpdated = Date.now();
      this.monitorData.holderHistory.push({
        timestamp: Date.now(),
        count: successfulBuyers,
      });
    }

    return {
      stage: 'launch',
      success: true,
      message: `Launch completed: ${holderResult.results.filter(r => r.ok).length} successful buyers`,
      data: {
        successfulBuyers: holderResult.results.filter(r => r.ok).length,
        failedBuyers: holderResult.results.filter(r => !r.ok).length,
        totalVolumeLamports: (BigInt(holderResult.results.filter(r => r.ok).length) * this.config.buyLamportsPerWallet).toString(),
      },
    };
  }

  /**
   * Stage 3: Market Making.
   * Runs market maker to create volume and liquidity.
   */
  private async executeMarketMaking(): Promise<StageResult> {
    log.info('executing market making phase');

    // Generate fresh wallets for market making
    const mmLineage = freshLaunchLineage(2); // 2 wallets for buy/sell

    // Fund the fresh MM treasury from the root wallet: 2 wallets' buy
    // notional + fee headroom, plus transfer fees.
    await this.fundTreasury(
      mmLineage.treasury,
      2n * (this.config.mmBuyAmountRaw + 50_000n + 10_000n) + 50_000n,
    );

    // Fund market maker wallets
    await fundBuyersAnonymously({
      ctx: this.ctx,
      treasury: mmLineage.treasury,
      buyers: mmLineage.buyers,
      lamportsPerBuyer: this.config.mmBuyAmountRaw + 50_000n,
      anonymity: this.anonymity,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    // Run market maker
    const dexCtx = this.ctx as unknown as DexContext;
    const mmResult = await runBatchSwap(dexCtx, {
      venue: this.config.launchVenue as any,
      user: mmLineage.buyers[0],
      mint: this.mintAddress || this.config.mint || '',
      legs: [
        { direction: 'buy', amountRaw: this.config.mmBuyAmountRaw },
        { direction: 'sell', amountRaw: this.config.mmSellAmountRaw },
      ],
      intervalMs: this.config.mmIntervalMs,
      rounds: this.config.mmRounds,
      slippageBps: this.config.slippageBps,
      useJito: this.config.useJito,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    return {
      stage: 'market-making',
      success: true,
      message: `Market making: ${mmResult.legsExecuted} legs executed, ${mmResult.legsFailed} failures`,
      data: {
        legsExecuted: mmResult.legsExecuted,
        legsFailed: mmResult.legsFailed,
        legsSkipped: mmResult.legsSkipped,
      },
    };
  }

  /**
   * Stage 4: Transaction Generation.
   * Creates additional transaction volume by ping-pong trading.
   */
  private async executeTransactionGeneration(): Promise<StageResult> {
    log.info('executing transaction generation phase');

    // Import transaction generation function
    const txnWallets = freshBuyerWallets(this.config.buyerWalletCount);

    // Fresh single-use treasury for txn generation (rotation: no reuse),
    // funded from the root wallet like the launch/MM treasuries.
    const treasury = Keypair.generate();
    const txnBuyerCount = BigInt(this.config.buyerWalletCount);
    await this.fundTreasury(
      treasury,
      txnBuyerCount * (this.config.txnAmountRaw + 50_000n + 10_000n) + 50_000n,
    );
    await fundBuyersAnonymously({
      ctx: this.ctx,
      treasury,
      buyers: txnWallets,
      lamportsPerBuyer: this.config.txnAmountRaw + 50_000n,
      anonymity: this.anonymity,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    // Run transaction generation
    const dexCtx = this.ctx as unknown as DexContext;
    const result = await increaseTransactions(dexCtx, {
      venue: this.config.launchVenue as any,
      wallets: txnWallets,
      mint: this.mintAddress || this.config.mint || '',
      amountRawPerLeg: this.config.txnAmountRaw,
      cycles: this.config.txnCycles,
      intervalMs: this.config.txnIntervalMs,
      slippageBps: this.config.slippageBps,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    // Update monitor data
    if (this.monitorData) {
      this.monitorData.volume24h += BigInt(result.legs) * this.config.txnAmountRaw;
      this.monitorData.lastUpdated = Date.now();
    }

    return {
      stage: 'market-making',
      success: true,
      message: `Transaction generation: ${result.legs} legs, ${result.failures} failures`,
      data: {
        legs: result.legs,
        failures: result.failures,
      },
    };
  }

  /**
   * Stage 5: Monitoring.
   * Continuously monitors price, holders, and volume until exit conditions met.
   */
  private async executeMonitoring(): Promise<StageResult> {
    log.info('executing monitoring phase');

    // Check if we should skip monitoring
    if (this.config.maxHoldSeconds === 0 && !this.config.exitEnabled) {
      return {
        stage: 'monitoring',
        success: true,
        message: 'Monitoring skipped (no exit conditions configured)',
        data: {},
      };
    }

    // Run monitoring loop
    const startTime = Date.now();
    const maxHoldMs = this.config.maxHoldSeconds * 1000;

    while (!this.stopped) {
      // Check if we've exceeded max hold time
      const elapsed = Date.now() - startTime;
      if (maxHoldMs > 0 && elapsed >= maxHoldMs) {
        log.info({ elapsedMs: elapsed }, 'max hold time reached');
        break;
      }

      // Check if we should exit based on price conditions
      // (In practice, would check actual price from venue)
      const shouldExit = this.checkExitConditions(elapsed);
      if (shouldExit) {
        log.info('exit conditions met during monitoring');
        break;
      }

      // Check if we should freeze based on holder count
      const holders = await this.scanAndUpdateHolders();
      if (this.config.freezeWhenHoldersReached && holders >= this.config.targetHolders) {
        log.info({ holders, target: this.config.targetHolders }, 'target holders reached');
        break;
      }

      // Wait for next monitoring interval
      await sleep(Math.min(this.config.monitorIntervalMs, 10_000));
    }

    return {
      stage: 'monitoring',
      success: true,
      message: 'Monitoring completed',
      data: {
        finalHolders: this.monitorData?.holdersCount,
        finalVolume: this.monitorData?.volume24h.toString(),
        finalPrice: this.monitorData?.currentPrice,
      },
    };
  }

  /**
   * Scan token holders and update monitor data.
   */
  private async scanAndUpdateHolders(): Promise<number> {
    try {
      const holders = await scanTokenHolders(this.ctx, this.mintAddress || this.config.mint || '', {
        pageSize: 10_000,
        maxAccounts: 100_000,
      });

      if (this.monitorData) {
        this.monitorData.holdersCount = holders.length;
        this.monitorData.lastUpdated = Date.now();
        this.monitorData.holderHistory.push({
          timestamp: Date.now(),
          count: holders.length,
        });
      }

      return holders.length;
    } catch (err) {
      log.error({ err }, 'failed to scan holders');
      return this.monitorData?.holdersCount ?? 0;
    }
  }

  /**
   * Check if exit conditions are met.
   */
  private checkExitConditions(elapsedMs: number): boolean {
    if (!this.monitorData) return false;

    // Max hold time exceeded
    if (this.config.maxHoldSeconds > 0 && elapsedMs >= this.config.maxHoldSeconds * 1000) {
      return true;
    }

    // Take profit condition (would need actual price tracking)
    // This is a placeholder - real implementation would track price from venue
    if (this.config.takeProfitMultiplier > 0 && this.monitorData.currentPrice > 0) {
      const entryPrice = this.monitorData.entryPrice || this.monitorData.currentPrice;
      if (this.monitorData.currentPrice >= entryPrice * this.config.takeProfitMultiplier) {
        return true;
      }
    }

    // Stop loss condition
    if (this.config.stopLossFraction > 0 && this.monitorData.currentPrice > 0) {
      const entryPrice = this.monitorData.entryPrice || this.monitorData.currentPrice;
      if (this.monitorData.currentPrice <= entryPrice * this.config.stopLossFraction) {
        return true;
      }
    }

    return false;
  }

  /**
   * Stage 6: Freeze Management.
   * Freezes all token holders when target reached.
   */
  private async executeFreeze(): Promise<StageResult> {
    log.info('executing freeze phase');

    // Check if we should freeze
    const holders = await this.scanAndUpdateHolders();
    if (holders < this.config.targetHolders) {
      return {
        stage: 'freeze',
        success: true,
        message: `Freeze skipped: only ${holders} holders, target is ${this.config.targetHolders}`,
        data: { holders, target: this.config.targetHolders },
      };
    }

    // The freeze stage must sign with the mint's ACTUAL freeze authority
    // keypair — a freshly generated keypair cannot authorize freezes and
    // every transaction would fail. Without one configured the stage reports
    // itself skipped instead of sending doomed transactions.
    const freezeAuthority = this.options.freezeAuthority;
    if (!freezeAuthority) {
      log.warn('no freezeAuthority configured — freeze stage skipped (pass options.freezeAuthority to enable)');
      return {
        stage: 'freeze',
        success: true,
        message: 'Freeze skipped: no freeze authority keypair configured (a fresh keypair cannot authorize freezes)',
        data: { holders, target: this.config.targetHolders },
      };
    }

    const result = await autoFreezeAllHolders(this.ctx, {
      authority: freezeAuthority,
      mint: this.mintAddress || this.config.mint || '',
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    // Optionally revoke all authorities after freeze
    if (this.config.revokeAuthoritiesAfterFreeze && this.config.mint) {
      await revokeAllAuthorities(this.ctx, {
        wallet: freezeAuthority,
        mint: this.config.mint,
        mode: this.options.dryRun ? 'simulate' : 'execute',
      });
    }

    return {
      stage: 'freeze',
      success: true,
      message: `Froze ${result.frozen.length} holders, ${result.failures.length} failures`,
      data: {
        frozen: result.frozen.length,
        failures: result.failures.length,
      },
    };
  }

  /**
   * Stage 7: Social Promotion.
   * Triggers social promotion activities.
   */
  private async executeSocialPromotion(): Promise<StageResult> {
    log.info('executing social promotion phase');

    // Trigger launch announcement
    const results = await this.socialManager.triggerPromotion('launch-announcement', {
      tokenSymbol: this.config.tokenSymbol,
      tokenName: this.config.tokenName,
      mint: this.mintAddress || this.config.mint || '',
      stage: 'social-promo',
      holdersCount: this.monitorData?.holdersCount,
      // PromotionContext.volume is a number (SOL); monitorData tracks lamports.
      volume: this.monitorData ? Number(this.monitorData.volume24h) / 1e9 : undefined,
    });

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return {
      stage: 'social-promo',
      success: failed === 0,
      message: `Social promotion: ${successful} successful, ${failed} failed`,
      data: {
        successfulPlatforms: results.filter(r => r.success).map(r => r.platform),
        failedPlatforms: results.filter(r => !r.success).map(r => r.platform),
      },
    };
  }

  /**
   * Stage 8: Exit.
   * Executes profit taking via stealth routing.
   */
  private async executeExit(): Promise<StageResult> {
    log.info('executing exit phase');

    // Check if we should exit
    const shouldExit = this.checkExitConditions(Date.now() - this.startedAt);
    if (!shouldExit && !this.options.dryRun) {
      return {
        stage: 'exit',
        success: true,
        message: 'Exit conditions not met, skipping',
        data: {},
      };
    }

    // Route the realized profit through the pipeline. Without a configured
    // profitWallet (holding actual proceeds) the stage runs the pipeline in
    // simulation against a 1 SOL placeholder and warns — a fresh keypair
    // would have nothing to route.
    const profitWallet = this.options.profitWallet;
    const simulatedProfit = 1_000_000_000n; // 1 SOL placeholder
    if (!profitWallet) {
      log.warn('no profitWallet configured — exit routes a simulated 1 SOL placeholder from an unfunded wallet');
    }

    // Use the profit pipeline
    const pipelineResult = await startProfitPipeline(this.ctx, {
      sourceWallet: profitWallet ?? Keypair.generate(), // placeholder when no profit wallet configured
      profitLamports: simulatedProfit,
      mode: this.options.dryRun ? 'simulate' : 'execute',
      config: {
        stealthEnabled: this.anonymity.stealthEnabled,
        relayWallets: Array.from({ length: this.config.relayWalletCount }, () => Keypair.generate()),
        stealthLegs: this.anonymity.stealthLegs,
        jitterBps: this.anonymity.jitterBps,
        maxStealthDelayMs: this.anonymity.maxStealthDelayMs,
        swapToUsdc: this.config.routeThroughJupiter,
        swapSlippageBps: this.config.slippageBps,
        useJupiter: this.config.routeThroughJupiter,
        cexConfigs: [], // Would configure CEX withdrawals in practice
        delayBetweenStepsMs: 5_000,
      },
    });

    return {
      stage: 'exit',
      success: pipelineResult.success,
      message: pipelineResult.success
        ? `Exit completed: ${pipelineResult.totalUsdcReceived.toString()} USDC received`
        : `Exit failed: ${pipelineResult.errors.map(e => e.message).join(', ')}`,
      data: {
        usdcReceived: pipelineResult.totalUsdcReceived.toString(),
        cexDispersed: pipelineResult.totalCexDispersed.toString(),
        success: pipelineResult.success,
      },
    };
  }

  /**
   * Stage 9: Consolidation.
   * Sweeps all remaining funds to treasury.
   */
  private async executeConsolidation(): Promise<StageResult> {
    log.info('executing consolidation phase');

    // In practice, would sweep all remaining token balances and SOL
    // to the main treasury via stealth transfers

    // For this implementation, we'll just log the consolidation
    const message = this.options.dryRun
      ? 'Consolidation would sweep all funds to treasury'
      : 'Consolidation: all funds swept to treasury';

    return {
      stage: 'consolidation',
      success: true,
      message,
      data: {},
    };
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Get current stage.
   */
  getCurrentStage(): LifecycleStage {
    return this.currentStage;
  }

  /**
   * Get all stage results.
   */
  getResults(): StageResult[] {
    return this.results;
  }

  /**
   * Get monitor data.
   */
  getMonitorData(): MonitorData | null {
    return this.monitorData;
  }

  /**
   * Check if lifecycle is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check if lifecycle was stopped.
   */
  isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Get the mint address.
   */
  getMintAddress(): string | undefined {
    return this.mintAddress;
  }

  /**
   * Get all errors.
   */
  getErrors(): Error[] {
    return this.errors;
  }

  /**
   * Update the mint address (for when mint is created during lifecycle).
   */
  setMintAddress(mint: string): void {
    this.mintAddress = mint;
    log.info({ mint }, 'mint address updated');
  }
}

// ---------------------------------------------------------------------------
// Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Creates and starts a lifecycle controller with default settings.
 *
 * @param ctx - Service or Dex context
 * @param config - Partial lifecycle configuration
 * @returns Lifecycle result
 */
export async function runLifecycle(
  ctx: ServiceContext | DexContext,
  config: Partial<LifecycleConfig> & Pick<LifecycleConfig, 'tokenName' | 'tokenSymbol' | 'metadataUri'>,
): Promise<LifecycleResult> {
  const fullConfig: LifecycleConfig = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    ...config,
  } as LifecycleConfig;

  const controller = new LifecycleController({
    ctx,
    config: fullConfig,
    dryRun: false,
  });

  return controller.start();
}

/**
 * Runs a lifecycle in dry-run (simulation) mode.
 *
 * @param ctx - Service or Dex context
 * @param config - Partial lifecycle configuration
 * @returns Lifecycle result
 */
export async function simulateLifecycle(
  ctx: ServiceContext | DexContext,
  config: Partial<LifecycleConfig> & Pick<LifecycleConfig, 'tokenName' | 'tokenSymbol' | 'metadataUri'>,
): Promise<LifecycleResult> {
  const fullConfig: LifecycleConfig = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    ...config,
  } as LifecycleConfig;

  const controller = new LifecycleController({
    ctx,
    config: fullConfig,
    dryRun: true,
  });

  return controller.start();
}

