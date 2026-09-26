/**
 * Fast Swap All Tokens in Wallet — swaps every non-native token balance in a
 * wallet to SOL (or any target mint) in one pass. ATAs are created lazily by
 * the route; each swap is simulated before dispatch.
 * @module
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SendOutcome, SwapVenue } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { DexContext } from './context.js';
import { executeSwap } from './swap.js';
import { WSOL_MINT } from '@solana-toolkit/solana-programs';

const log = moduleLogger('swap-all');

export interface SwapAllOptions {
  wallet: Keypair;
  /** Output mint (default WSOL, later unwrapped to SOL). */
  outputMint?: string;
  venue?: SwapVenue;
  slippageBps: number;
  /** Skip mints worth less than this many lamports (dust guard). */
  minOutLamportsEstimate?: bigint;
  mode?: 'simulate' | 'execute';
  /** Explicit allowlist; when set, ONLY these mints are swapped. */
  onlyMints?: string[];
  /** Denylist mints never swapped. */
  skipMints?: string[];
}

export interface SwapAllResult {
  swapped: { mint: string; outcome: SendOutcome | { signature: string; simulated: boolean } }[];
  skipped: { mint: string; reason: string }[];
  failures: { mint: string; error: string }[];
}

/**
 * Enumerates all token accounts of the wallet (both SPL and Token-2022) and
 * swaps each balance to the output mint.
 */
export async function swapAllTokensInWallet(ctx: DexContext, opts: SwapAllOptions): Promise<SwapAllResult> {
  const result: SwapAllResult = { swapped: [], skipped: [], failures: [] };
  const outputMint = opts.outputMint ?? WSOL_MINT;
  const venue = opts.venue ?? 'jupiter';

  const accounts = await ctx.rpc.connection.getTokenAccountsByOwner(
    opts.wallet.publicKey,
    { programId: TOKEN_PROGRAM_ID },
  );
  const accounts2022 = await ctx.rpc.connection.getTokenAccountsByOwner(
    opts.wallet.publicKey,
    { programId: TOKEN_2022_PROGRAM_ID },
  );
  const all = [...accounts.value, ...accounts2022.value];

  for (const { pubkey, account } of all) {
    const info = (account.data as unknown as { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } }).parsed.info;
    const mint = info.mint;
    if (mint === outputMint) continue;
    if (mint === WSOL_MINT && outputMint === WSOL_MINT) {
      result.skipped.push({ mint, reason: 'WSOL handled by unwrap step' });
      continue;
    }
    if (opts.onlyMints && !opts.onlyMints.includes(mint)) continue;
    if (opts.skipMints?.includes(mint)) {
      result.skipped.push({ mint, reason: 'denylist' });
      continue;
    }
    const amountRaw = BigInt(info.tokenAmount.amount);
    if (amountRaw === 0n) {
      result.skipped.push({ mint, reason: 'zero balance' });
      continue;
    }

    try {
      const swap = await executeSwap(ctx, {
        venue,
        user: opts.wallet,
        inputMint: mint,
        outputMint,
        amountInRaw: amountRaw,
        slippageBps: opts.slippageBps,
        mode: opts.mode,
        jito: false, // many swaps — plain RPC keeps fee overhead low
      });
      result.swapped.push({ mint, outcome: swap.outcome });
      log.info({ mint, amountRaw: amountRaw.toString() }, 'swapped');
    } catch (err) {
      result.failures.push({ mint, error: String(err) });
      log.warn({ err, mint }, 'swap failed');
    }
  }

  // Unwrap WSOL back to SOL when the output is WSOL.
  if (outputMint === WSOL_MINT) {
    try {
      const { unwrapSolInstructions } = await import('@solana-toolkit/solana-programs');
      const ixs = unwrapSolInstructions({ owner: opts.wallet.publicKey });
      const outcome = await ctx.sender.send(
        {
          description: 'swap-all: unwrap WSOL',
          feePayer: opts.wallet.publicKey.toBase58(),
          instructions: ixs,
          signers: [opts.wallet],
        },
        { mode: opts.mode },
      );
      result.swapped.push({ mint: WSOL_MINT, outcome });
    } catch (err) {
      result.failures.push({ mint: WSOL_MINT, error: String(err) });
    }
  }

  return result;
}

/** Lists every token mint held by a wallet with balances (for previews). */
export async function listWalletTokens(ctx: DexContext, wallet: PublicKey) {
  const accounts = await ctx.rpc.connection.getParsedTokenAccountsByOwner(wallet, {
    programId: TOKEN_PROGRAM_ID,
  });
  const accounts2022 = await ctx.rpc.connection.getParsedTokenAccountsByOwner(wallet, {
    programId: TOKEN_2022_PROGRAM_ID,
  });
  return [...accounts.value, ...accounts2022.value].map(({ account }) => {
    const info = (account.data as unknown as { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } }).parsed.info;
    return {
      mint: info.mint,
      amountRaw: BigInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
    };
  });
}
