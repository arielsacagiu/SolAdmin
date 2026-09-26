/**
 * Token Batch Collection + Transfer All Assets (multi-wallet consolidation).
 *
 *  - `collectTokens`: sweeps a token from many source wallets into one
 *    destination (the classic "batch collection" tool).
 *  - `consolidateAllAssets`: per wallet — sweeps every token balance to SOL
 *    (optional), then sends ALL SOL minus a configurable keep-alive amount
 *    to the treasury. Closes empty token accounts to reclaim rent.
 * @module
 */

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { SendOutcome } from '@solana-toolkit/types';
import { chunk, moduleLogger } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';

const log = moduleLogger('collection');

export interface CollectOptions {
  sources: Keypair[];
  destination: string;
  mint: string;
  mode?: 'simulate' | 'execute';
  /** Also close empty source token accounts after sweeping (reclaims rent). */
  closeAccounts?: boolean;
}

export interface CollectReport {
  outcomes: SendOutcome[];
  collectedRaw: bigint;
  failures: string[];
}

/**
 * Collects a token from many wallets into a single destination ATA.
 */
export async function collectTokens(ctx: ServiceContext, opts: CollectOptions): Promise<CollectReport> {
  const mintPk = new PublicKey(opts.mint);
  const dest = new PublicKey(opts.destination);
  const destAta = getAssociatedTokenAddressSync(mintPk, dest, true);
  const report: CollectReport = { outcomes: [], collectedRaw: 0n, failures: [] };

  for (const source of opts.sources) {
    const sourceAta = getAssociatedTokenAddressSync(mintPk, source.publicKey, true);
    let balance = 0n;
    try {
      const bal = await ctx.rpc.connection.getTokenAccountBalance(sourceAta);
      balance = BigInt(bal.value.amount);
    } catch {
      continue; // no account for this wallet
    }
    if (balance === 0n) continue;

    const instructions: TransactionInstruction[] = [
      createTransferInstruction(sourceAta, destAta, source.publicKey, balance, []),
    ];
    if (opts.closeAccounts) {
      instructions.push(createCloseAccountInstruction(sourceAta, source.publicKey, source.publicKey));
    }
    try {
      const outcome = await ctx.sender.send(
        {
          description: `collect ${opts.mint} from ${source.publicKey.toBase58().slice(0, 6)}`,
          feePayer: source.publicKey.toBase58(),
          instructions,
          signers: [source],
        },
        { mode: opts.mode },
      );
      report.outcomes.push(outcome);
      report.collectedRaw += balance;
    } catch (err) {
      report.failures.push(String(err));
    }
  }
  log.info({ collected: report.collectedRaw.toString(), wallets: opts.sources.length }, 'collection done');
  return report;
}

export interface ConsolidateOptions {
  wallets: Keypair[];
  /** Destination SOL address. */
  destination: string;
  /** Swap remaining tokens to SOL before sweeping (uses the dex package). */
  swapTokensToSol?: boolean;
  /** SOL retained per wallet for future rent/fees (lamports). */
  leaveLamportsPerWallet?: bigint;
  mode?: 'simulate' | 'execute';
  slippageBps?: number;
}

export interface ConsolidateReport {
  outcomes: SendOutcome[];
  solTransferred: bigint;
  failures: string[];
}

/**
 * Transfer All Assets: full multi-wallet consolidation. Each wallet:
 *   1. (optional) swaps all non-SOL tokens to SOL,
 *   2. closes empty token accounts to reclaim rent,
 *   3. transfers all SOL minus the keep-alive amount to the destination.
 */
export async function consolidateAllAssets(
  ctx: ServiceContext,
  opts: ConsolidateOptions,
): Promise<ConsolidateReport> {
  const report: ConsolidateReport = { outcomes: [], solTransferred: 0n, failures: [] };
  const destination = new PublicKey(opts.destination);
  const leave = opts.leaveLamportsPerWallet ?? 0n;

  for (const wallet of opts.wallets) {
    try {
      if (opts.swapTokensToSol) {
        const { createDexContext } = await import('@solana-toolkit/dex');
        const { swapAllTokensInWallet } = await import('@solana-toolkit/dex');
        const dex = createDexContext(ctx.config);
        await swapAllTokensInWallet(dex, {
          wallet,
          slippageBps: opts.slippageBps ?? 500,
          mode: opts.mode,
        });
      }

      // Close all empty token accounts (rent reclamation).
      const accounts = await ctx.rpc.connection.getTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });
      const closeIxs = accounts.value
        .map(({ pubkey, account }) => {
          const bal = BigInt((account.data as unknown as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount);
          return bal === 0n
            ? createCloseAccountInstruction(pubkey, wallet.publicKey, wallet.publicKey)
            : null;
        })
        .filter((ix): ix is TransactionInstruction => ix !== null);

      const balance = await ctx.rpc.balance(wallet.publicKey.toBase58());
      const sendable = balance - leave - (closeIxs.length > 0 ? 0n : 0n);
      const instructions: TransactionInstruction[] = [...closeIxs];
      if (sendable > 0n) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: destination,
            lamports: sendable,
          }),
        );
      }
      if (instructions.length === 0) continue;

      const outcome = await ctx.sender.send(
        {
          description: `consolidate ${wallet.publicKey.toBase58().slice(0, 6)}`,
          feePayer: wallet.publicKey.toBase58(),
          instructions,
          signers: [wallet],
        },
        { mode: opts.mode },
      );
      report.outcomes.push(outcome);
      report.solTransferred += sendable;
    } catch (err) {
      report.failures.push(String(err));
      log.error({ err, wallet: wallet.publicKey.toBase58() }, 'consolidation failed for wallet');
    }
  }
  return report;
}

/**
 * Claim SOL (multi-wallet): simple SOL sweep from wallets to a destination —
 * the "claim" primitive used by exit flows when wallets already hold SOL.
 */
export async function claimSol(
  ctx: ServiceContext,
  params: { wallets: Keypair[]; destination: string; leaveLamportsPerWallet?: bigint; mode?: 'simulate' | 'execute' },
): Promise<ConsolidateReport> {
  return consolidateAllAssets(ctx, {
    wallets: params.wallets,
    destination: params.destination,
    leaveLamportsPerWallet: params.leaveLamportsPerWallet ?? 0n,
    mode: params.mode,
  });
}

export { chunk, TOKEN_2022_PROGRAM_ID };
