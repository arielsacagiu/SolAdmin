/**
 * Anonymity & Stealth Operations Module
 *
 * Enhances operational security by ensuring clean wallet lineage rotation,
 * randomized amounts and delays, and comprehensive anonymity practices
 * across all SolAdmin operations.
 *
 * ANONYMITY PRINCIPLES:
 * - Never reuse wallet addresses between launches
 * - Use fresh treasury keypairs per operation
 * - Randomize amounts within tolerance bands (±jitterBps)
 * - Apply randomized delays between operations
 * - Use distinct relay wallets for stealth transfers
 * - Combine multiple techniques for layered obfuscation
 *
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { ServiceContext } from './context.js';
import type { DexContext } from '@solana-toolkit/dex';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import { executeStealthTransfer, planStealthTransfer, type StealthTransferOptions } from './stealth.js';

const log = moduleLogger('anonymity');

// ---------------------------------------------------------------------------
// Anonymity Configuration
// ---------------------------------------------------------------------------

/**
 * Anonymity configuration for all operations.
 * All settings are designed to break deterministic patterns that
 * on-chain analysis could use to link operations.
 */
export interface AnonymityConfig {
  /** Enable stealth transfers for profit routing. */
  stealthEnabled: boolean;
  /** Number of relay legs for stealth transfers (3-5 recommended). */
  stealthLegs: number;
  /** Jitter basis points for amount randomization (±). */
  jitterBps: number;
  /** Maximum delay between stealth legs in ms. */
  maxStealthDelayMs: number;
  /** Enable randomized timing between buyer purchases. */
  randomizedTimingEnabled: boolean;
  /** Maximum random delay between buyer purchases in ms. */
  maxInterBuyerDelayMs: number;
  /** Enable treasury rotation (no address reuse between launches). */
  treasuryRotationEnabled: boolean;
  /** Generate fresh buyer wallets per launch. */
  freshBuyersPerLaunch: boolean;
  /** Enable randomized funding amounts for buyers. */
  randomizeFundingAmounts: boolean;
  /** Maximum deviation for funding amount randomization (bps). */
  maxFundingDeviationBps: number;
}

/**
 * Production-grade default anonymity configuration.
 * These values provide strong heuristic anonymity while maintaining
 * operational reliability.
 */
export const DEFAULT_ANONYMITY_CONFIG: AnonymityConfig = {
  stealthEnabled: true,
  stealthLegs: 4,
  jitterBps: 1000, // ±10%
  maxStealthDelayMs: 10_000,
  randomizedTimingEnabled: true,
  maxInterBuyerDelayMs: 8_000,
  treasuryRotationEnabled: true,
  freshBuyersPerLaunch: true,
  randomizeFundingAmounts: true,
  maxFundingDeviationBps: 1500, // ±15% for funding amounts
};

/**
 * Strict anonymity configuration for maximum obfuscation.
 * Uses higher jitter and more relay legs at the cost of higher fees
 * and slower execution.
 */
export const STRICT_ANONYMITY_CONFIG: AnonymityConfig = {
  stealthEnabled: true,
  stealthLegs: 5,
  jitterBps: 2000, // ±20%
  maxStealthDelayMs: 15_000,
  randomizedTimingEnabled: true,
  maxInterBuyerDelayMs: 12_000,
  treasuryRotationEnabled: true,
  freshBuyersPerLaunch: true,
  randomizeFundingAmounts: true,
  maxFundingDeviationBps: 2000, // ±20%
};

/**
 * Minimal anonymity configuration for speed-focused operations.
 * Uses minimal obfuscation for maximum speed.
 */
export const MINIMAL_ANONYMITY_CONFIG: AnonymityConfig = {
  stealthEnabled: false,
  stealthLegs: 2,
  jitterBps: 0,
  maxStealthDelayMs: 1_000,
  randomizedTimingEnabled: false,
  maxInterBuyerDelayMs: 0,
  treasuryRotationEnabled: true,
  freshBuyersPerLaunch: true,
  randomizeFundingAmounts: false,
  maxFundingDeviationBps: 0,
};

// ---------------------------------------------------------------------------
// Anti-Correlation Configuration
// ---------------------------------------------------------------------------

/**
 * Anti-correlation measures beyond the basic anonymity suite.
 *
 * Where `AnonymityConfig` randomizes amounts/timing, these settings address
 * the structural linkability that randomization cannot fix: deterministic
 * RNG, in-memory (session-scoped) reuse registries, and direct
 * treasury→buyer funding edges that share one feePayer.
 */
