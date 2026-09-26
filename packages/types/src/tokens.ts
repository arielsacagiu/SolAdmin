/**
 * Token, metadata, NFT, and market-related types.
 * @module
 */

import type { TokenProgramKind } from './common.js';

/** Token metadata (Metaplex compatible). */
export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
  /** Optional JSON appended by static-site generator / metadata services. */
  description?: string;
}

/** Token-2022 transfer-fee extension configuration. */
export interface TransferFeeConfigSpec {
  /** Fee in basis points (max 10_000 = 100%). */
  bps: number;
  /** Max fee charged per transfer in raw base units. */
  maxFeeRaw: bigint;
  /** Authority allowed to change the fee. */
  transferFeeAuthority?: string;
}

/** Full token creation request (SPL or Token-2022). */
export interface CreateTokenSpec {
  metadata: TokenMetadata;
  decimals: number;
  /** Total supply to mint in raw base units. */
  initialSupplyRaw: bigint;
  tokenProgram: TokenProgramKind;
  /** Token-2022 transfer fee (tax on every transfer). */
  transferFee?: TransferFeeConfigSpec;
  /** Token-2022 transfer-hook program implementing custom tax logic. */
  transferHookProgramId?: string;
  /** Keep the mint authority after creation (WARNING: less safe for holders). */
  keepMintAuthority?: boolean;
  /** Keep the freeze authority after creation (WARNING: less safe for holders). */
  keepFreezeAuthority?: boolean;
  /** Revoke update (metadata) authority after creation. */
  revokeMetadataAuthority?: boolean;
}

/** Derived token creation report. */
export interface TokenCreationReport {
  mint: string;
  tokenProgram: string;
  metadataAccount: string;
  decimals: number;
  supplyRaw: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataAuthorityRevoked: boolean;
  signature?: string;
  simulated: boolean;
}

/** Simplified on-chain token audit summary. */
export interface TokenAudit {
  mint: string;
  tokenProgram: string;
  decimals: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadata?: TokenMetadata;
  /** Detected transfer fee (Token-2022) in bps. */
  transferFeeBps?: number;
  /** Detected transfer hook program (Token-2022 custom tax). */
  transferHookProgram?: string;
  /** Bonding curve state when the mint is a Pump.fun coin. */
  pumpfun?: {
    bondingCurve: string;
    virtualTokenReserves: string;
    virtualSolReserves: string;
    realTokenReserves: string;
    realSolReserves: string;
    complete: boolean;
  };
  /** LP status for the mint on major venues. */
  liquidity: {
    venue: string;
    pool: string;
    liquidityRaw: string;
  }[];
  /** Human-readable risk findings. */
  findings: string[];
}

/** Holder scan row. */
export interface HolderRow {
  rank: number;
  publicKey: string;
  owner?: string;
  balanceRaw: string;
  /** Balance divided by supply, 0..1. */
  share: number;
}

/** NFT holder scan row. */
export interface NftHolderRow {
  mint: string;
  owner: string;
  tokenAccount: string;
  name?: string;
}

/** Market (OpenBook) management snapshot. */
export interface MarketInfo {
  marketId: string;
  programId: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  bids: string;
  asks: string;
  eventQueue: string;
  requestQueue: string;
  baseLotSize: string;
  quoteLotSize: string;
  feeRateBps: number;
  vaultSignerNonce: number;
}

/** Authority management request types. */
export type AuthorityKind = 'mint' | 'freeze' | 'metadata' | 'update' | 'market-admin';

export interface AuthorityAction {
  kind: AuthorityKind;
  action: 'revoke' | 'transfer';
  newAuthority?: string;
}
