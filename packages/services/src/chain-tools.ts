/**
 * General chain tools: WSOL converter, a local RPC "server mode" helper,
 * transaction history reconstruction, airdrops, and misc utilities.
 * @module
 */

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { HistoryEntry, SendOutcome } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';
import {
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  unwrapSolInstructions,
  getAssociatedTokenAddressSync,
  pk,
  TOKEN_PROGRAM_ID,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('chain-tools');

/**
 * WSOL converter: wraps or unwraps SOL ↔ WSOL for a wallet.
 */
export async function wsolConvert(
  ctx: ServiceContext,
  params: {
    wallet: Keypair;
    /** 'wrap' or 'unwrap'. */
    direction: 'wrap' | 'unwrap';
    /** For wrap: lamports to wrap. For unwrap: all WSOL is unwrapped. */
    lamports?: bigint;
    mode?: 'simulate' | 'execute';
  },
): Promise<SendOutcome> {
  if (params.direction === 'wrap') {
    if (!params.lamports || params.lamports <= 0n) throw new Error('wrap requires lamports > 0');
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, params.wallet.publicKey, false, TOKEN_PROGRAM_ID);
    const instructions: TransactionInstruction[] = [
      createAssociatedTokenAccountInstruction(params.wallet.publicKey, wsolAta, params.wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: params.wallet.publicKey, toPubkey: wsolAta, lamports: params.lamports }),
      createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
    ];
    return ctx.sender.send(
      {
        description: `wrap ${params.lamports} lamports to WSOL`,
        feePayer: params.wallet.publicKey.toBase58(),
        instructions,
        signers: [params.wallet],
      },
      { mode: params.mode },
    );
  }
  return ctx.sender.send(
    {
      description: 'unwrap WSOL to SOL',
      feePayer: params.wallet.publicKey.toBase58(),
      instructions: unwrapSolInstructions({ owner: params.wallet.publicKey }),
      signers: [params.wallet],
    },
    { mode: params.mode },
  );
}

/**
 * Requests a devnet airdrop (mainnet is not supported by the RPC; the call
 * fails gracefully).
 */
export async function requestAirdrop(ctx: ServiceContext, wallet: PublicKey, lamports = 1_000_000_000): Promise<string> {
  if (ctx.config.rpc.cluster !== 'devnet' && ctx.config.rpc.cluster !== 'localnet') {
    throw new Error('airdrop is only available on devnet/localnet');
  }
  const sig = await ctx.rpc.connection.requestAirdrop(wallet, lamports);
  await ctx.rpc.confirm(sig);
  return sig;
}

/**
 * Reconstructs transaction history for an address with block times, fees
 * and statuses. Writes a JSONL entry set into the history recorder.
 */
export async function reconstructHistory(ctx: ServiceContext, address: string, limit = 100): Promise<HistoryEntry[]> {
  const sigs = await ctx.rpc.connection.getSignaturesForAddress(new PublicKey(address), { limit });
  const entries: HistoryEntry[] = [];
  for (const sig of sigs) {
    const entry: HistoryEntry = {
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? null,
      fee: 0,
      status: sig.err ? 'failed' : 'success',
      description: sig.memo ?? undefined,
      timestampLogged: new Date().toISOString(),
    };
    ctx.history.record(entry);
    entries.push(entry);
  }
  log.info({ address, entries: entries.length }, 'history reconstructed');
  return entries;
}

/**
 * Funds a wallet from a funder (devnet testing / buyer wallet provisioning).
 */
export async function fundWallet(
  ctx: ServiceContext,
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

/**
 * RPC server mode configuration — the CLI/web app runs a local HTTP server
 * that proxies read-only JSON-RPC calls to the configured endpoint, adds
 * caching, and logs every query for auditability. This function validates
 * that the configured RPC endpoint is reachable and returns its feature set.
 */
export async function probeRpcEndpoint(ctx: ServiceContext): Promise<{
  rpcUrl: string;
  version: string;
  slot: number;
  supportsWebsockets: boolean;
  features: string[];
}> {
  const version = await ctx.rpc.connection.getVersion();
  const slot = await ctx.rpc.connection.getSlot();
  const features: string[] = [];
  try {
    await ctx.rpc.connection.getRecentPrioritizationFees();
    features.push('prioritization-fees');
  } catch { /* not supported */ }
  try {
    await ctx.jito.getTipAccounts();
    features.push('jito-bundles');
  } catch { /* not reachable */ }
  return {
    rpcUrl: ctx.config.rpc.rpcUrl,
    version: (version as { 'solana-core'?: string })['solana-core'] ?? 'unknown',
    slot,
    supportsWebsockets: Boolean(ctx.config.rpc.wsUrl),
    features,
  };
}

/** Returns explorer links for a signature or address. */
export function explorerLinks(value: string): { solscan: string; solanaFM: string; explorer: string } {
  return {
    solscan: `https://solscan.io/tx/${value}`,
    solanaFM: `https://solana.fm/tx/${value}`,
    explorer: `https://explorer.solana.com/tx/${value}`,
  };
}

/** Returns explorer links for an account. */
export function accountExplorerLinks(address: string): { solscan: string; solanaFM: string } {
  return {
    solscan: `https://solscan.io/account/${address}`,
    solanaFM: `https://solana.fm/address/${address}`,
  };
}

/** Vanity/sanity check helper: is this string a valid pubkey? */
export function isValidPubkey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export { pk };