export interface AntiCorrelationConfig {
  /** Draw all randomization from a CSPRNG (node:crypto) instead of Math.random. */
  cryptoRng: boolean;
  /** Persist the wallet reuse registry to disk (survives process restarts). */
  persistRegistry: boolean;
  /** Registry file location; required when persistRegistry is true. */
  registryPath?: string;
  /** Entries older than this are considered expired and may be reused (ms). */
  maxWalletAgeMs: number;
  /** Route buyer funding through a per-buyer relay so no direct
   *  treasury→buyer edge exists on-chain. */
  breakFundingGraph: boolean;
  /** Use a distinct feePayer (the relay) for the buyer-side funding leg. */
  distinctFeePayers: boolean;
  /** Jitter applied to Jito tip amounts (bps, ±) so bundles don't share
   *  identical tip values. */
  tipJitterBps: number;
}

/**
 * Production-grade default anti-correlation configuration.
 */
export const DEFAULT_ANTI_CORRELATION_CONFIG: AntiCorrelationConfig = {
  cryptoRng: true,
  persistRegistry: true,
  registryPath: undefined,
  maxWalletAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  breakFundingGraph: true,
  distinctFeePayers: true,
  tipJitterBps: 1_000, // ±10%
};

// ---------------------------------------------------------------------------
// Cryptographic RNG
// ---------------------------------------------------------------------------

/**
 * CSPRNG-backed uniform draw in [0, 1).
 *
 * Every call consumes fresh OS entropy — there is no internal state an
 * observer could reconstruct from a sequence of outputs (unlike an LCG).
 * When a seed is provided the draws are deterministic (keyed SHA-256
 * expansion), which keeps unit tests reproducible without weakening
 * production behavior.
 */
