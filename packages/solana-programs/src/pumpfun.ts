/**
 * Pump.fun bonding curve program (official public docs / IDL verified).
 *
 * Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (mainnet + devnet).
 * Implements the current legacy `create` / `buy` / `sell` instruction layouts
 * (including creator-vault and fee-config accounts), creator-fee collection,
 * permissionless migration to PumpSwap, bonding-curve account decoding and
 * constant-product pricing math.
 * @module
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PROGRAMS,
  PUMPFUN_FEE_RECIPIENTS,
  PUMPSWAP_GLOBAL_CONFIG,
  WSOL_MINT,
  pk,
} from './constants.js';
import {
  anchorDiscriminator,
  borshString,
  findPda,
  pubKey,
  pumpOptionBool,
  u64,
} from './encoding.js';

const PUMP = PROGRAMS.PUMPFUN;
export const PUMP_PROGRAM_ID = PUMP;
export const PUMP_AMM_PROGRAM_ID = PROGRAMS.PUMPSWAP;
export const PUMP_FEES_PROGRAM_ID = PROGRAMS.PUMPFUN_FEES;
export const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhMoASNFJRrDh1uudaQUkuoZ4D';

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

export function pumpGlobalPda(): PublicKey {
  return findPda(['global'], PUMP);
}

export function pumpBondingCurvePda(mint: string): PublicKey {
  return findPda(['bonding-curve', pk(mint)], PUMP);
}

export function pumpEventAuthorityPda(): PublicKey {
  return findPda(['__event_authority'], PUMP);
}

export function pumpCreatorVaultPda(creator: string): PublicKey {
  return findPda(['creator-vault', pk(creator)], PUMP);
}

export function pumpUserVolumeAccumulatorPda(user: string): PublicKey {
  return findPda(['user_volume_accumulator', pk(user)], PUMP);
}

export function pumpGlobalVolumeAccumulatorPda(): PublicKey {
  return findPda(['global_volume_accumulator'], PUMP);
}

export function pumpFeeConfigPda(): PublicKey {
  return findPda(['fee_config', pk(PUMP)], PUMP_FEES_PROGRAM_ID);
}

/** PumpSwap pool PDA: ["pool", index u16 LE, creator, baseMint, quoteMint]. */
export function pumpAmmPoolPda(params: {
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
}): PublicKey {
  const seeds = Buffer.alloc(2);
  seeds.writeUInt16LE(params.index, 0);
  return findPda([seeds, pk(params.creator), pk(params.baseMint), pk(params.quoteMint)], PUMP_AMM_PROGRAM_ID);
}

export function pumpAmmPoolAuthorityPda(pool: PublicKey): PublicKey {
  return findPda(['pool_authority', pool], PUMP_AMM_PROGRAM_ID);
}

export function pumpAmmLpMintPda(pool: PublicKey): PublicKey {
  return findPda(['pool_lp_mint', pool], PUMP_AMM_PROGRAM_ID);
}

export function pumpAmmEventAuthorityPda(): PublicKey {
  return findPda(['__event_authority'], PUMP_AMM_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// Account decoding
// ---------------------------------------------------------------------------

/** Decoded Pump.fun bonding curve account. */
export interface BondingCurveAccount {
  discriminator: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
}

/** Decodes the bonding curve account (8-byte anchor discriminator + struct). */
export function decodeBondingCurve(data: Buffer): BondingCurveAccount {
  let offset = 8; // anchor account discriminator
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) === 1;
  offset += 1;
  const creator = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    discriminator: data.subarray(0, 8).toString('hex'),
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
  };
}

/** Decoded subset of the Pump.fun Global account. */
export interface PumpGlobalAccount {
  authority: string;
  feeRecipient: string;
  withdrawAuthority: string;
  feeBasisPoints: bigint;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
}

/**
 * Decodes the Pump.fun Global account (only the fields used by the toolkit).
 * Layout: 8 disc, initialized bool, authority, fee_recipient,
 * 4 × u64 (initial reserves, supply), fee_basis_points, withdraw_authority, …
 */
export function decodePumpGlobal(data: Buffer): PumpGlobalAccount {
  const authority = new PublicKey(data.subarray(9, 41)).toBase58();
  const feeRecipient = new PublicKey(data.subarray(41, 73)).toBase58();
  const initialVirtualTokenReserves = data.readBigUInt64LE(73);
  const initialVirtualSolReserves = data.readBigUInt64LE(81);
  const feeBasisPoints = data.readBigUInt64LE(105);
  const withdrawAuthority = new PublicKey(data.subarray(113, 145)).toBase58();
  return {
    authority,
    feeRecipient,
    withdrawAuthority,
    feeBasisPoints,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
  };
}

// ---------------------------------------------------------------------------
// Pricing math (constant product with virtual reserves)
// ---------------------------------------------------------------------------

/**
 * Quote for a buy: lamports the buyer must spend for an exact token amount
 * out (before the protocol fee, which the program takes from the SOL side).
 */
