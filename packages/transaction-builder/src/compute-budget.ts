/**
 * Compute budget instructions and Jito tip helpers.
 * @module
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import type { PriorityFeeConfig } from '@solana-toolkit/types';
import { moduleLogger, securePick } from '@solana-toolkit/utils';
import { JITO_TIP_ACCOUNTS_FALLBACK } from '@solana-toolkit/rpc-client';

const log = moduleLogger('compute-budget');

/** Default CU limit when nothing else is known. */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

/**
 * Builds the standard compute-budget instruction pair:
 * `setComputeUnitLimit` + `setComputeUnitPrice` from a config.
 */
export function computeBudgetInstructions(cfg: PriorityFeeConfig, simulatedCu?: number): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  const cuLimit = cfg.computeUnitLimit ?? (simulatedCu ? Math.ceil(simulatedCu * 1.2) : DEFAULT_COMPUTE_UNIT_LIMIT);
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  const price = cfg.microLamportsPerCu ?? 200_000;
  ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  log.debug({ cuLimit, price }, 'compute budget set');
  return ixs;
}

/**
 * Builds a SOL transfer instruction paying a Jito tip. Select the tip account
 * at random to reduce contention (per Jito documentation).
 */
export function jitoTipInstruction(payer: PublicKey, tipLamports: bigint, tipAccount?: string): TransactionInstruction {
  const tips = [...JITO_TIP_ACCOUNTS_FALLBACK];
  const target = tipAccount ?? securePick(tips);
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(target),
    lamports: tipLamports,
  });
}

// ---------------------------------------------------------------------------
// Jito DontFront anti-frontrun marker
// ---------------------------------------------------------------------------

/**
 * A valid Solana address whose base58 prefix is `jitodontfront`. Adding it as
 * a read-only, non-signer account to any instruction tells the Jito block
 * engine that the transaction must land at bundle index 0 — no searcher can
 * place a front-run transaction before it (Jito "DontFront" feature,
 * docs.solana.com / docs.jito.wtf). The account does not need to exist
 * on-chain and is never read or written.
 */
export const DONTFRONT_MARKER_ADDRESS =
  'jitodontfront111111111111111111111111111111';

/**
 * Returns a copy of `ix` with the DontFront marker appended as a read-only,
 * non-signer account. Most programs (including the System Program) ignore
 * extra accounts, so this is safe to attach to any instruction.
 *
 * Rules enforced by the block engine once a tx carries the marker:
 *   - via sendBundle the tx MUST be at index 0 of the bundle (else rejected);
 *   - via sendTransaction no other bundle may place transactions before it;
 *   - multiple marker txs in one bundle must be contiguous at the front and
 *     share at least one signer with the first marker transaction.
 */
export function withDontFrontMarker<T extends { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }>(ix: T): T {
  const marker = new PublicKey(DONTFRONT_MARKER_ADDRESS);
  const already = ix.keys.some((k) => k.pubkey.equals(marker));
  if (already) return ix;
  return {
    ...ix,
    keys: [...ix.keys, { pubkey: marker, isSigner: false, isWritable: false }],
  };
}

/** Verified executable SPL Memo program on mainnet — a no-op program that
 * logs its data and tolerates arbitrary accounts, making it a safe carrier
 * for extra marker accounts. */
export const SPL_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * A standalone no-op instruction that carries the DontFront marker account.
 * Use this instead of mutating a venue's swap instruction when the venue
 * program may validate its account list strictly (e.g. aggregators): the
 * memo program ignores accounts entirely, so the marker rides safely.
 * The marker still forces the whole transaction to bundle index 0.
 */
export function dontFrontMarkerInstruction(): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(SPL_MEMO_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(DONTFRONT_MARKER_ADDRESS), isSigner: false, isWritable: false },
    ],
    data: Buffer.from('soladmin-dontfront', 'utf8'),
  });
}
