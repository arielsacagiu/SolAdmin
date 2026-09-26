/**
 * Unwind & consolidation: sells residual token balances back through the same
 * venue, then sweeps SOL (minus an optional leave-amount) to the funder or a
 * configured destination. Everything goes through TransactionSender so
 * simulation mode and pre-flight checks apply uniformly.
 * @module
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import type { TransactionSender } from '@solana-toolkit/transaction-builder';
import type { SendOutcome, SendOptions } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import {
  ata,
  fetchAccountData,
  fetchTokenAmount,
  unwrapSolIx,
  type VenueAdapter,
  type VenueContext,
} from '@solana-toolkit/venues';
import type { VolumeBotConfig } from './config.js';
import type { PoolWallet } from './wallets.js';

const log = moduleLogger('volume-bot.unwind');

/** Minimum lamports kept for the sweep transaction fee. */
const TX_FEE_RESERVE = 50_000n;

export interface UnwindReport {
  walletsProcessed: number;
  tokensSoldWallets: number;
  solSweptWallets: number;
  outcomes: SendOutcome[];
}

/**
 * Sells residual token balances and sweeps SOL out of every pool wallet.
 *
 * @param destination  override for the sweep target (defaults to config /
 *                     funder public key when set).
 */
export async function unwindPool(
  rpc: SolanaRpcClient,
  sender: TransactionSender,
  adapter: VenueAdapter<VenueContext>,
  ctx: VenueContext,
  cfg: VolumeBotConfig,
  pool: PoolWallet[],
  opts: SendOptions,
  funder?: { publicKey: PublicKey },
): Promise<UnwindReport> {
  const report: UnwindReport = { walletsProcessed: 0, tokensSoldWallets: 0, solSweptWallets: 0, outcomes: [] };
  const mint = new PublicKey(cfg.mint);
  const canSweep = !!cfg.unwind.consolidateTo || !!funder;
  const destination = canSweep
    ? new PublicKey(cfg.unwind.consolidateTo ?? funder!.publicKey.toBase58())
    : null;
  if (!canSweep) log.warn('unwind: no consolidation target — skipping SOL sweep');

  for (const w of pool) {
    const user = w.keypair.publicKey;
    try {
      const ixs: TransactionInstruction[] = [];
      const luts: import('@solana/web3.js').AddressLookupTableAccount[] = [];

      // 1. Sell residual token balance (SPL then Token-2022 ATA).
      if (cfg.unwind.sellResidualTokens) {
        for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          const tokenAta = ata(user, mint, program);
          const balance = await fetchTokenAmount(rpc, tokenAta);
          if (balance > 0n) {
            const live = await adapter.refresh(ctx);
            const sell = await adapter.sellTokensIxs(live, user, balance, cfg.slippageBps);
            ixs.push(...sell.instructions);
            if (sell.lookupTables) luts.push(...sell.lookupTables);
            // Close the emptied token ATA to reclaim rent.
            ixs.push(createCloseAccountInstruction(tokenAta, user, user, [], program));
            report.tokensSoldWallets++;
            break;
          }
        }
      }

      // 2. Unwrap any WSOL dust.
      const wsolAta = ata(user, new PublicKey('So11111111111111111111111111111111111111112'), TOKEN_PROGRAM_ID);
      if (await fetchAccountData(rpc, wsolAta)) ixs.push(unwrapSolIx(user));

      if (ixs.length > 0) {
        const outcome = await sender.send(
          {
            description: `volbot-unwind ${user.toBase58().slice(0, 8)}`,
            feePayer: user.toBase58(),
            instructions: ixs,
            signers: [w.keypair],
            lookupTables: luts.length ? luts : undefined,
          },
          opts,
        );
        report.outcomes.push(outcome);
      }

      // 3. Sweep SOL.
      if (canSweep && destination) {
        const balance = await rpc.balance(user.toBase58());
        const sweep = balance - cfg.unwind.leaveLamports - TX_FEE_RESERVE;
        if (sweep > 0n) {
          const outcome = await sender.send(
            {
              description: `volbot-sweep ${user.toBase58().slice(0, 8)}`,
              feePayer: user.toBase58(),
              instructions: [
                SystemProgram.transfer({ fromPubkey: user, toPubkey: destination, lamports: sweep }),
              ],
              signers: [w.keypair],
            },
            opts,
          );
          report.solSweptWallets++;
          report.outcomes.push(outcome);
        }
      }
      report.walletsProcessed++;
    } catch (err) {
      log.error({ err, wallet: user.toBase58() }, 'unwind failed for wallet');
    }
  }
  log.info(report, 'unwind complete');
  return report;
}
