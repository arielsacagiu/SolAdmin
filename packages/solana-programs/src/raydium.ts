/**
 * Raydium AMM v4 — direct instruction builders verified against the official
 * raydium-sdk-V2 source (src/raydium/liquidity/*).
 *
 * Program: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`.
 * Includes: pool key PDA derivation, `createPool` (instruction 1),
 * `swapBaseIn` (9) and `swapBaseOut` (11) with the full serum account list,
 * plus the simplified no-serum variants (16/17), and pool discovery through
 * the public Raydium pool-info API. CPMM/CLMM pool creation is handled by the
 * official `@raydium-io/raydium-sdk-v2` in the dex package.
 * @module
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PROGRAMS, pk } from './constants.js';
import { findPda, u64, u8 } from './encoding.js';

export const RAYDIUM_AMM_V4_PROGRAM_ID = PROGRAMS.RAYDIUM_AMM_V4;

/** AMM v4 authority PDA (seeds: "amm authority"). */
export function ammV4Authority(): PublicKey {
  return findPda(['amm authority'], RAYDIUM_AMM_V4_PROGRAM_ID);
}

/** AMM config PDA (seeds: "amm_config_account_seed"). */
export function ammV4ConfigId(): PublicKey {
  return findPda(['amm_config_account_seed'], RAYDIUM_AMM_V4_PROGRAM_ID);
}

/** Full derived pool key set for an AMM v4 pool given its OpenBook market. */
export interface AmmV4PoolKeys {
  ammId: PublicKey;
  ammAuthority: PublicKey;
  ammOpenOrders: PublicKey;
  ammTargetOrders: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  lpVault: PublicKey;
  withdrawQueue: PublicKey;
  marketId: PublicKey;
  marketProgramId: PublicKey;
  marketAuthority: PublicKey;
  configId: PublicKey;
  nonce: number;
}

/**
 * Derives all AMM v4 pool accounts from a market id (verified seed list from
 * raydium-sdk-V2 `getAssociatedPoolKeys`). The `nonce` is the authority PDA
 * bump — the on-chain program re-derives the authority with it.
 */
export function deriveAmmV4PoolKeys(marketId: PublicKey, marketProgramId: PublicKey): AmmV4PoolKeys {
  const seedWith = (name: string) => findPda([pk(RAYDIUM_AMM_V4_PROGRAM_ID), marketId, name], RAYDIUM_AMM_V4_PROGRAM_ID);
  const [authority, nonce] = PublicKey.findProgramAddressSync([], pk(RAYDIUM_AMM_V4_PROGRAM_ID));
  return {
    ammId: seedWith('amm_associated_seed'),
    ammAuthority: authority,
    ammOpenOrders: findPda([pk(RAYDIUM_AMM_V4_PROGRAM_ID), marketId, 'open_order_associated_seed'], RAYDIUM_AMM_V4_PROGRAM_ID),
    ammTargetOrders: seedWith('target_associated_seed'),
    lpMint: seedWith('lp_mint_associated_seed'),
    baseVault: seedWith('coin_vault_associated_seed'),
    quoteVault: seedWith('pc_vault_associated_seed'),
    lpVault: seedWith('temp_lp_token_associated_seed'),
    withdrawQueue: seedWith('withdraw_associated_seed'),
    marketId,
    marketProgramId,
    marketAuthority: serumMarketAuthority(marketProgramId),
    configId: ammV4ConfigId(),
    nonce,
  };
}

/** Serum/OpenBook V1 market authority = PDA([], market program). */
export function serumMarketAuthority(marketProgramId: PublicKey): PublicKey {
  const [authority] = PublicKey.findProgramAddressSync([], marketProgramId);
  return authority;
}

/**
 * Builds the AMM v4 `createPool` instruction (legacy instruction id 1) that
 * seeds a new pool from user wallets against an existing OpenBook market.
 */
