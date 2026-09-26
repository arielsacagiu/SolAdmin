/**
 * Moonit (Moonshot) token launchpad — direct on-chain instruction builders.
 *
 * Program: `MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG` (verified against the
 * official moonit-sdk IDL v4). `buy` and `sell` are permissionless and fully
 * local. `token_mint` (launch) additionally requires Moonit's backend
 * authority signature, so launches go through Moonit's free prepareMint API:
 * the returned transaction is signed LOCALLY and submitted through the
 * toolkit's own RPC/Jito path — private keys never leave the machine.
 * @module
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  MOONIT_DEX_FEE,
  MOONIT_HELIO_FEE,
  PROGRAMS,
  pk,
} from './constants.js';
import { anchorDiscriminator, findPda, u64, u8 } from './encoding.js';

export const MOONIT_PROGRAM_ID = PROGRAMS.MOONIT;

/** Curve account PDA: seeds ["token", mint]. */
export function moonitCurvePda(mint: string): PublicKey {
  return findPda(['token', pk(mint)], MOONIT_PROGRAM_ID);
}

/** Global config PDA: seeds ["config_account"]. */
export function moonitConfigPda(): PublicKey {
  return findPda(['config_account'], MOONIT_PROGRAM_ID);
}

/** Fixed side for trades: 0 = collateral fixed, 1 = token fixed. */
export enum MoonitFixedSide {
  Collateral = 0,
  Token = 1,
}

/** Trade params (anchor TradeParams). */
export interface MoonitTradeParams {
  tokenAmount: bigint;
  collateralAmount: bigint;
  fixedSide: MoonitFixedSide;
  slippageBps: bigint;
}

/** Decoded Moonit curve account (classic/flat curve core fields). */
export interface MoonitCurveAccount {
  discriminator: string;
  collateralCurrency: number;
  tokenSupply: bigint;
  collateralCollected: bigint;
  totalTokenSupply: bigint;
  migrationTarget: number;
  realTokenAmount: bigint;
  migrationQuoteAmount: bigint;
  migrated: boolean;
}

/**
 * Decodes the curve account. Layout (verified from moonit-sdk):
 * 8 disc + u8 collateral_currency + u8 curve_type + pad 6 + u64 token_supply
 * + u64 collateral_collected + u64 total_token_supply + u8 migration_target
 * + pad 7 + u64 real_token_amount + u64 migration_quote_amount + bool migrated.
 */
export function decodeMoonitCurve(data: Buffer): MoonitCurveAccount {
  let offset = 8;
  const collateralCurrency = data.readUInt8(offset);
  offset += 1;
  const curveType = data.readUInt8(offset);
  offset += 1 + 6; // curve_type + padding
  void curveType;
  const tokenSupply = data.readBigUInt64LE(offset);
  offset += 8;
  const collateralCollected = data.readBigUInt64LE(offset);
  offset += 8;
  const totalTokenSupply = data.readBigUInt64LE(offset);
  offset += 8;
  const migrationTarget = data.readUInt8(offset);
  offset += 1 + 7; // migration_target + padding
  const realTokenAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const migrationQuoteAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const migrated = data.readUInt8(offset) === 1;
  return {
    discriminator: data.subarray(0, 8).toString('hex'),
    collateralCurrency,
    tokenSupply,
    collateralCollected,
    totalTokenSupply,
    migrationTarget,
    realTokenAmount,
    migrationQuoteAmount,
    migrated,
  };
}

function tradeData(params: MoonitTradeParams): Buffer {
  return Buffer.concat([
    u64(params.tokenAmount),
    u64(params.collateralAmount),
    u8(params.fixedSide),
    u64(params.slippageBps),
  ]);
}

function meta(pubkey: PublicKey, writable = false, signer = false) {
  return { pubkey, isWritable: writable, isSigner: signer };
}

/**
 * Builds the Moonit `buy` instruction (11 accounts, verified IDL).
 * Sender token account = WSOL (collateral) ATA; curve token account = token
 * ATA owned by the curve PDA.
 */
