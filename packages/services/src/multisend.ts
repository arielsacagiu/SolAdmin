/**
 * Token MultiSender, NFT MultiSender, and Multiple-to-Multiple transfers.
 *
 * All modes share the same batching engine: destination ATAs are created
 * inside the same transaction, transfers are chunked to stay under the
 * 1232-byte packet limit, and every batch is simulated pre-flight.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { SendOutcome } from '@solana-toolkit/types';
import { chunk, moduleLogger } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';

const log = moduleLogger('multisend');

export interface MultiSendRecipient {
  address: string;
  /** Raw token amount per recipient. */
  amountRaw: bigint;
}

export interface MultiSendOptions {
  token: Keypair;
  mint: string;
  recipients: MultiSendRecipient[];
  /** Transfers per transaction (max ~20 with ATA creation; 12 is safe). */
  perTx?: number;
  mode?: 'simulate' | 'execute';
  /** Force Token-2022 (auto-detected otherwise). */
  tokenProgram?: PublicKey;
}

export interface MultiSendReport {
  outcomes: SendOutcome[];
  recipientCount: number;
  txCount: number;
  simulated: boolean;
  failures: string[];
}

/**
 * Sends a fungible token to many recipients. Returns one outcome per batch.
 */
export async function tokenMultiSend(ctx: ServiceContext, opts: MultiSendOptions): Promise<MultiSendReport> {
  const mintPk = new PublicKey(opts.mint);
  const tokenProgram = opts.tokenProgram ?? (await detectTokenProgram(ctx, opts.mint));
  const perTx = opts.perTx ?? 12;
  const groups = chunk(opts.recipients, perTx);
  const report: MultiSendReport = {
    outcomes: [],
    recipientCount: opts.recipients.length,
    txCount: groups.length,
    simulated: (opts.mode ?? ctx.sender.effectiveMode()) === 'simulate',
    failures: [],
  };

  for (const [gi, group] of groups.entries()) {
    const instructions: TransactionInstruction[] = [];
    for (const r of group) {
      const dest = new PublicKey(r.address);
      const destAta = getAssociatedTokenAddressSync(mintPk, dest, true, tokenProgram);
      const sourceAta = getAssociatedTokenAddressSync(mintPk, opts.token.publicKey, true, tokenProgram);
      instructions.push(
        createAssociatedTokenAccountInstruction(opts.token.publicKey, destAta, dest, mintPk, tokenProgram),
        createTransferInstruction(sourceAta, destAta, opts.token.publicKey, r.amountRaw, [], tokenProgram),
      );
    }
    try {
      const outcome = await ctx.sender.send(
        {
          description: `multisend batch ${gi + 1}/${groups.length} (${group.length} recipients)`,
          feePayer: opts.token.publicKey.toBase58(),
          instructions,
          signers: [opts.token],
        },
        { mode: opts.mode, priorityFee: { computeUnitLimit: 400_000, microLamportsPerCu: 200_000 } },
      );
      report.outcomes.push(outcome);
    } catch (err) {
      report.failures.push(String(err));
      log.error({ err, batch: gi + 1 }, 'multisend batch failed');
    }
  }
  return report;
}

/**
 * NFT MultiSender: transfers NFTs (each a 1-supply mint) from a holder wallet
 * to many recipients — one transfer per (mint, recipient) pair.
 */
export async function nftMultiSend(
  ctx: ServiceContext,
  params: {
    holder: Keypair;
    /** List of NFT mints with the destination for each. */
    sends: { mint: string; to: string }[];
    mode?: 'simulate' | 'execute';
  },
): Promise<MultiSendReport> {
  const sends = params.sends.map((s) => ({
    mint: s.mint,
    to: s.to,
    tokenProgram: TOKEN_PROGRAM_ID as PublicKey,
  }));
  const report: MultiSendReport = {
    outcomes: [],
    recipientCount: sends.length,
    txCount: Math.ceil(sends.length / 8),
    simulated: (params.mode ?? ctx.sender.effectiveMode()) === 'simulate',
    failures: [],
  };
  const groups = chunk(sends, 8);
  for (const [gi, group] of groups.entries()) {
    const instructions: TransactionInstruction[] = [];
    for (const s of group) {
      const mintPk = new PublicKey(s.mint);
      const dest = new PublicKey(s.to);
      const destAta = getAssociatedTokenAddressSync(mintPk, dest, true, TOKEN_PROGRAM_ID);
      const sourceAta = getAssociatedTokenAddressSync(mintPk, params.holder.publicKey, true, TOKEN_PROGRAM_ID);
      instructions.push(
        createAssociatedTokenAccountInstruction(params.holder.publicKey, destAta, dest, mintPk, TOKEN_PROGRAM_ID),
        createTransferInstruction(sourceAta, destAta, params.holder.publicKey, 1n, [], TOKEN_PROGRAM_ID),
      );
    }
    try {
      const outcome = await ctx.sender.send(
        {
          description: `nft multisend batch ${gi + 1}/${groups.length}`,
          feePayer: params.holder.publicKey.toBase58(),
          instructions,
          signers: [params.holder],
        },
        { mode: params.mode, priorityFee: { computeUnitLimit: 400_000, microLamportsPerCu: 200_000 } },
      );
      report.outcomes.push(outcome);
    } catch (err) {
      report.failures.push(String(err));
    }
  }
  return report;
}

/**
 * Multiple-to-Multiple Transfer: each source wallet sends its own amount to
 * the paired destination (N:N). All wallets must be provided as keypairs.
 */
export async function multiToMultiTransfer(
  ctx: ServiceContext,
  params: {
    pairs: { from: Keypair; to: string; amountRaw: bigint }[];
    mint: string;
    mode?: 'simulate' | 'execute';
  },
): Promise<MultiSendReport> {
  const tokenProgram = await detectTokenProgram(ctx, params.mint);
  const mintPk = new PublicKey(params.mint);
  const report: MultiSendReport = {
    outcomes: [],
    recipientCount: params.pairs.length,
    txCount: params.pairs.length,
    simulated: (params.mode ?? ctx.sender.effectiveMode()) === 'simulate',
    failures: [],
  };
  for (const pair of params.pairs) {
    const dest = new PublicKey(pair.to);
    const destAta = getAssociatedTokenAddressSync(mintPk, dest, true, tokenProgram);
    const sourceAta = getAssociatedTokenAddressSync(mintPk, pair.from.publicKey, true, tokenProgram);
    try {
      const outcome = await ctx.sender.send(
        {
          description: `m2m transfer ${pair.from.publicKey.toBase58().slice(0, 6)}→${dest.toBase58().slice(0, 6)}`,
          feePayer: pair.from.publicKey.toBase58(),
          instructions: [
            createAssociatedTokenAccountInstruction(pair.from.publicKey, destAta, dest, mintPk, tokenProgram),
            createTransferInstruction(sourceAta, destAta, pair.from.publicKey, pair.amountRaw, [], tokenProgram),
          ],
          signers: [pair.from],
        },
        { mode: params.mode },
      );
      report.outcomes.push(outcome);
    } catch (err) {
      report.failures.push(String(err));
    }
  }
  return report;
}

async function detectTokenProgram(ctx: ServiceContext, mint: string): Promise<PublicKey> {
  const info = await ctx.rpc.accountInfo(mint);
  if (!info) throw new Error(`mint ${mint} not found`);
  const owner = info.owner.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}