export function quoteBuyLamportsIn(curve: BondingCurveAccount, tokenAmountOut: bigint): bigint {
  const { virtualTokenReserves: vt, virtualSolReserves: vs } = curve;
  if (tokenAmountOut <= 0n) throw new Error('token amount must be > 0');
  if (tokenAmountOut >= curve.realTokenReserves) throw new Error('amount exceeds curve reserves');
  const numerator = vs * (vt - tokenAmountOut);
  const denominator = tokenAmountOut;
  const vsImplied = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  return vsImplied - vs;
}

/** Quote for a sell: lamports out for an exact token amount in (before fee). */
export function quoteSellLamportsOut(curve: BondingCurveAccount, tokenAmountIn: bigint): bigint {
  const { virtualTokenReserves: vt, virtualSolReserves: vs } = curve;
  if (tokenAmountIn <= 0n) throw new Error('token amount must be > 0');
  const numerator = vs * vt;
  const denominator = vt + tokenAmountIn;
  return vs - numerator / denominator;
}

// ---------------------------------------------------------------------------
// Instruction builders (legacy SOL-paired layout — current as of 2026-09)
// ---------------------------------------------------------------------------

function meta(pubkey: PublicKey, writable = false, signer = false) {
  return { pubkey, isWritable: writable, isSigner: signer };
}

/** Picks one of the 8 normal fee recipients at random (per official docs). */
export function randomFeeRecipient(): PublicKey {
  const list = [...PUMPFUN_FEE_RECIPIENTS];
  return pk(list[Math.floor(Math.random() * list.length)]!);
}

/**
 * Builds the Pump.fun `create` instruction (launch a new coin).
 * The mint keypair must sign the transaction.
 */
export function pumpCreateInstruction(params: {
  user: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
}): TransactionInstruction {
  const bondingCurve = pumpBondingCurvePda(params.mint.toBase58());
  const associatedBondingCurve = getAssociatedTokenAddressSync(params.mint, bondingCurve, true);
  const metadata = findPda(
    ['metadata', pk(PROGRAMS.METAPLEX_TOKEN_METADATA), params.mint],
    PROGRAMS.METAPLEX_TOKEN_METADATA,
  );
  const data = Buffer.concat([
    anchorDiscriminator('create'),
    borshString(params.name),
    borshString(params.symbol),
    borshString(params.uri),
    pubKey(params.creator),
  ]);
  return new TransactionInstruction({
    programId: pk(PUMP),
    keys: [
      meta(params.mint, true, true), // mint
      meta(params.mint), // mint_authority (program PDA, verified on-chain)
      meta(bondingCurve, true), // bonding_curve
      meta(associatedBondingCurve, true), // associated_bonding_curve
      meta(pumpGlobalPda()), // global
      meta(pk(PROGRAMS.METAPLEX_TOKEN_METADATA)), // mpl_token_metadata
      meta(metadata, true), // metadata
      meta(params.user, true, true), // user
      meta(SystemProgram.programId), // system_program
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(pk(SYSVAR_RENT)), // rent
      meta(pumpEventAuthorityPda()), // event_authority
      meta(pk(PUMP)), // program
    ],
    data,
  });
}

/**
 * Builds the Pump.fun `buy` instruction (legacy SOL-paired layout, 16
 * accounts). `curveCreator` comes from the decoded bonding curve account —
 * services must fetch it before quoting/buying.
 */
export function pumpBuyInstruction(params: {
  user: PublicKey;
  mint: PublicKey;
  curveCreator: string;
  amount: bigint;
  maxSolCost: bigint;
  feeRecipient?: PublicKey;
  trackVolume?: boolean;
}): TransactionInstruction {
  const mint = params.mint;
  const bondingCurve = pumpBondingCurvePda(mint.toBase58());
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, params.user, true);
  const feeRecipient = params.feeRecipient ?? randomFeeRecipient();

  const data = Buffer.concat([
    anchorDiscriminator('buy'),
    u64(params.amount),
    u64(params.maxSolCost),
    pumpOptionBool(params.trackVolume ?? true),
  ]);

  return new TransactionInstruction({
    programId: pk(PUMP),
    keys: [
      meta(pumpGlobalPda()), // global
      meta(feeRecipient, true), // fee_recipient
      meta(mint), // mint
      meta(bondingCurve, true), // bonding_curve
      meta(associatedBondingCurve, true), // associated_bonding_curve
      meta(associatedUser, true), // associated_user
      meta(params.user, true, true), // user
      meta(SystemProgram.programId), // system_program
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(pumpCreatorVaultPda(params.curveCreator), true), // creator_vault
      meta(pumpEventAuthorityPda()), // event_authority
      meta(pk(PUMP)), // program
      meta(pumpGlobalVolumeAccumulatorPda()), // global_volume_accumulator
      meta(pumpUserVolumeAccumulatorPda(params.user.toBase58()), true), // user_volume_accumulator
      meta(pumpFeeConfigPda()), // fee_config
      meta(pk(PUMP_FEES_PROGRAM_ID)), // fee_program
    ],
    data,
  });
}

/**
 * Builds the Pump.fun `sell` instruction (legacy SOL-paired layout, 14
 * accounts).
 */
