/**
 * Shared helpers for venue adapters: Anchor discriminators, little-endian
 * codecs, ATA/PDA derivation, WSOL wrap/unwrap instruction sequences, and
 * constant-product swap math used by every quote function.
 * @module
 */

import { createHash } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';

/** Wrapped SOL mint — the quote mint for virtually every venue here. */
export const WSOL_MINT = NATIVE_MINT;

/**
 * Anchor instruction discriminator: first 8 bytes of sha256("global:<name>").
 * Verified in tests against known on-chain values.
 */
export function anchorIxDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor account discriminator: first 8 bytes of sha256("account:<name>"). */
export function anchorAccountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

/** Encodes a u64 as 8 little-endian bytes. */
export function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

/** Reads a u64 little-endian at `offset`. */
export function readU64(data: Buffer | Uint8Array, offset: number): bigint {
  return Buffer.from(data).readBigUInt64LE(offset);
}

/** Reads a 32-byte public key at `offset`. */
export function readPubkey(data: Buffer | Uint8Array, offset: number): PublicKey {
  return new PublicKey(Buffer.from(data).subarray(offset, offset + 32));
}

/** SPL Token account balance (amount field is a u64 at byte offset 64). */
export function tokenAmountFromAccountData(data: Buffer | Uint8Array): bigint {
  if (data.length < 72) throw new Error(`token account data too short: ${data.length}`);
  return readU64(data, 64);
}

/** SPL Token account owner (at byte offset 32). */
export function tokenOwnerFromAccountData(data: Buffer | Uint8Array): PublicKey {
  return readPubkey(data, 32);
}

/** Associated token address with an explicit token program. */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** Idempotent "create associated token account" instruction (no-op if it exists). */
export function ensureAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata(owner, mint, tokenProgram),
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Instructions that make `lamports` of SOL available as WSOL in the user's
 * ATA: create-idempotent + transfer + syncNative.
 */
export function wrapSolIxs(payer: PublicKey, user: PublicKey, lamports: bigint): TransactionInstruction[] {
  const wsolAta = ata(user, WSOL_MINT, TOKEN_PROGRAM_ID);
  return [
    ensureAtaIx(payer, user, WSOL_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
  ];
}

/** Closes the user's WSOL ATA, returning rent + balance as native SOL. */
export function unwrapSolIx(user: PublicKey): TransactionInstruction {
  return createCloseAccountInstruction(ata(user, WSOL_MINT, TOKEN_PROGRAM_ID), user, user, [], TOKEN_PROGRAM_ID);
}

/** Picks the token program for a mint given its owner program id. */
export function tokenProgramForMintOwner(mintOwner: string): PublicKey {
  return mintOwner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Constant-product output for `amountIn` into reserves (in, out) after a fee
 * taken on the input. All integer math; returns 0 on degenerate reserves.
 */
export function constantProductOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const net = (amountIn * (10_000n - feeBps)) / 10_000n;
  return (net * reserveOut) / (reserveIn + net);
}

/**
 * Inverse of {@link constantProductOut}: input needed to receive exactly
 * `amountOut`. Used to price exact-out buys.
 */
export function constantProductIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (amountOut <= 0n || reserveOut <= amountOut || reserveIn <= 0n) return 0n;
  // Gross input (before fee) satisfying out = netIn*Rout/(Rin+netIn):
  //   netIn = out*Rin/(Rout-out)
  const net = (amountOut * reserveIn) / (reserveOut - amountOut) + 1n;
  return (net * 10_000n) / (10_000n - feeBps) + 1n;
}

/** Fetches an account's raw data or returns null when missing. */
export async function fetchAccountData(rpc: SolanaRpcClient, address: PublicKey): Promise<Buffer | null> {
  const info = await rpc.accountInfo(address.toBase58());
  return info ? Buffer.from(info.data as Uint8Array) : null;
}

/** Fetches the SPL token `amount` of a token account, 0 when missing. */
export async function fetchTokenAmount(rpc: SolanaRpcClient, tokenAccount: PublicKey): Promise<bigint> {
  const data = await fetchAccountData(rpc, tokenAccount);
  return data ? tokenAmountFromAccountData(data) : 0n;
}
