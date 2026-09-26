/**
 * PumpSwap — the Pump.fun AMM used after bonding-curve graduation.
 *
 * Program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
 * Constant-product pools with a Token-2022 LP mint; base currency is the
 * graduated token, quote is WSOL.
 * @module
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PROGRAMS, PUMPSWAP_GLOBAL_CONFIG, WSOL_MINT, pk } from './constants.js';
import {
  anchorDiscriminator,
  findPda,
  pumpOptionBool,
  u16,
  u64,
} from './encoding.js';
import {
  pumpAmmEventAuthorityPda,
  pumpAmmLpMintPda,
  pumpAmmPoolAuthorityPda,
  pumpAmmPoolPda,
  pumpGlobalVolumeAccumulatorPda,
  pumpUserVolumeAccumulatorPda,
  randomFeeRecipient,
  pumpFeeConfigPda,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
} from './pumpfun.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhMoASNFJRrDh1uudaQUkuoZ4D';

function meta(pubkey: PublicKey, writable = false, signer = false) {
  return { pubkey, isWritable: writable, isSigner: signer };
}

/** Protocol fee recipient for PumpSwap swaps (from the official fee config). */
export const PUMPSWAP_PROTOCOL_FEE_RECIPIENT =
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY';

/** Decoded PumpSwap pool account (core fields). */
export interface PumpSwapPoolAccount {
  poolBump: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  lpSupply: bigint;
}

/**
 * Decodes a PumpSwap pool account: 8 disc + pool_bump u8 + config index u16 +
 * creator + coin_creator + base_mint + quote_mint + lp_mint + pad [u8;64] +
 * pool_base_token_account + pool_quote_token_account + lp_supply u64 + …
 */
export function decodePumpSwapPool(data: Buffer): PumpSwapPoolAccount {
  let offset = 8;
  const poolBump = data.readUInt8(offset);
  offset += 1 + 2; // pool_bump + config_index u16
  const creator = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const coinCreator = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  void coinCreator;
  const baseMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const quoteMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const lpMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32 + 64; // pad
  const poolBaseTokenAccount = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const poolQuoteTokenAccount = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const lpSupply = data.readBigUInt64LE(offset);
  return {
    poolBump,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
  };
}

/**
 * Standard swap account set for PumpSwap buy/sell instructions.
 */
export function pumpSwapAccounts(params: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
}): {
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  protocolFeeRecipientTokenAccount: PublicKey;
  coinCreatorVaultAta: PublicKey;
  coinCreatorVaultAuthority: PublicKey;
} {
  const baseProgram = params.baseTokenProgram ?? TOKEN_PROGRAM_ID;
  const quoteProgram = params.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const poolBaseTokenAccount = getAssociatedTokenAddressSync(params.baseMint, params.pool, true, baseProgram);
  const poolQuoteTokenAccount = getAssociatedTokenAddressSync(params.quoteMint, params.pool, true, quoteProgram);
  const userBaseTokenAccount = getAssociatedTokenAddressSync(params.baseMint, params.user, true, baseProgram);
  const userQuoteTokenAccount = getAssociatedTokenAddressSync(params.quoteMint, params.user, true, quoteProgram);
  const protocolFeeRecipient = pk(PUMPSWAP_PROTOCOL_FEE_RECIPIENT);
  const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
    params.quoteMint,
    protocolFeeRecipient,
    true,
    quoteProgram,
  );
  const coinCreatorVaultAuthority = findPda(['coin_creator_vault', params.pool], PUMP_AMM_PROGRAM_ID);
  const coinCreatorVaultAta = getAssociatedTokenAddressSync(params.quoteMint, coinCreatorVaultAuthority, true, quoteProgram);
  return {
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    userBaseTokenAccount,
    userQuoteTokenAccount,
    protocolFeeRecipientTokenAccount,
    coinCreatorVaultAta,
    coinCreatorVaultAuthority,
  };
}

/**
 * Builds the PumpSwap `buy` instruction (base out, quote in).
 */
export function pumpSwapBuyInstruction(params: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAmountOut: bigint;
  maxQuoteAmountIn: bigint;
  trackVolume?: boolean;
}): TransactionInstruction {
  const acc = pumpSwapAccounts(params);
  const data = Buffer.concat([
    anchorDiscriminator('buy'),
    u64(params.baseAmountOut),
    u64(params.maxQuoteAmountIn),
    pumpOptionBool(params.trackVolume ?? true),
  ]);
  return new TransactionInstruction({
    programId: pk(PUMP_AMM_PROGRAM_ID),
    keys: [
      meta(params.pool, true), // pool
      meta(params.user, true, true), // user
      meta(pk(PUMPSWAP_GLOBAL_CONFIG)), // global_config
      meta(params.baseMint), // base_mint
      meta(params.quoteMint), // quote_mint
      meta(acc.userBaseTokenAccount, true), // user_base_token_account
      meta(acc.userQuoteTokenAccount, true), // user_quote_token_account
      meta(acc.poolBaseTokenAccount, true), // pool_base_token_account
      meta(acc.poolQuoteTokenAccount, true), // pool_quote_token_account
      meta(pk(PUMPSWAP_PROTOCOL_FEE_RECIPIENT)), // protocol_fee_recipient
      meta(acc.protocolFeeRecipientTokenAccount, true), // protocol_fee_recipient_token_account
      meta(TOKEN_PROGRAM_ID), // base_token_program
      meta(TOKEN_PROGRAM_ID), // quote_token_program
      meta(SystemProgram.programId), // system_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(pumpAmmEventAuthorityPda()), // event_authority
      meta(pk(PUMP_AMM_PROGRAM_ID)), // program
      meta(acc.coinCreatorVaultAta, true), // coin_creator_vault_ata
      meta(acc.coinCreatorVaultAuthority), // coin_creator_vault_authority
      meta(pumpGlobalVolumeAccumulatorPda()), // global_volume_accumulator
      meta(pumpUserVolumeAccumulatorPda(params.user.toBase58()), true), // user_volume_accumulator
      meta(pumpFeeConfigPda()), // fee_config
      meta(pk(PUMP_FEES_PROGRAM_ID)), // fee_program
    ],
    data,
  });
}