export function ammV4CreatePoolInstruction(params: {
  userWallet: PublicKey;
  userBaseVault: PublicKey;
  userQuoteVault: PublicKey;
  userLpVault: PublicKey;
  keys: AmmV4PoolKeys;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  openTime: bigint;
  baseAmount: bigint;
  quoteAmount: bigint;
}): TransactionInstruction {
  const data = Buffer.concat([
    u8(1), // instruction: initialize
    u8(params.keys.nonce),
    u64(params.openTime),
    u64(params.quoteAmount),
    u64(params.baseAmount),
  ]);
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
  return new TransactionInstruction({
    programId: pk(RAYDIUM_AMM_V4_PROGRAM_ID),
    keys: [
      m(TOKEN_PROGRAM_ID), // 0 token program
      m(ASSOCIATED_TOKEN_PROGRAM_ID), // 1
      m(SystemProgram.programId), // 2
      m(pk('SysvarRent111111111111111111111111111111111')), // 3
      m(params.keys.ammId, true), // 4
      m(params.keys.ammAuthority), // 5
      m(params.keys.ammOpenOrders, true), // 6
      m(params.keys.lpMint, true), // 7
      m(params.baseMint), // 8
      m(params.quoteMint), // 9
      m(params.keys.baseVault, true), // 10
      m(params.keys.quoteVault, true), // 11
      m(params.keys.ammTargetOrders, true), // 12
      m(params.keys.configId), // 13
      m(pk(PROGRAMS.RAYDIUM_FEE_DESTINATION), true), // 14 fee destination
      m(params.keys.marketProgramId), // 15
      m(params.keys.marketId), // 16
      m(params.userWallet, true, true), // 17
      m(params.userBaseVault, true), // 18
      m(params.userQuoteVault, true), // 19
      m(params.userLpVault, true), // 20
    ],
    data,
  });
}

/** Reserves of an AMM v4 pool are read from the pool's vault token accounts
 * via `getTokenAccountBalance` (see the dex package) rather than decoded from
 * the pool account — simpler and version-proof. */

// ---------------------------------------------------------------------------
// Swaps
// ---------------------------------------------------------------------------

/** Serum market accounts needed by classic AMM v4 swap instructions. */
export interface SerumMarketAccounts {
  marketProgramId: PublicKey;
  marketId: PublicKey;
  marketBids: PublicKey;
  marketAsks: PublicKey;
  marketEventQueue: PublicKey;
  marketBaseVault: PublicKey;
  marketQuoteVault: PublicKey;
  marketAuthority: PublicKey;
}

/**
 * Builds the classic `swapBaseIn` (instruction 9): exact input, minimum
 * output. Includes the full serum account set — compatible with every AMM v4
 * pool on mainnet.
 */
export function ammV4SwapBaseInInstruction(params: {
  poolKeys: AmmV4PoolKeys;
  marketAccounts: SerumMarketAccounts;
  userSourceTokenAccount: PublicKey;
  userDestinationTokenAccount: PublicKey;
  userOwner: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  poolVersion?: 4 | 5;
  modelDataPubkey?: string;
}): TransactionInstruction {
  const data = Buffer.concat([u8(9), u64(params.amountIn), u64(params.minAmountOut)]);
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
  const keys = [
    m(TOKEN_PROGRAM_ID), // 0
    m(params.poolKeys.ammId, true), // 1
    m(params.poolKeys.ammAuthority), // 2
    m(params.poolKeys.ammOpenOrders, true), // 3
    m(params.poolKeys.ammTargetOrders, true), // 4
    m(params.poolKeys.baseVault, true), // 5
    m(params.poolKeys.quoteVault, true), // 6
  ];
  if (params.poolVersion === 5) {
    keys.push(m(pk(params.modelDataPubkey ?? 'CDSr3ssLcRB6XYPJwAfFt18MZvEZp4LjHcvzBVZ45duo')));
  }
  keys.push(
    m(params.marketAccounts.marketProgramId), // 7
    m(params.marketAccounts.marketId), // 8
    m(params.marketAccounts.marketBids, true), // 9
    m(params.marketAccounts.marketAsks, true), // 10
    m(params.marketAccounts.marketEventQueue, true), // 11
    m(params.marketAccounts.marketBaseVault, true), // 12
    m(params.marketAccounts.marketQuoteVault, true), // 13
    m(params.marketAccounts.marketAuthority), // 14
    m(params.userSourceTokenAccount, true), // 15
    m(params.userDestinationTokenAccount, true), // 16
    m(params.userOwner, false, true), // 17
  );
  return new TransactionInstruction({ programId: pk(RAYDIUM_AMM_V4_PROGRAM_ID), keys, data });
}

/**
 * Builds `swapBaseOut` (instruction 11): exact output, maximum input.
 */
