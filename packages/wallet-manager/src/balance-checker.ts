/**
 * Batch balance checking across many wallets, with optional SPL/Token-2022
 * token balances for a set of mints.
 * @module
 */

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getMultipleAccounts,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type { BalanceRow } from '@solana-toolkit/types';
import { chunk, lamportsToSol, moduleLogger } from '@solana-toolkit/utils';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';

const log = moduleLogger('balance-checker');

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/**
 * Checks SOL balances for many addresses in batched RPC calls.
 */
export async function checkSolBalances(
  rpc: SolanaRpcClient,
  records: { label: string; publicKey: string }[],
): Promise<BalanceRow[]> {
  const addresses = records.map((r) => r.publicKey);
  const balances = await rpc.balances(addresses);
  return records.map((r, i) => ({
    label: r.label,
    publicKey: r.publicKey,
    lamports: balances[i] ?? 0n,
    sol: lamportsToSol(balances[i] ?? 0n),
    tokens: {},
  }));
}

/**
 * Checks SOL + token balances. Token balances are read from canonical
 * associated token accounts for each (owner, mint) pair under both the SPL
 * Token and Token-2022 programs.
 */
export async function checkBalances(
  rpc: SolanaRpcClient,
  records: { label: string; publicKey: string }[],
  mints: string[] = [],
  opts: { batchSize?: number } = {},
): Promise<BalanceRow[]> {
  const rows = await checkSolBalances(rpc, records);
  if (mints.length === 0) return rows;
  const batchSize = opts.batchSize ?? 100;

  for (const mint of mints) {
    const mintPk = new PublicKey(mint);

    // Canonical ATA per (owner, token program). Null when derivation fails.
    const ataGrid: (PublicKey | null)[][] = await Promise.all(
      records.map((r) =>
        Promise.all(
          TOKEN_PROGRAMS.map(async (program) => {
            try {
              return await getAssociatedTokenAddress(mintPk, new PublicKey(r.publicKey), true, program);
            } catch {
              return null;
            }
          }),
        ),
      ),
    );

    // Flatten, batch-fetch, then map balances back to (owner, program) pairs.
    const flat = ataGrid.flat().filter((a): a is PublicKey => a !== null);
    const amounts = new Map<string, bigint>();
    for (const c of chunk(flat, batchSize)) {
      const infos = await getMultipleAccounts(rpc.connection, c);
      c.forEach((ata, idx) => {
        const info = infos[idx];
        if (info && info.amount) {
          amounts.set(ata.toBase58(), BigInt(info.amount));
        }
      });
    }

    records.forEach((row, i) => {
      let total = 0n;
      for (const ata of ataGrid[i] ?? []) {
        if (ata) total += amounts.get(ata.toBase58()) ?? 0n;
      }
      if (total > 0n) {
        rows[i]!.tokens[mint] = total;
      }
    });
  }

  log.info({ wallets: records.length, mints: mints.length }, 'batch balance check complete');
  return rows;
}
