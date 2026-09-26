/**
 * Verified on-chain program addresses and well-known accounts.
 *
 * Sources: official Pump.fun public docs (github.com/pump-fun/pump-public-docs),
 * Moonit SDK (github.com/gomoonit/moonit-sdk), Raydium docs (docs.raydium.io)
 * and raydium-sdk-V2 source, OpenBook docs (github.com/openbook-dex/openbook-v2),
 * Metaplex documentation, Solana Labs.
 * @module
 */

import { PublicKey, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

/** Canonical program addresses used across the toolkit. */
export const PROGRAMS = {
  /** SPL Token program. */
  TOKEN: TOKEN_PROGRAM_ID.toBase58(),
  /** Token-2022 program. */
  TOKEN_2022: TOKEN_2022_PROGRAM_ID.toBase58(),
  /** Associated Token Account program. */
  ATA: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  /** Metaplex Token Metadata program. */
  METAPLEX_TOKEN_METADATA: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  /** Pump.fun bonding curve program (mainnet + devnet). */
  PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** Pump.fun AMM (PumpSwap). */
  PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  /** Pump fees program. */
  PUMPFUN_FEES: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  /** Moonit (Moonshot) token launchpad. */
  MOONIT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',
  /** Raydium AMM v4 (hybrid AMM + OpenBook). */
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  /** Raydium CPMM (standard constant-product AMM). */
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  /** Raydium CLMM (concentrated liquidity). */
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  /** OpenBook V1 (Serum v3). */
  OPENBOOK_V1: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  /** OpenBook V2. */
  OPENBOOK_V2: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
  /** Raydium fee destination for AMM v4 pool creation. */
  RAYDIUM_FEE_DESTINATION: '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5',
} as const;

/** Wrapped SOL mint. */
export const WSOL_MINT = NATIVE_MINT.toBase58();

/** System program (for convenience imports without web3.js). */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Sysvar rent. */
export const RENT_SYSVAR = SYSVAR_RENT_PUBKEY.toBase58();

/** Pump.fun fee recipients (normal, non-mayhem coins). Pick one at random. */
export const PUMPFUN_FEE_RECIPIENTS = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
] as const;

/** PumpSwap global config account (PDA ["global_config"]). */
export const PUMPSWAP_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

/** Moonit fee accounts (official moonit-sdk feeAccounts.ts). */
export const MOONIT_HELIO_FEE = '5K5RtTWzzLp4P8Npi84ocf7F1vBsAu29N1irG4iiUnzt';
export const MOONIT_DEX_FEE = '3udvfL24waJcLhskRAsStNMoNUvtyXdxrWQz4hgi953N';

/** Raydium public API for pool info (mainnet). */
export const RAYDIUM_API_MAINNET = 'https://api-v3.raydium.io';
/** Raydium public API for pool info (devnet). */
export const RAYDIUM_API_DEVNET = 'https://api-v3-devnet.raydium.io';

/** Raydium AMM v4 model data account used by v5 pools (stable curve). */
export const RAYDIUM_V5_MODEL_DATA = 'CDSr3ssLcRB6XYPJwAfFt18MZvEZp4LjHcvzBVZ45duo';

/**
 * Devnet variants of programs that differ from mainnet (Raydium suite).
 */
export const DEVNET_PROGRAMS = {
  RAYDIUM_AMM_V4: 'DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav',
  RAYDIUM_CPMM: 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb',
  RAYDIUM_CLMM: 'DRayAUgENGQBKVaX8owNhgmkUDvC3saHn4dHZWrfWzh',
} as const;

/**
 * Resolves a program address for the active cluster.
 */
export function programForCluster(programId: string, cluster: string): PublicKey {
  const isDevnet = cluster === 'devnet';
  if (programId === PROGRAMS.RAYDIUM_AMM_V4 && isDevnet) {
    return new PublicKey(DEVNET_PROGRAMS.RAYDIUM_AMM_V4);
  }
  if (programId === PROGRAMS.RAYDIUM_CPMM && isDevnet) {
    return new PublicKey(DEVNET_PROGRAMS.RAYDIUM_CPMM);
  }
  if (programId === PROGRAMS.RAYDIUM_CLMM && isDevnet) {
    return new PublicKey(DEVNET_PROGRAMS.RAYDIUM_CLMM);
  }
  return new PublicKey(programId);
}

/** PublicKey cache to avoid re-parsing. */
const pkCache = new Map<string, PublicKey>();
export function pk(address: string): PublicKey {
  let cached = pkCache.get(address);
  if (!cached) {
    cached = new PublicKey(address);
    pkCache.set(address, cached);
  }
  return cached;
}