export function ammV4SwapBaseOutInstruction(params: {
  poolKeys: AmmV4PoolKeys;
  marketAccounts: SerumMarketAccounts;
  userSourceTokenAccount: PublicKey;
  userDestinationTokenAccount: PublicKey;
  userOwner: PublicKey;
  maxAmountIn: bigint;
  amountOut: bigint;
  poolVersion?: 4 | 5;
  modelDataPubkey?: string;
}): TransactionInstruction {
  const data = Buffer.concat([u8(11), u64(params.maxAmountIn), u64(params.amountOut)]);
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
  const keys = [
    m(TOKEN_PROGRAM_ID),
    m(params.poolKeys.ammId, true),
    m(params.poolKeys.ammAuthority),
    m(params.poolKeys.ammOpenOrders, true),
    m(params.poolKeys.ammTargetOrders, true),
    m(params.poolKeys.baseVault, true),
    m(params.poolKeys.quoteVault, true),
  ];
  if (params.poolVersion === 5) {
    keys.push(m(pk(params.modelDataPubkey ?? 'CDSr3ssLcRB6XYPJwAfFt18MZvEZp4LjHcvzBVZ45duo')));
  }
  keys.push(
    m(params.marketAccounts.marketProgramId),
    m(params.marketAccounts.marketId),
    m(params.marketAccounts.marketBids, true),
    m(params.marketAccounts.marketAsks, true),
    m(params.marketAccounts.marketEventQueue, true),
    m(params.marketAccounts.marketBaseVault, true),
    m(params.marketAccounts.marketQuoteVault, true),
    m(params.marketAccounts.marketAuthority),
    m(params.userSourceTokenAccount, true),
    m(params.userDestinationTokenAccount, true),
    m(params.userOwner, false, true),
  );
  return new TransactionInstruction({ programId: pk(RAYDIUM_AMM_V4_PROGRAM_ID), keys, data });
}

/**
 * Builds the simplified `swapBaseIn` (instruction 16) — no serum accounts,
 * used by newer AMM v4 pools. Validate on-chain which variant a pool accepts
 * via simulation before executing.
 */
export function ammV4SwapSimpleInInstruction(params: {
  poolId: PublicKey;
  auth: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  ownerTokenIn: PublicKey;
  ownerTokenOut: PublicKey;
  owner: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
}): TransactionInstruction {
  const data = Buffer.concat([u8(16), u64(params.amountIn), u64(params.minAmountOut)]);
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
  return new TransactionInstruction({
    programId: pk(RAYDIUM_AMM_V4_PROGRAM_ID),
    keys: [
      m(TOKEN_PROGRAM_ID),
      m(params.poolId, true),
      m(params.auth),
      m(params.vaultA, true),
      m(params.vaultB, true),
      m(params.ownerTokenIn, true),
      m(params.ownerTokenOut, true),
      m(params.owner, false, true),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Raydium public pool-info API (free, public)
// ---------------------------------------------------------------------------

/** Pool-info API record (subset used by the toolkit). */
export interface RaydiumPoolInfo {
  id: string;
  mintA: { address: string; decimals: number };
  mintB: { address: string; decimals: number };
  price: number;
  liquidity: number;
  type: string;
  programId: string;
  marketId?: string;
}

/**
 * Fetches standard (AMM v4 / CPMM / CLMM) pools for a mint pair from the
 * public Raydium pool-info API. Self-hostable / cacheable.
 */
export async function fetchRaydiumPoolsByMints(
  apiBase: string,
  mintA: string,
  mintB: string,
): Promise<RaydiumPoolInfo[]> {
  const url = `${apiBase.replace(/\/$/, '')}/v3/pools/info/mint?mint1=${mintA}&mint2=${mintB}&poolType=standard&page=1&pageSize=50`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Raydium API error: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { data?: unknown[]; count?: number } };
  const rows = (json.data?.data ?? []) as Record<string, unknown>[];
  return rows.map((row) => {
    const mintAInfo = row['mintA'] as { address: string; decimals: number };
    const mintBInfo = row['mintB'] as { address: string; decimals: number };
    return {
      id: String(row['id']),
      mintA: mintAInfo,
      mintB: mintBInfo,
      price: Number(row['price'] ?? 0),
      liquidity: Number(row['liquidity'] ?? 0),
      type: String(row['type'] ?? ''),
      programId: String(row['programId'] ?? ''),
      marketId: row['marketId'] ? String(row['marketId']) : undefined,
    };
  });
}

/** Constant-product swap math used for AMM v4 quotes (fees: 0.25%). */
export function ammV4QuoteOut(params: {
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  feeBps?: number;
}): bigint {
  const feeBps = BigInt(params.feeBps ?? 25);
  const amountInWithFee = params.amountIn * (10_000n - feeBps);
  const numerator = amountInWithFee * params.reserveOut;
  const denominator = params.reserveIn * 10_000n + amountInWithFee;
  return numerator / denominator;
}