export function moonitBuyInstruction(params: {
  sender: PublicKey;
  mint: PublicKey;
  trade: MoonitTradeParams;
}): TransactionInstruction {
  const curve = moonitCurvePda(params.mint.toBase58());
  const senderTokenAccount = getAssociatedTokenAddressSync(params.mint, params.sender, true);
  const curveTokenAccount = getAssociatedTokenAddressSync(params.mint, curve, true);
  return new TransactionInstruction({
    programId: pk(MOONIT_PROGRAM_ID),
    keys: [
      meta(params.sender, true, true), // sender
      meta(senderTokenAccount, true), // sender_token_account
      meta(curve, true), // curve_account
      meta(curveTokenAccount, true), // curve_token_account
      meta(pk(MOONIT_DEX_FEE), true), // dex_fee
      meta(pk(MOONIT_HELIO_FEE), true), // helio_fee
      meta(params.mint), // mint
      meta(moonitConfigPda()), // config_account
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(SystemProgram.programId), // system_program
    ],
    data: Buffer.concat([anchorDiscriminator('buy'), tradeData(params.trade)]),
  });
}

/**
 * Builds the Moonit `sell` instruction (same account layout as buy).
 */
export function moonitSellInstruction(params: {
  sender: PublicKey;
  mint: PublicKey;
  trade: MoonitTradeParams;
}): TransactionInstruction {
  const curve = moonitCurvePda(params.mint.toBase58());
  const senderTokenAccount = getAssociatedTokenAddressSync(params.mint, params.sender, true);
  const curveTokenAccount = getAssociatedTokenAddressSync(params.mint, curve, true);
  return new TransactionInstruction({
    programId: pk(MOONIT_PROGRAM_ID),
    keys: [
      meta(params.sender, true, true), // sender
      meta(senderTokenAccount, true), // sender_token_account
      meta(curve, true), // curve_account
      meta(curveTokenAccount, true), // curve_token_account
      meta(pk(MOONIT_DEX_FEE), true), // dex_fee
      meta(pk(MOONIT_HELIO_FEE), true), // helio_fee
      meta(params.mint), // mint
      meta(moonitConfigPda()), // config_account
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(SystemProgram.programId), // system_program
    ],
    data: Buffer.concat([anchorDiscriminator('sell'), tradeData(params.trade)]),
  });
}

// ---------------------------------------------------------------------------
// Curve math (classic constant-product curve — matches moon.it docs)
// ---------------------------------------------------------------------------

/** Classic curve initial virtual reserves (official docs). */
export const MOONIT_INITIAL_VIRTUAL_TOKENS = 1_073_000_000_000_000_000n / 1_000_000_000n; // raw units of a 9-decimals supply scaled here for docs
export const MOONIT_INITIAL_VIRTUAL_SOL = 30_000_000_000n; // 30 SOL in lamports

/**
 * Constant-product price quote: tokenAmountOut for `collateralLamports` given
 * the current curve position (supply still on curve + collateral collected).
 * Mirrors moon.it's vTOKEN × vSOL = k with virtual reserves.
 */
export function moonitQuoteBuyTokensOut(params: {
  curve: MoonitCurveAccount;
  collateralLamports: bigint;
}): bigint {
  // vTOKEN = tokens still on curve; vSOL = 30 SOL virtual + collateral collected.
  const vToken = params.curve.tokenSupply;
  const vSol = MOONIT_INITIAL_VIRTUAL_SOL + params.curve.collateralCollected;
  if (vToken <= 0n || vSol <= 0n) throw new Error('curve not initialized');
  // out = vToken - (vToken * vSol) / (vSol + in)
  const numerator = vToken * vSol;
  const denominator = vSol + params.collateralLamports;
  return vToken - numerator / denominator;
}

/**
 * Sell quote: lamports out for `tokenAmountIn`.
 */
export function moonitQuoteSellLamportsOut(params: {
  curve: MoonitCurveAccount;
  tokenAmountIn: bigint;
}): bigint {
  const vToken = params.curve.tokenSupply;
  const vSol = MOONIT_INITIAL_VIRTUAL_SOL + params.curve.collateralCollected;
  // out = vSol - (vToken*vSol)/(vToken + in)
  const numerator = vToken * vSol;
  const denominator = vToken + params.tokenAmountIn;
  return vSol - numerator / denominator;
}