export function createCryptoRng(seed?: Uint8Array): () => number {
  if (seed && seed.length > 0) {
    let counter = 0;
    return () => {
      const material = Buffer.concat([Buffer.from(seed), Buffer.of(counter++ & 0xff)]);
      const digest = createHash('sha256').update(material).digest();
      return digest.readUIntBE(0, 6) / 2 ** 48;
    };
  }
  return () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

// ---------------------------------------------------------------------------
// Launch Lineage Management
// ---------------------------------------------------------------------------

/**
 * Complete anonymity-aware launch configuration.
 * All wallets are fresh Keypairs, never reused between launches.
 */
export interface AnonymizedLaunchConfig {
  treasury: Keypair;
  buyerWallets: Keypair[];
  relayWallets: Keypair[];
  anonymity: AnonymityConfig;
}

/**
 * Generates a complete anonymized launch configuration.
 * All wallets are fresh Keypairs, ensuring no address reuse between launches.
 *
 * @param buyersCount - Number of buyer wallets to generate
 * @param relaysCount - Number of relay wallets for stealth operations
 * @param config - Optional anonymity configuration overrides
 * @returns Complete launch configuration with all fresh keypairs
 */
export function createAnonymizedLaunchConfig(
  buyersCount: number,
  relaysCount: number,
  config?: Partial<AnonymityConfig>,
): AnonymizedLaunchConfig {
  const anonymity: AnonymityConfig = {
    ...DEFAULT_ANONYMITY_CONFIG,
    ...config,
  };

  return {
    treasury: Keypair.generate(),
    buyerWallets: Array.from({ length: buyersCount }, () => Keypair.generate()),
    relayWallets: Array.from({ length: relaysCount }, () => Keypair.generate()),
    anonymity,
  };
}

/**
 * Creates a fresh treasury keypair for a single operation.
 * Each treasury is unique and should be used exactly once.
 */
export function createFreshTreasury(): Keypair {
  return Keypair.generate();
}

/**
 * Generates a set of fresh buyer wallets.
 * Each buyer wallet should be used exactly once per launch.
 */
export function createFreshBuyerWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

/**
 * Generates a set of fresh relay wallets for stealth operations.
 * Each relay wallet should be used exactly once per stealth transfer.
 */
export function createFreshRelayWallets(count: number): Keypair[] {
  return Array.from({ length: count }, () => Keypair.generate());
}

// ---------------------------------------------------------------------------
// Anonymized Funding
// ---------------------------------------------------------------------------

/**
 * Parameters for anonymized wallet funding.
 */
export interface FundBuyersParams {
  ctx: ServiceContext | DexContext;
  treasury: Keypair;
  buyers: Keypair[];
  lamportsPerBuyer: bigint;
  anonymity: AnonymityConfig;
  mode?: 'simulate' | 'execute';
  /** Injectable RNG for deterministic tests (ignored when antiCorrelation.cryptoRng). */
  rng?: () => number;
  /** Anti-correlation overrides; defaults applied from DEFAULT_ANTI_CORRELATION_CONFIG. */
  antiCorrelation?: Partial<AntiCorrelationConfig>;
  /**
   * Persistent reuse registry. When provided, every generated relay and every
   * funded buyer is registered and reuse within the expiry window is
   * rejected (a fresh keypair is substituted).
   */
  registry?: PersistentWalletRegistry;
  /** Called with each fresh funding relay before any lamports move, so the caller can persist the key. */
  onRelay?: (relay: Keypair) => void;
}

/**
 * Result of anonymized funding operation.
 */
export interface FundBuyersResult {
  funded: string[];
  failures: string[];
  amounts: Record<string, bigint>;
}

/**
 * Fee headroom a relay needs to pay for its own outbound transfer
 * (base fee + rent-free SystemProgram.transfer margin).
 */
const RELAY_FEE_OVERHEAD_LAMPORTS = 15_000n;

/**
 * Funds one buyer through a dedicated relay wallet:
 *   treasury → relay (feePayer: treasury), relay → buyer (feePayer: relay).
 *
 * ANTI-CORRELATION vs direct funding:
 *  - No direct treasury→buyer edge exists on the funding graph; each buyer's
 *    inbound transfer comes from a distinct single-use relay.
 *  - The buyer-side leg is paid by the relay, so consecutive funding
 *    transactions do not share a feePayer.
 *  - The randomized intra-pair delay separates the two legs in time, so they
 *    are not adjacent-slot twins.
 */
export async function fundBuyerViaRelay(
  params: {
    ctx: ServiceContext | DexContext;
    treasury: Keypair;
    relay: Keypair;
    buyer: Keypair;
    amount: bigint;
    anonymity: AnonymityConfig;
    mode?: 'simulate' | 'execute';
    rng: () => number;
  },
): Promise<void> {
  const { ctx, treasury, relay, buyer, amount, mode, anonymity, rng } = params;

  // Leg 1: treasury → relay. The relay carries the buyer amount plus its own
  // fee overhead; the treasury signs (and pays) this leg.
  await ctx.sender.send(
    {
      description: `relay funding leg (treasury→relay ${relay.publicKey.toBase58().slice(0, 6)})`,
      feePayer: treasury.publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: relay.publicKey,
          lamports: amount + RELAY_FEE_OVERHEAD_LAMPORTS,
        }),
      ],
      signers: [treasury],
    },
    { mode },
  );

  // Randomized intra-pair delay: two adjacent-slot transfers from/to the
  // same pair are a scripted-funding fingerprint.
  if (anonymity.randomizedTimingEnabled && anonymity.maxStealthDelayMs > 0) {
    await sleep(Math.floor(rng() * anonymity.maxStealthDelayMs));
  }

  // Leg 2: relay → buyer. DISTINCT feePayer — the relay pays its own fee
  // out of the overhead it received, so the buyer-side edge is signed by a
  // wallet that has never funded anything else.
  await ctx.sender.send(
    {
      description: `relay funding leg (relay→buyer ${buyer.publicKey.toBase58().slice(0, 6)})`,
      feePayer: relay.publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: relay.publicKey,
          toPubkey: buyer.publicKey,
          lamports: amount,
        }),
      ],
      signers: [relay],
    },
    { mode },
  );
}

/**
 * Funds a set of buyer wallets from treasury with randomized amounts
 * and delays for anonymity.
 *
 * ANONYMITY FEATURES:
 * - Randomizes funding amounts within ±maxFundingDeviationBps
 * - Applies randomized delays between funding operations
 * - Uses distinct wallet addresses for each buyer
 * - Prevents timing patterns that could link wallets
 *
 * ANTI-CORRELATION FEATURES (when `antiCorrelation` is set, the default):
 * - All randomization draws come from the CSPRNG (`createCryptoRng`), not
 *   Math.random.
 * - Funding is routed treasury→relay→buyer with a fresh single-use relay
 *   per buyer and a distinct feePayer per leg, so no direct treasury→buyer
 *   edge or shared feePayer chain exists.
 * - Every generated relay and funded buyer is registered in the persistent
 *   reuse registry (when provided), and any buyer already registered inside
 *   the expiry window is substituted with a fresh keypair before funding.
 *
 * @param params - Funding parameters including treasury, buyers, and anonymity config
 * @returns Result with list of funded wallets, failures, and actual amounts
 */
