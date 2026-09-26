/**
 * Jupiter aggregator client (Lite API — free, public, self-hostable).
 *
 * Quotes are fetched from `/swap/v1/quote`; swaps are built via
 * `/swap/v1/swap` which returns a serialized transaction that is DECODED,
 * signed LOCALLY and dispatched through the toolkit's simulation-first
 * sender. Keys never leave the process.
 * @module
 */

import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import type { SwapQuote } from '@solana-toolkit/types';
import { moduleLogger, retry } from '@solana-toolkit/utils';
import type { DexContext } from './context.js';

const log = moduleLogger('jupiter');

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

export interface JupiterSwapResponse {
  swapTransaction: string; // base64
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  [key: string]: unknown;
}

/**
 * Requests a quote from the Jupiter Lite API.
 */
export async function jupiterQuote(
  ctx: DexContext,
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
  slippageBps: number,
): Promise<JupiterQuoteResponse> {
  const url =
    `${ctx.jupiterApiBase}/swap/v1/quote?inputMint=${inputMint}` +
    `&outputMint=${outputMint}&amount=${amountRaw.toString()}&slippageBps=${slippageBps}` +
    `&restrictIntermediateTokens=true`;
  return retry(
    async () => {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
      return (await res.json()) as JupiterQuoteResponse;
    },
    { retries: 3, backoffMs: 400, label: 'jupiter quote' },
  );
}

/**
 * Builds a swap plan: returns the unsigned swap transaction (base64) plus the
 * quote used, ready to be signed locally and dispatched.
 */
export async function jupiterSwapPlan(
  ctx: DexContext,
  params: {
    user: Keypair;
    inputMint: string;
    outputMint: string;
    amountInRaw: bigint;
    slippageBps: number;
    wrapAndUnwrapSol?: boolean;
  },
): Promise<{ quote: SwapQuote; swapTransaction: string }> {
  const quote = await jupiterQuote(
    ctx,
    params.inputMint,
    params.outputMint,
    params.amountInRaw,
    params.slippageBps,
  );
  const body = {
    quoteResponse: quote,
    userPublicKey: params.user.publicKey.toBase58(),
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 2_000_000,
        priorityLevel: 'veryHigh',
      },
    },
  };
  const res = await retry(
    () =>
      fetch(`${ctx.jupiterApiBase}/swap/v1/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    { retries: 2, backoffMs: 400, label: 'jupiter swap plan' },
  );
  if (!res.ok) {
    throw new Error(`Jupiter swap plan failed: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as JupiterSwapResponse;
  const swapQuote: SwapQuote = {
    venue: 'jupiter',
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmountRaw: quote.inAmount,
    outAmountRaw: quote.outAmount,
    priceImpactBps: quote.priceImpactPct ? Math.round(Number(quote.priceImpactPct) * 10_000) : undefined,
    slippageBps: params.slippageBps,
    routeData: quote.routePlan,
  };
  return { quote: swapQuote, swapTransaction: json.swapTransaction };
}

/**
 * Signs a Jupiter swap transaction locally and dispatches it through the RPC
 * endpoint or the Jito relay, respecting simulation mode.
 *
 * SECURITY: the serialized swap transaction produced by the API is decoded
 * and signed in-process; the private key never leaves the machine and no
 * signing authority is delegated to the API.
 */
export async function sendPrebuiltSwap(
  ctx: DexContext,
  params: { user: Keypair; swapTransaction: string; mode: 'simulate' | 'execute'; jito: boolean },
): Promise<{ signature: string; simulated: boolean }> {
  const started = Date.now();
  const vtx = VersionedTransaction.deserialize(Buffer.from(params.swapTransaction, 'base64'));
  vtx.sign([params.user]);
  const base64 = Buffer.from(vtx.serialize()).toString('base64');
  if (params.mode === 'simulate') {
    try {
      const sim = await ctx.rpc.connection.simulateTransaction(vtx, { sigVerify: true, replaceRecentBlockhash: true });
      if (!sim.value.err) {
        log.info({ consumedUnits: sim.value.unitsConsumed }, 'jupiter swap SIMULATED ok');
      } else {
        log.warn({ err: sim.value.err }, 'jupiter swap simulation failed');
      }
    } catch (err) {
      log.debug({ err }, 'simulation error (network?)');
    }
    return { signature: '(simulated)', simulated: true };
  }
  if (params.jito) {
    await ctx.jito.sendTransaction(base64);
  } else {
    await ctx.rpc.sendRawTransaction(base64);
  }
  const signature = Buffer.from(vtx.signatures[0]!).toString('base64');
  const elapsedMs = Date.now() - started;
  log.info({ signature, elapsedMs }, 'jupiter swap dispatched');
  return { signature, simulated: false };
}

/** Token decimals lookup via Jupiter Token API v2 (search by mint). */
export async function jupiterTokenInfo(
  ctx: DexContext,
  mint: string,
): Promise<{ decimals: number; symbol?: string; name?: string } | null> {
  try {
    const res = await fetch(`${ctx.jupiterApiBase}/tokens/v2/search?query=${mint}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tokens?: { address: string; decimals: number; symbol?: string; name?: string }[] };
    const hit = json.tokens?.find((t) => t.address === mint);
    return hit ?? null;
  } catch {
    return null;
  }
}
