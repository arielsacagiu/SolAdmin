/**
 * Wallet pool management: loads keystores, optionally generates a fresh pool,
 * checks balances and funds wallets from the funder keystore.
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import type { TransactionSender } from '@solana-toolkit/transaction-builder';
import type { SendOptions } from '@solana-toolkit/types';
import { loadKeystore, generateKeystore } from '@solana-toolkit/wallet-manager';
import { moduleLogger } from '@solana-toolkit/utils';
import type { VolumeBotWalletsConfig } from './config.js';

const log = moduleLogger('volume-bot.wallets');

export interface PoolWallet {
  keypair: Keypair;
  label: string;
  /** Source keystore file (informational, never logged with secrets). */
  source: string;
}

/** ATA rent-exempt minimum (~0.00203 SOL) + WSOL ATA + headroom, lamports. */
export const WALLET_OVERHEAD_LAMPORTS = 6_500_000n;

/**
 * Loads the wallet pool from explicit keystore paths or a directory of
 * `*.json` keystores. Passwords come from SOLADMIN_KEYSTORE_PASSWORD or the
 * interactive prompt handled by loadKeystore callers.
 */
export function loadWalletPool(cfg: VolumeBotWalletsConfig, password?: string): PoolWallet[] {
  const files = cfg.keystorePaths?.length
    ? cfg.keystorePaths
    : fs
        .readdirSync(path.resolve(cfg.keystoreDir!))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(cfg.keystoreDir!, f));

  if (files.length === 0) {
    throw new Error('wallet pool is empty — no keystores found');
  }
  const wallets: PoolWallet[] = files.slice(0, cfg.maxWallets ?? files.length).map((file, i) => ({
    keypair: loadKeystore(file, password),
    label: `wallet-${i}`,
    source: file,
  }));
  log.info({ count: wallets.length }, 'wallet pool loaded');
  return wallets;
}

/**
 * Generates `count` fresh encrypted keystores in `dir` (when missing) and
 * loads them. Used for one-shot disposable pools.
 */
export function generateWalletPool(dir: string, count: number, password: string): PoolWallet[] {
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const needed = count - existing.length;
  for (let i = 0; i < needed; i++) {
    generateKeystore(path.join(dir, `volbot-${Date.now()}-${i}.json`), password, 'volbot');
  }
  return loadWalletPool({ keystoreDir: dir, maxWallets: count }, password);
}

export interface FundPlanEntry {
  wallet: string;
  currentLamports: bigint;
  deficitLamports: bigint;
}

/**
 * Computes top-up amounts so every wallet holds at least `targetLamports`.
 * Pure function — no side effects; testable.
 */
export function planFunding(
  wallets: { publicKey: string; lamports: bigint }[],
  targetLamports: bigint,
): FundPlanEntry[] {
  return wallets
    .map((w) => ({
      wallet: w.publicKey,
      currentLamports: w.lamports,
      deficitLamports: w.lamports >= targetLamports ? 0n : targetLamports - w.lamports,
    }))
    .filter((e) => e.deficitLamports > 0n);
}

/**
 * Funds pool wallets from the funder so each holds at least
 * `maxPerTripLamports + WALLET_OVERHEAD_LAMPORTS`. Transfers go through the
 * sender so simulation mode is honored.
 */
export async function fundWalletPool(
  rpc: SolanaRpcClient,
  sender: TransactionSender,
  funder: Keypair,
  pool: PoolWallet[],
  perWalletLamports: bigint,
  opts: SendOptions = {},
): Promise<{ entries: FundPlanEntry[]; totalNeeded: bigint }> {
  const balances = await rpc.balances(pool.map((w) => w.keypair.publicKey.toBase58()));
  const plan = planFunding(
    pool.map((w, i) => ({ publicKey: w.keypair.publicKey.toBase58(), lamports: balances[i] ?? 0n })),
    perWalletLamports + WALLET_OVERHEAD_LAMPORTS,
  );
  const totalNeeded = plan.reduce((acc, e) => acc + e.deficitLamports, 0n);
  if (plan.length === 0) {
    log.info('wallet pool already funded');
    return { entries: [], totalNeeded: 0n };
  }

  const funderBalance = await rpc.balance(funder.publicKey.toBase58());
  if (funderBalance < totalNeeded + 1_000_000n) {
    throw new Error(
      `funder ${funder.publicKey.toBase58()} holds ${funderBalance} lamports, ` +
        `needs ${totalNeeded + 1_000_000n} to fund the pool`,
    );
  }

  // Chunk transfers into batches of ~18 to stay under the 1232-byte tx limit.
  const CHUNK = 18;
  for (let i = 0; i < plan.length; i += CHUNK) {
    const chunk = plan.slice(i, i + CHUNK);
    const instructions: TransactionInstruction[] = chunk.map((e) =>
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: new PublicKey(e.wallet),
        lamports: e.deficitLamports,
      }),
    );
    const outcome = await sender.send(
      {
        description: `volbot-fund x${chunk.length}`,
        feePayer: funder.publicKey.toBase58(),
        instructions,
        signers: [funder],
      },
      opts,
    );
    log.info({ simulated: outcome.simulated, signature: outcome.signature, chunk: i / CHUNK }, 'funding batch sent');
  }
  return { entries: plan, totalNeeded };
}