export async function fundBuyersAnonymously(
  params: FundBuyersParams,
): Promise<FundBuyersResult> {
  const { ctx, treasury, buyers, lamportsPerBuyer, anonymity, mode, rng: rngParam, registry, onRelay } = params;
  const ac: AntiCorrelationConfig = {
    ...DEFAULT_ANTI_CORRELATION_CONFIG,
    ...params.antiCorrelation,
  };
  const funded: string[] = [];
  const failures: string[] = [];
  const amounts: Record<string, bigint> = {};
  const actualRng = ac.cryptoRng ? createCryptoRng() : rngParam ?? createCryptoRng();

  for (const [index, buyerRaw] of buyers.entries()) {
    try {
      // Reuse guard: a buyer already used inside the expiry window is
      // substituted with a fresh keypair before any funds move.
      let buyer = buyerRaw;
      if (registry?.isUsed('buyer', buyer.publicKey.toBase58(), ac.maxWalletAgeMs)) {
        buyer = Keypair.generate();
        log.warn(
          { stale: buyerRaw.publicKey.toBase58().slice(0, 6) },
          'buyer address already registered — substituted with fresh keypair',
        );
      }

      // Calculate randomized funding amount (CSPRNG when configured).
      let amount = lamportsPerBuyer;
      if (anonymity.randomizeFundingAmounts && anonymity.maxFundingDeviationBps > 0) {
        const deviation = BigInt(Math.floor(actualRng() * (anonymity.maxFundingDeviationBps * 2 + 1))) -
          BigInt(anonymity.maxFundingDeviationBps);
        amount = lamportsPerBuyer + (lamportsPerBuyer * deviation) / 10_000n;
        // Ensure minimum funding for transaction fees
        if (amount < lamportsPerBuyer - 10_000n) {
          amount = lamportsPerBuyer - 10_000n;
        }
      }

      if (ac.breakFundingGraph) {
        // Fresh single-use relay per buyer, registered before use.
        const relay = Keypair.generate();
        registry?.register('relay', relay.publicKey.toBase58());
        onRelay?.(relay);
        await fundBuyerViaRelay({
          ctx,
          treasury,
          relay,
          buyer,
          amount,
          anonymity,
          mode,
          rng: actualRng,
        });
      } else {
        // Direct funding path (legacy behavior).
        const totalAmount = amount + 20_000n;
        await ctx.sender.send(
          {
            description: `anon fund buyer ${index}`,
            feePayer: treasury.publicKey.toBase58(),
            instructions: [
              SystemProgram.transfer({
                fromPubkey: treasury.publicKey,
                toPubkey: buyer.publicKey,
                lamports: totalAmount,
              }),
            ],
            signers: [treasury],
          },
          { mode },
        );
      }

      registry?.register('buyer', buyer.publicKey.toBase58());
      funded.push(buyer.publicKey.toBase58());
      amounts[buyer.publicKey.toBase58()] = amount;

      // Random delay between funding operations
      if (anonymity.randomizedTimingEnabled && index < buyers.length - 1) {
        const delay = Math.floor(actualRng() * anonymity.maxInterBuyerDelayMs);
        await sleep(delay);
      }

      log.debug(
        { buyer: buyer.publicKey.toBase58().slice(0, 6), amount: amount.toString(), viaRelay: ac.breakFundingGraph },
        'anonymized buyer funding complete',
      );
    } catch (err) {
      const errorMsg = `${buyerRaw.publicKey.toBase58()}: ${err}`;
      failures.push(errorMsg);
      log.error({ err, buyer: buyerRaw.publicKey.toBase58() }, 'anonymized funding failed');
    }
  }

  registry?.register('treasury', treasury.publicKey.toBase58());
  return { funded, failures, amounts };
}

// ---------------------------------------------------------------------------
// Stealth Profit Routing
// ---------------------------------------------------------------------------

/**
 * Parameters for routing profits through stealth relay network.
 */
export interface RouteProfitParams {
  ctx: ServiceContext;
  source: Keypair;
  destination: string;
  amountLamports: bigint;
  relays: Keypair[];
  anonymity: AnonymityConfig;
  mode?: 'simulate' | 'execute';
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
}

/**
 * Result of stealth profit routing operation.
 */
export interface RouteProfitResult {
  plan: any;
  outcomes: any[];
  success: boolean;
  error?: string;
}