/**
 * Builds the PumpSwap `sell` instruction (base in, quote out).
 */
export function pumpSwapSellInstruction(params: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAmountIn: bigint;
  minQuoteAmountOut: bigint;
}): TransactionInstruction {
  const acc = pumpSwapAccounts(params);
  const data = Buffer.concat([
    anchorDiscriminator('sell'),
    u64(params.baseAmountIn),
    u64(params.minQuoteAmountOut),
  ]);
  return new TransactionInstruction({
    programId: pk(PUMP_AMM_PROGRAM_ID),
    keys: [
      meta(params.pool, true), // pool
      meta(params.user, true, true), // user
      meta(pk(PUMPSWAP_GLOBAL_CONFIG)), // global_config
      meta(params.baseMint), // base_mint
      meta(params.quoteMint), // quote_mint
      meta(acc.userBaseTokenAccount, true), // user_base_token_account
      meta(acc.userQuoteTokenAccount, true), // user_quote_token_account
      meta(acc.poolBaseTokenAccount, true), // pool_base_token_account
      meta(acc.poolQuoteTokenAccount, true), // pool_quote_token_account
      meta(pk(PUMPSWAP_PROTOCOL_FEE_RECIPIENT)), // protocol_fee_recipient
      meta(acc.protocolFeeRecipientTokenAccount, true), // protocol_fee_recipient_token_account
      meta(TOKEN_PROGRAM_ID), // base_token_program
      meta(TOKEN_PROGRAM_ID), // quote_token_program
      meta(SystemProgram.programId), // system_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(pumpAmmEventAuthorityPda()), // event_authority
      meta(pk(PUMP_AMM_PROGRAM_ID)), // program
      meta(acc.coinCreatorVaultAta, true), // coin_creator_vault_ata
      meta(acc.coinCreatorVaultAuthority), // coin_creator_vault_authority
      meta(pumpFeeConfigPda()), // fee_config
      meta(pk(PUMP_FEES_PROGRAM_ID)), // fee_program
    ],
    data,
  });
}

/**
 * Builds the PumpSwap `deposit` instruction (add liquidity).
 */
export function pumpSwapDepositInstruction(params: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpTokenAmountOut: bigint;
  maxBaseAmountIn: bigint;
  maxQuoteAmountIn: bigint;
}): TransactionInstruction {
  const acc = pumpSwapAccounts(params);
  const lpMint = pumpAmmLpMintPda(params.pool);
  const userPoolTokenAccount = getAssociatedTokenAddressSync(lpMint, params.user, true, pk(TOKEN_2022));
  const data = Buffer.concat([
    anchorDiscriminator('deposit'),
    u64(params.lpTokenAmountOut),
    u64(params.maxBaseAmountIn),
    u64(params.maxQuoteAmountIn),
  ]);
  return new TransactionInstruction({
    programId: pk(PUMP_AMM_PROGRAM_ID),
    keys: [
      meta(params.pool, true),
      meta(pk(PUMPSWAP_GLOBAL_CONFIG)),
      meta(params.user, false, true),
      meta(params.baseMint),
      meta(params.quoteMint),
      meta(acc.userBaseTokenAccount, true),
      meta(acc.userQuoteTokenAccount, true),
      meta(userPoolTokenAccount, true),
      meta(acc.poolBaseTokenAccount, true),
      meta(acc.poolQuoteTokenAccount, true),
      meta(TOKEN_PROGRAM_ID),
      meta(pk(TOKEN_2022)),
      meta(pumpAmmEventAuthorityPda()),
      meta(pk(PUMP_AMM_PROGRAM_ID)),
    ],
    data,
  });
}

/**
 * Builds the PumpSwap `withdraw` instruction (remove liquidity).
 */
export function pumpSwapWithdrawInstruction(params: {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpTokenAmountIn: bigint;
  minBaseAmountOut: bigint;
  minQuoteAmountOut: bigint;
}): TransactionInstruction {
  const acc = pumpSwapAccounts(params);
  const lpMint = pumpAmmLpMintPda(params.pool);
  const userPoolTokenAccount = getAssociatedTokenAddressSync(lpMint, params.user, true, pk(TOKEN_2022));
  const data = Buffer.concat([
    anchorDiscriminator('withdraw'),
    u64(params.lpTokenAmountIn),
    u64(params.minBaseAmountOut),
    u64(params.minQuoteAmountOut),
  ]);
  return new TransactionInstruction({
    programId: pk(PUMP_AMM_PROGRAM_ID),
    keys: [
      meta(params.pool, true),
      meta(pk(PUMPSWAP_GLOBAL_CONFIG)),
      meta(params.user, false, true),
      meta(params.baseMint),
      meta(params.quoteMint),
      meta(acc.userBaseTokenAccount, true),
      meta(acc.userQuoteTokenAccount, true),
      meta(userPoolTokenAccount, true),
      meta(acc.poolBaseTokenAccount, true),
      meta(acc.poolQuoteTokenAccount, true),
      meta(TOKEN_PROGRAM_ID),
      meta(pk(TOKEN_2022)),
      meta(pumpAmmEventAuthorityPda()),
      meta(pk(PUMP_AMM_PROGRAM_ID)),
    ],
    data,
  });
}

export { u16, pumpAmmPoolPda, randomFeeRecipient };
