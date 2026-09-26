/**
 * Transaction assembly: instructions → fee-payer → compute budget → signed
 * VersionedTransaction. Every on-chain operation in the toolkit produces
 * transactions through this builder so priority-fee policy, tipping and
 * signing are uniform and auditable.
 * @module
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type BlockhashWithExpiryBlockHeight,
  type Keypair,
  type Signer,
} from '@solana/web3.js';
import type { PriorityFeeConfig, PreparedTransaction, SignedTransaction } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { computeBudgetInstructions, jitoTipInstruction } from './compute-budget.js';

const log = moduleLogger('tx-builder');

export interface BuildTransactionParams {
  /** Human-readable description used in logs. */
  description: string;
  /** Fee payer. Must also sign unless `payerIsSigner` is false (rare). */
  feePayer: PublicKey | string;
  /** Core instructions (business logic). */
  instructions: TransactionInstruction[];
  /** Compute budget + tip configuration. */
  priorityFee: PriorityFeeConfig;
  /** Jito tip in lamports; when > 0 a tip instruction is appended. */
  jitoTipLamports?: bigint;
  /** Signers, including the fee payer and any extra keypairs. */
  signers: Signer[];
  /** Blockhash (recent). */
  blockhash: BlockhashWithExpiryBlockHeight;
  /** Simulated CU consumption to size the CU limit. */
  simulatedCu?: number;
  /** Prepend (true, default) or append compute budget instructions. */
  computeBudgetFirst?: boolean;
  /** Address lookup tables required by the message (e.g. Jupiter routes). */
  lookupTables?: AddressLookupTableAccount[];
}

function pk(value: PublicKey | string): PublicKey {
  return typeof value === 'string' ? new PublicKey(value) : value;
}

/**
 * Assembles and signs a versioned transaction.
 *
 * The build order is:
 *   1. setComputeUnitLimit / setComputeUnitPrice
 *   2. user instructions
 *   3. Jito tip transfer (last, so it is conditionally executed with the tx)
 */
export function buildSignedTransaction(params: BuildTransactionParams): SignedTransaction {
  const payer = pk(params.feePayer);
  const budget = computeBudgetInstructions(params.priorityFee, params.simulatedCu);
  const core = params.instructions.filter((ix) => ix.programId !== ComputeBudgetProgram.programId);
  const tip =
    params.jitoTipLamports && params.jitoTipLamports > 0n
      ? [jitoTipInstruction(payer, params.jitoTipLamports)]
      : [];

  const instructions = [...budget, ...core, ...tip];

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: params.blockhash.blockhash,
    instructions,
  }).compileToV0Message(params.lookupTables);

  const vtx = new VersionedTransaction(message);
  vtx.sign(params.signers);

  const bytes = vtx.serialize();
  const signature = Buffer.from(vtx.signatures[0]!).toString('base64');
  log.debug(
    {
      description: params.description,
      instructions: instructions.length,
      feePayer: payer.toBase58(),
      jitoTip: params.jitoTipLamports?.toString(),
    },
    'transaction signed',
  );

  const prepared: PreparedTransaction = {
    compiledMessage: Buffer.from(message.serialize()),
    instructionCount: instructions.length,
    feePayer: payer.toBase58(),
    description: params.description,
  };

  return {
    bytes,
    base64: Buffer.from(bytes).toString('base64'),
    signature,
    description: params.description,
    // attached for beforeSend hooks
    ...( { prepared } as Record<string, unknown>),
  } as SignedTransaction & { prepared: PreparedTransaction };
}

/**
 * Compiles (without signing) so the caller can inspect the message.
 */
export function prepareUnsigned(params: Omit<BuildTransactionParams, 'signers'>): PreparedTransaction {
  const payer = pk(params.feePayer);
  const budget = computeBudgetInstructions(params.priorityFee, params.simulatedCu);
  const core = params.instructions.filter((ix) => ix.programId !== ComputeBudgetProgram.programId);
  const tip =
    params.jitoTipLamports && params.jitoTipLamports > 0n
      ? [jitoTipInstruction(payer, params.jitoTipLamports)]
      : [];
  const instructions = [...budget, ...core, ...tip];
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: params.blockhash.blockhash,
    instructions,
  }).compileToV0Message(params.lookupTables);
  return {
    compiledMessage: Buffer.from(message.serialize()),
    instructionCount: instructions.length,
    feePayer: payer.toBase58(),
    description: params.description,
  };
}

export type { Keypair };