/**
 * Routes funds through stealth relay network for profit laundering.
 * source → relay1 → relay2 → ... → destination with randomized amounts/delays.
 *
 * ANONYMITY FEATURES:
 * - Each leg uses a distinct relay wallet
 * - Amounts are randomized within ±jitterBps around equal split
 * - Delays are randomized between legs to break timing patterns
 * - All relay wallets are fresh Keypairs per operation
 *
 * @param params - Profit routing parameters
 * @returns Result with stealth plan, outcomes, and success status
 */
export async function routeProfitStealthily(
  params: RouteProfitParams,
): Promise<RouteProfitResult> {
  const { ctx, source, destination, amountLamports, relays, anonymity, mode, rng } = params;

  if (!anonymity.stealthEnabled || relays.length === 0) {
    // Fallback: direct transfer when stealth is disabled
    try {
      await ctx.sender.send(
        {
          description: 'direct profit transfer (stealth disabled)',
          feePayer: source.publicKey.toBase58(),
          instructions: [
            SystemProgram.transfer({
              fromPubkey: source.publicKey,
              toPubkey: new PublicKey(destination),
              lamports: amountLamports,
            }),
          ],
          signers: [source],
        },
        { mode },
      );

      return {
        plan: null,
        outcomes: [],
        success: true,
      };
    } catch (err) {
      return {
        plan: null,
        outcomes: [],
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    const result = await executeStealthTransfer(ctx, {
      source,
      destination,
      totalLamports: amountLamports,
      relays,
      legs: Math.min(anonymity.stealthLegs, relays.length),
      jitterBps: anonymity.jitterBps,
      maxDelayMs: anonymity.maxStealthDelayMs,
      mode,
      rng,
    });

    return {
      plan: result.plan,
      outcomes: result.outcomes,
      success: true,
    };
  } catch (err) {
    return {
      plan: null,
      outcomes: [],
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Anonymity Validation
// ---------------------------------------------------------------------------

/**
 * Validates that an operation configuration meets anonymity standards.
 */
export interface AnonymityValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
  recommendations: string[];
}

/**
 * Validates anonymity configuration and provides recommendations.
 *
 * @param config - Anonymity configuration to validate
 * @param operationType - Type of operation being performed
 * @returns Validation result with warnings, errors, and recommendations
 */
export function validateAnonymityConfig(
  config: Partial<AnonymityConfig>,
  operationType: 'launch' | 'market-making' | 'exit' | 'consolidation' = 'launch',
): AnonymityValidationResult {
  const mergedConfig: AnonymityConfig = {
    ...DEFAULT_ANONYMITY_CONFIG,
    ...config,
  };

  const warnings: string[] = [];
  const errors: string[] = [];
  const recommendations: string[] = [];

  // Check stealth transfer configuration
  if (mergedConfig.stealthEnabled) {
    if (mergedConfig.stealthLegs < 2) {
      warnings.push(`Stealth legs too low (${mergedConfig.stealthLegs}), recommend minimum 3 for effective obfuscation`);
    }
    if (mergedConfig.jitterBps === 0) {
      warnings.push('Jitter is disabled, amounts will be uniform and easily linkable');
    }
    if (mergedConfig.maxStealthDelayMs < 1000) {
      warnings.push('Stealth delay too short, recommend minimum 1000ms between legs');
    }
  } else if (operationType === 'exit' || operationType === 'consolidation') {
    warnings.push(`Stealth transfers disabled for ${operationType}, profits will be directly traceable`);
  }

  // Check timing randomization
  if (mergedConfig.randomizedTimingEnabled && mergedConfig.maxInterBuyerDelayMs === 0) {
    warnings.push('Randomized timing enabled but delay is 0, no anonymity benefit');
  }

  // Check treasury rotation
  if (!mergedConfig.treasuryRotationEnabled) {
    errors.push('Treasury rotation disabled - address reuse between launches will link operations on-chain');
  }

  // Check fresh buyers
  if (!mergedConfig.freshBuyersPerLaunch) {
    errors.push('Fresh buyers disabled - reusing buyer addresses will link launches on-chain');
  }

  // Operation-specific recommendations
  switch (operationType) {
    case 'launch':
      if (mergedConfig.stealthLegs < 3) {
        recommendations.push('For launches, use at least 3 stealth legs for effective obfuscation');
      }
      if (mergedConfig.jitterBps < 500) {
        recommendations.push('For launches, use at least ±500bps jitter to break uniform amount patterns');
      }
      break;
    case 'market-making':
      if (!mergedConfig.randomizeFundingAmounts) {
        recommendations.push('For market making, enable funding amount randomization to break patterns');
      }
      break;
    case 'exit':
      if (!mergedConfig.stealthEnabled) {
        recommendations.push('For exit operations, strongly recommend enabling stealth transfers');
      }
      break;
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Wallet Lineage Tracking
// ---------------------------------------------------------------------------

/**
 * Tracks wallet usage to prevent address reuse.
 * Maintains a registry of used addresses per operation type.
 */
class WalletRegistry {
  private usedTreasuries: Set<string> = new Set();
  private usedBuyers: Set<string> = new Set();
  private usedRelays: Set<string> = new Set();

  /**
   * Register a treasury as used.
   */
  registerTreasury(address: string): void {
    this.usedTreasuries.add(address);
  }

  /**
   * Register a buyer wallet as used.
   */
  registerBuyer(address: string): void {
    this.usedBuyers.add(address);
  }

  /**
   * Register a relay wallet as used.
   */
  registerRelay(address: string): void {
    this.usedRelays.add(address);
  }

  /**
   * Check if a treasury has been used before.
   */
  isTreasuryUsed(address: string): boolean {
    return this.usedTreasuries.has(address);
  }

  /**
   * Check if a buyer wallet has been used before.
   */
  isBuyerUsed(address: string): boolean {
    return this.usedBuyers.has(address);
  }

  /**
   * Check if a relay wallet has been used before.
   */
  isRelayUsed(address: string): boolean {
    return this.usedRelays.has(address);
  }

  /**
   * Clear all registrations (for new session).
   */
  clear(): void {
    this.usedTreasuries.clear();
    this.usedBuyers.clear();
    this.usedRelays.clear();
  }

  /**
   * Get statistics on wallet usage.
   */
  getStats(): { treasuries: number; buyers: number; relays: number } {
    return {
      treasuries: this.usedTreasuries.size,
      buyers: this.usedBuyers.size,
      relays: this.usedRelays.size,
    };
  }
}

/** Global wallet registry instance. */
export const walletRegistry = new WalletRegistry();

// ---------------------------------------------------------------------------
// Persistent Wallet Registry
// ---------------------------------------------------------------------------

/** Wallet role kinds tracked by the registry. */
export type WalletRole = 'treasury' | 'buyer' | 'relay';

/** One serialized registry entry: an address plus when it was last used. */
export interface WalletRegistryEntry {
  address: string;
  timestamp: number;
}

/** On-disk registry format. */
interface WalletRegistryFile {
  version: number;
  updatedAt: number;
  treasuries: WalletRegistryEntry[];
  buyers: WalletRegistryEntry[];
  relays: WalletRegistryEntry[];
}

/**
 * File-backed wallet reuse registry.
 *
 * The in-memory `WalletRegistry` loses all history on process exit, so a
 * restart could hand a previously used address to a new launch. This variant
 * persists every registration to `registryPath` (atomic write via rename)
 * and stamps entries with their last-use time so old entries can expire.
 */
export class PersistentWalletRegistry {
  /** Registry file location; null means in-memory only. */
  readonly registryPath: string | null;
  /** Entries older than this (ms) are treated as reusable. */
  readonly maxWalletAgeMs: number;

  private treasuries = new Map<string, number>();
  private buyers = new Map<string, number>();
  private relays = new Map<string, number>();

  constructor(registryPath: string | null, maxWalletAgeMs: number = DEFAULT_ANTI_CORRELATION_CONFIG.maxWalletAgeMs) {
    this.registryPath = registryPath;
    this.maxWalletAgeMs = maxWalletAgeMs;
    if (registryPath) this.load();
  }

  private load(): void {
    if (!this.registryPath) return;
    try {
      if (!fs.existsSync(this.registryPath)) return;
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as Partial<WalletRegistryFile>;
      for (const e of data.treasuries ?? []) this.treasuries.set(e.address, e.timestamp);
      for (const e of data.buyers ?? []) this.buyers.set(e.address, e.timestamp);
      for (const e of data.relays ?? []) this.relays.set(e.address, e.timestamp);
      log.info(
        { treasuries: this.treasuries.size, buyers: this.buyers.size, relays: this.relays.size, path: this.registryPath },
        'wallet registry loaded from disk',
      );
    } catch (err) {
      log.warn({ err, path: this.registryPath }, 'failed to load wallet registry — starting empty');
    }
  }

  /** Atomically persists the registry (write + rename). */
  save(): void {
    if (!this.registryPath) return;
    const data: WalletRegistryFile = {
      version: 1,
      updatedAt: Date.now(),
      treasuries: [...this.treasuries.entries()].map(([address, timestamp]) => ({ address, timestamp })),
      buyers: [...this.buyers.entries()].map(([address, timestamp]) => ({ address, timestamp })),
      relays: [...this.relays.entries()].map(([address, timestamp]) => ({ address, timestamp })),
    };
    try {
      fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
      const tmp = `${this.registryPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.registryPath);
    } catch (err) {
      log.error({ err, path: this.registryPath }, 'failed to save wallet registry');
    }
  }

  private mapFor(role: WalletRole): Map<string, number> {
    return role === 'treasury' ? this.treasuries : role === 'buyer' ? this.buyers : this.relays;
  }

  /** Records an address as used at the current time. */
  register(role: WalletRole, address: string): void {
    this.mapFor(role).set(address, Date.now());
    this.save();
  }

  /**
   * True when the address was used within `maxWalletAgeMs`. Entries older
   * than the window are treated as reusable (and pruned on read).
   */
  isUsed(role: WalletRole, address: string, maxAgeMs: number = this.maxWalletAgeMs): boolean {
    const used = this.mapFor(role).get(address);
    if (used === undefined) return false;
    if (maxAgeMs > 0 && Date.now() - used > maxAgeMs) {
      this.mapFor(role).delete(address);
      return false;
    }
    return true;
  }

  /** Drops every entry older than `maxAgeMs` and persists. */
  clearExpired(maxAgeMs: number = this.maxWalletAgeMs): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const map of [this.treasuries, this.buyers, this.relays]) {
      for (const [address, ts] of map.entries()) {
        if (ts < cutoff) map.delete(address);
      }
    }
    this.save();
  }

  /** Usage statistics (observability). */
  getStats(): { treasuries: number; buyers: number; relays: number } {
    return {
      treasuries: this.treasuries.size,
      buyers: this.buyers.size,
      relays: this.relays.size,
    };
  }
}

/** Global persistent registry instance, keyed by its path. */
let globalPersistentRegistry: PersistentWalletRegistry | null = null;
let globalPersistentRegistryPath: string | null = null;

/**
 * Returns the shared persistent registry for `registryPath`, creating and
 * loading it on first use. Repeated calls with the same path reuse the
 * instance so in-memory and on-disk state stay coherent.
 */
export function getPersistentRegistry(
  registryPath: string | null,
  maxWalletAgeMs: number = DEFAULT_ANTI_CORRELATION_CONFIG.maxWalletAgeMs,
): PersistentWalletRegistry {
  if (!globalPersistentRegistry || globalPersistentRegistryPath !== registryPath) {
    globalPersistentRegistry = new PersistentWalletRegistry(registryPath, maxWalletAgeMs);
    globalPersistentRegistryPath = registryPath;
  }
  return globalPersistentRegistry;
}

/**
 * Ensures a treasury is fresh (not previously used).
 * Generates a new one if the provided treasury has been used before.
 * When a persistent registry is provided it is consulted (cross-session
 * reuse detection) instead of the in-memory registry.
 */
export function ensureFreshTreasury(treasury?: Keypair, registry?: PersistentWalletRegistry): Keypair {
  const isUsed = (address: string): boolean =>
    registry ? registry.isUsed('treasury', address) : walletRegistry.isTreasuryUsed(address);
  const register = (address: string): void =>
    registry ? registry.register('treasury', address) : walletRegistry.registerTreasury(address);

  if (!treasury) {
    const newTreasury = Keypair.generate();
    register(newTreasury.publicKey.toBase58());
    return newTreasury;
  }

  if (isUsed(treasury.publicKey.toBase58())) {
    log.warn(
      { treasury: treasury.publicKey.toBase58().slice(0, 6) },
      'treasury already used, generating fresh one',
    );
    const newTreasury = Keypair.generate();
    register(newTreasury.publicKey.toBase58());
    return newTreasury;
  }

  register(treasury.publicKey.toBase58());
  return treasury;
}

/**
 * Ensures buyer wallets are fresh (not previously used).
 * Generates new ones for any that have been used before.
 */
export function ensureFreshBuyers(buyers: Keypair[], registry?: PersistentWalletRegistry): Keypair[] {
  const freshBuyers: Keypair[] = [];

  for (const buyer of buyers) {
    const used = registry
      ? registry.isUsed('buyer', buyer.publicKey.toBase58())
      : walletRegistry.isBuyerUsed(buyer.publicKey.toBase58());
    if (used) {
      log.warn(
        { buyer: buyer.publicKey.toBase58().slice(0, 6) },
        'buyer already used, generating fresh one',
      );
      const freshBuyer = Keypair.generate();
      if (registry) registry.register('buyer', freshBuyer.publicKey.toBase58());
      else walletRegistry.registerBuyer(freshBuyer.publicKey.toBase58());
      freshBuyers.push(freshBuyer);
    } else {
      if (registry) registry.register('buyer', buyer.publicKey.toBase58());
      else walletRegistry.registerBuyer(buyer.publicKey.toBase58());
      freshBuyers.push(buyer);
    }
  }

  return freshBuyers;
}

/**
 * Ensures relay wallets are fresh (not previously used).
 * Generates new ones for any that have been used before.
 */
export function ensureFreshRelays(relays: Keypair[], registry?: PersistentWalletRegistry): Keypair[] {
  const freshRelays: Keypair[] = [];

  for (const relay of relays) {
    const used = registry
      ? registry.isUsed('relay', relay.publicKey.toBase58())
      : walletRegistry.isRelayUsed(relay.publicKey.toBase58());
    if (used) {
      log.warn(
        { relay: relay.publicKey.toBase58().slice(0, 6) },
        'relay already used, generating fresh one',
      );
      const freshRelay = Keypair.generate();
      if (registry) registry.register('relay', freshRelay.publicKey.toBase58());
      else walletRegistry.registerRelay(freshRelay.publicKey.toBase58());
      freshRelays.push(freshRelay);
    } else {
      if (registry) registry.register('relay', relay.publicKey.toBase58());
      else walletRegistry.registerRelay(relay.publicKey.toBase58());
      freshRelays.push(relay);
    }
  }

  return freshRelays;
}

// ---------------------------------------------------------------------------
// Anonymity Utilities
// ---------------------------------------------------------------------------

/**
 * Calculates a randomized amount within ±jitterBps of the base amount.
 *
 * @param baseAmount - Base amount to randomize
 * @param jitterBps - Jitter in basis points (±)
 * @param rng - Random number generator
 * @returns Randomized amount
 */
export function randomizeAmount(
  baseAmount: bigint,
  jitterBps: number,
  rng: () => number = createCryptoRng(),
): bigint {
  if (jitterBps === 0) return baseAmount;

  const deviation = BigInt(Math.floor(rng() * (jitterBps * 2 + 1))) - BigInt(jitterBps);
  const jittered = baseAmount + (baseAmount * deviation) / 10_000n;
  return jittered > 0n ? jittered : baseAmount;
}

/**
 * Calculates a random delay within the specified range.
 *
 * @param maxDelayMs - Maximum delay in milliseconds
 * @param rng - Random number generator
 * @returns Random delay in milliseconds
 */
export function randomDelay(maxDelayMs: number, rng: () => number = createCryptoRng()): number {
  return Math.floor(rng() * maxDelayMs);
}

/**
 * Jitters a Jito tip amount within ±jitterBps.
 *
 * Identical tip values across bundles are a strong same-operator signal
 * (tip amount + tip account choice); randomizing the amount complements
 * the sender's random tip-account selection.
 *
 * @param baseLamports - Configured tip amount
 * @param jitterBps - Jitter in basis points (±); 0 disables
 * @param rng - Random number generator (default: CSPRNG)
 * @returns Jittered tip, never below 1 lamport
 */
export function generateRandomizedTip(
  baseLamports: bigint,
  jitterBps: number,
  rng: () => number = createCryptoRng(),
): bigint {
  if (jitterBps <= 0 || baseLamports <= 0n) return baseLamports;
  const deviation = BigInt(Math.floor(rng() * (jitterBps * 2 + 1))) - BigInt(jitterBps);
  const jittered = baseLamports + (baseLamports * deviation) / 10_000n;
  return jittered > 0n ? jittered : baseLamports;
}

/**
 * Anonymity-aware RNG. Delegates to the CSPRNG (see `createCryptoRng`); the
 * previous LCG implementation was reconstructible from a few observed draws
 * and is removed — a deterministic seed keeps tests reproducible.
 *
 * @returns Uniform random draw in [0, 1)
 */
export function createSecureRng(seed?: number): () => number {
  const seedBytes =
    seed === undefined
      ? undefined
      : Uint8Array.of(
          (seed >>> 24) & 0xff,
          (seed >>> 16) & 0xff,
          (seed >>> 8) & 0xff,
          seed & 0xff,
        );
  return createCryptoRng(seedBytes);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
  StealthTransferOptions,
};
