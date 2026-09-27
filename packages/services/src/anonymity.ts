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
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
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
 * Funds a set of buyer wallets from treasury with randomized amounts
 * and delays for anonymity.
 *
 * ANONYMITY FEATURES:
 * - Randomizes funding amounts within ±maxFundingDeviationBps
 * - Applies randomized delays between funding operations
 * - Uses distinct wallet addresses for each buyer
 * - Prevents timing patterns that could link wallets
 *
 * @param params - Funding parameters including treasury, buyers, and anonymity config
 * @returns Result with list of funded wallets, failures, and actual amounts
 */
export async function fundBuyersAnonymously(
  params: FundBuyersParams,
): Promise<FundBuyersResult> {
  const { ctx, treasury, buyers, lamportsPerBuyer, anonymity, mode, rng } = params;
  const funded: string[] = [];
  const failures: string[] = [];
  const amounts: Record<string, bigint> = {};
  const actualRng = rng ?? Math.random;

  for (const [index, buyer] of buyers.entries()) {
    try {
      // Calculate randomized funding amount
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

      // Add funding overhead for fees/rent
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

      funded.push(buyer.publicKey.toBase58());
      amounts[buyer.publicKey.toBase58()] = amount;

      // Random delay between funding operations
      if (anonymity.randomizedTimingEnabled && index < buyers.length - 1) {
        const delay = Math.floor(actualRng() * anonymity.maxInterBuyerDelayMs);
        await sleep(delay);
      }

      log.debug(
        { buyer: buyer.publicKey.toBase58().slice(0, 6), amount: amount.toString() },
        'anonymized buyer funding complete',
      );
    } catch (err) {
      const errorMsg = `${buyer.publicKey.toBase58()}: ${err}`;
      failures.push(errorMsg);
      log.error({ err, buyer: buyer.publicKey.toBase58() }, 'anonymized funding failed');
    }
  }

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

/**
 * Ensures a treasury is fresh (not previously used).
 * Generates a new one if the provided treasury has been used before.
 */
export function ensureFreshTreasury(treasury?: Keypair): Keypair {
  if (!treasury) {
    const newTreasury = Keypair.generate();
    walletRegistry.registerTreasury(newTreasury.publicKey.toBase58());
    return newTreasury;
  }

  if (walletRegistry.isTreasuryUsed(treasury.publicKey.toBase58())) {
    log.warn(
      { treasury: treasury.publicKey.toBase58().slice(0, 6) },
      'treasury already used, generating fresh one',
    );
    const newTreasury = Keypair.generate();
    walletRegistry.registerTreasury(newTreasury.publicKey.toBase58());
    return newTreasury;
  }

  walletRegistry.registerTreasury(treasury.publicKey.toBase58());
  return treasury;
}

/**
 * Ensures buyer wallets are fresh (not previously used).
 * Generates new ones for any that have been used before.
 */
export function ensureFreshBuyers(buyers: Keypair[]): Keypair[] {
  const freshBuyers: Keypair[] = [];

  for (const buyer of buyers) {
    if (walletRegistry.isBuyerUsed(buyer.publicKey.toBase58())) {
      log.warn(
        { buyer: buyer.publicKey.toBase58().slice(0, 6) },
        'buyer already used, generating fresh one',
      );
      const freshBuyer = Keypair.generate();
      walletRegistry.registerBuyer(freshBuyer.publicKey.toBase58());
      freshBuyers.push(freshBuyer);
    } else {
      walletRegistry.registerBuyer(buyer.publicKey.toBase58());
      freshBuyers.push(buyer);
    }
  }

  return freshBuyers;
}

/**
 * Ensures relay wallets are fresh (not previously used).
 * Generates new ones for any that have been used before.
 */
export function ensureFreshRelays(relays: Keypair[]): Keypair[] {
  const freshRelays: Keypair[] = [];

  for (const relay of relays) {
    if (walletRegistry.isRelayUsed(relay.publicKey.toBase58())) {
      log.warn(
        { relay: relay.publicKey.toBase58().slice(0, 6) },
        'relay already used, generating fresh one',
      );
      const freshRelay = Keypair.generate();
      walletRegistry.registerRelay(freshRelay.publicKey.toBase58());
      freshRelays.push(freshRelay);
    } else {
      walletRegistry.registerRelay(relay.publicKey.toBase58());
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
  rng: () => number = Math.random,
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
export function randomDelay(maxDelayMs: number, rng: () => number = Math.random): number {
  return Math.floor(rng() * maxDelayMs);
}

/**
 * Creates an anonymity-aware RNG that combines multiple sources of entropy.
 *
 * @returns Enhanced RNG function
 */
export function createSecureRng(seed?: number): () => number {
  // Use seed if provided, otherwise use Date.now() + Math.random()
  let internalSeed = seed ?? Date.now();

  return () => {
    // Simple LCG for deterministic tests, but combined with Math.random() for real usage
    internalSeed = (1664525 * internalSeed + 1013904223) & 0xffffffff;
    return (internalSeed / 0xffffffff) * (Math.random() * 0.5 + 0.5);
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type {
  StealthTransferOptions,
};
