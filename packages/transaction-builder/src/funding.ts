/**
 * Wallet funding helper — a single SystemProgram transfer dispatched through
 * the simulation-first sender.
 *
 * Lives in the shared transaction-builder package so both the services and
 * dex packages can use it (services re-exports it as `fundWallet`; the
 * market-maker uses it to pre-fund buyer wallets from the treasury).
 * @module
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { SendOutcome } from '@solana-toolkit/types';
import type { TransactionSender } from './sender.js';

/** Structural context subset: anything with a sender can fund. */
export interface FundingContext {
  sender: TransactionSender;
}

/**
 * Funds a wallet from a funder via a plain SOL transfer (devnet testing,
 * buyer wallet provisioning, treasury top-ups). Honors simulation mode.
 */
export async function fundWallet(
  ctx: FundingContext,
  params: {
    funder: Keypair;
    destination: PublicKey;
    lamports: bigint;
    mode?: 'simulate' | 'execute';
  },
): Promise<SendOutcome> {
  return ctx.sender.send(
    {
      description: `fund ${params.destination.toBase58().slice(0, 8)} with ${params.lamports} lamports`,
      feePayer: params.funder.publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: params.funder.publicKey,
          toPubkey: params.destination,
          lamports: params.lamports,
        }),
      ],
      signers: [params.funder],
    },
    { mode: params.mode },
  );
}