export function pumpSellInstruction(params: {
  user: PublicKey;
  mint: PublicKey;
  curveCreator: string;
  amount: bigint;
  minSolOutput: bigint;
  feeRecipient?: PublicKey;
}): TransactionInstruction {
  const mint = params.mint;
  const bondingCurve = pumpBondingCurvePda(mint.toBase58());
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, params.user, true);
  const feeRecipient = params.feeRecipient ?? randomFeeRecipient();

  const data = Buffer.concat([
    anchorDiscriminator('sell'),
    u64(params.amount),
    u64(params.minSolOutput),
  ]);

  return new TransactionInstruction({
    programId: pk(PUMP),
    keys: [
      meta(pumpGlobalPda()), // global
      meta(feeRecipient, true), // fee_recipient
      meta(mint), // mint
      meta(bondingCurve, true), // bonding_curve
      meta(associatedBondingCurve, true), // associated_bonding_curve
      meta(associatedUser, true), // associated_user
      meta(params.user, true, true), // user
      meta(SystemProgram.programId), // system_program
      meta(pumpCreatorVaultPda(params.curveCreator), true), // creator_vault
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(pumpEventAuthorityPda()), // event_authority
      meta(pk(PUMP)), // program
      meta(pumpFeeConfigPda()), // fee_config
      meta(pk(PUMP_FEES_PROGRAM_ID)), // fee_program
    ],
    data,
  });
}

/**
 * Builds `collect_creator_fee` — withdraw accumulated creator fees from a
 * creator vault (safe to call per wallet in batch).
 */
export function pumpCollectCreatorFeeInstruction(params: {
  creator: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: pk(PUMP),
    keys: [
      meta(params.creator, true), // creator
      meta(pumpCreatorVaultPda(params.creator.toBase58()), true), // creator_vault
      meta(SystemProgram.programId), // system_program
      meta(pumpEventAuthorityPda()), // event_authority
      meta(pk(PUMP)), // program
    ],
    data: anchorDiscriminator('collect_creator_fee'),
  });
}

/**
 * Builds the permissionless `migrate` instruction — migrates a completed
 * bonding curve to PumpSwap. Anyone may migrate a completed curve; the pool
 * creator equals the coin creator, index 0 for migrated pools.
 * `withdrawAuthority` must be decoded from the on-chain global account.
 */
export function pumpMigrateInstruction(params: {
  user: PublicKey;
  mint: PublicKey;
  curveCreator: string;
  withdrawAuthority: PublicKey;
  poolIndex?: number;
}): TransactionInstruction {
  const mint = params.mint;
  const bondingCurve = pumpBondingCurvePda(mint.toBase58());
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const pool = pumpAmmPoolPda({
    index: params.poolIndex ?? 0,
    creator: params.curveCreator,
    baseMint: mint.toBase58(),
    quoteMint: WSOL_MINT,
  });
  const poolAuthority = pumpAmmPoolAuthorityPda(pool);
  const lpMint = pumpAmmLpMintPda(pool);

  return new TransactionInstruction({
    programId: pk(PUMP),
    keys: [
      meta(pumpGlobalPda()), // global
      meta(params.withdrawAuthority, true), // withdraw_authority
      meta(mint), // mint
      meta(bondingCurve, true), // bonding_curve
      meta(associatedBondingCurve, true), // associated_bonding_curve
      meta(params.user, true, true), // user
      meta(SystemProgram.programId), // system_program
      meta(TOKEN_PROGRAM_ID), // token_program
      meta(pk(PUMP_AMM_PROGRAM_ID)), // pump_amm
      meta(pool, true), // pool
      meta(poolAuthority, true), // pool_authority
      meta(getAssociatedTokenAddressSync(mint, poolAuthority, true, TOKEN_PROGRAM_ID), true), // pool_authority_mint_account
      meta(getAssociatedTokenAddressSync(pk(WSOL_MINT), poolAuthority, true, TOKEN_PROGRAM_ID), true), // pool_authority_wsol_account
      meta(pk(PUMPSWAP_GLOBAL_CONFIG)), // amm_global_config
      meta(pk(WSOL_MINT)), // wsol_mint
      meta(lpMint, true), // lp_mint
      meta(getAssociatedTokenAddressSync(lpMint, params.user, true, pk(TOKEN_2022)), true), // user_pool_token_account
      meta(getAssociatedTokenAddressSync(mint, pool, true, TOKEN_PROGRAM_ID), true), // pool_base_token_account
      meta(getAssociatedTokenAddressSync(pk(WSOL_MINT), pool, true, TOKEN_PROGRAM_ID), true), // pool_quote_token_account
      meta(pk(TOKEN_2022)), // token_2022_program
      meta(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      meta(pumpAmmEventAuthorityPda()), // pump_amm_event_authority
      meta(pumpEventAuthorityPda()), // event_authority
      meta(pk(PUMP)), // program
      meta(pk(SYSVAR_RENT)), // rent
    ],
    data: anchorDiscriminator('migrate'),
  });
}

export { TOKEN_PROGRAM_ID };
