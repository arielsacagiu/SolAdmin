/**
 * Jupiter aggregator adapter — covers every DEX Jupiter routes through
 * (Raydium AMM v4/CLMM/CPMM, PumpSwap, Orca, Meteora, ...).
 *
 * Uses the public Swap API:
 *   GET  {base}/swap/v1/quote                 — ExactIn quotes
 *   POST {base}/swap/v1/swap-instructions     — instruction set for embedding
 *
 *   - `https://lite-api.jup.ag` — free tier, no key required (rate-limited).
 *   - `https://api.jup.ag`      — paid tier, needs `x-api-key` header
 *                                (SOLADMIN_JUPITER_API_KEY).
 *
 * The swap-instructions response is decomposed into
 * {setupInstructions, swapInstruction, cleanupInstruction, otherInstructions}
 * plus addressLookupTableAddresses — Jupiter's own compute-budget ixs are
 * dropped so our builder controls priority fees.
 * @module
 */

import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger, retry } from '@solana-toolkit/utils';
import { WSOL_MINT } from './common.js';
import type { RoundTripQuote, SwapIxSet, VenueAdapter, VenueContext } from './types.js';

const log = moduleLogger('venue.jupiter');

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { ammKey: string; label?: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string }; percent: number }[];
  contextSlot?: number;
  timeTaken?: number;
  [key: string]: unknown;
}

interface JupiterIxJson {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

interface JupiterSwapInstructionsResponse {
  computeBudgetInstructions?: JupiterIxJson[];
  setupInstructions?: JupiterIxJson[];
  swapInstruction: JupiterIxJson;
  cleanupInstruction?: JupiterIxJson | null;
  otherInstructions?: JupiterIxJson[];
  addressLookupTableAddresses?: string[];
}

function decodeIx(ix: JupiterIxJson): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

export interface JupiterVenueOptions {
  /** API base. Default https://lite-api.jup.ag (or SOLADMIN_JUPITER_API_BASE). */
  apiBase?: string;
  /** API key for the paid api.jup.ag tier (or SOLADMIN_JUPITER_API_KEY). */
  apiKey?: string;
}

export interface JupiterContext extends VenueContext {
  kind: 'jupiter';
  state: {
    /** Prepared quotes written by quoteRoundTrip, consumed by buyIxs/sellIxs. */
    buyQuote?: JupiterQuote;
    sellQuote?: JupiterQuote;
  };
}

/**
 * Jupiter adapter. `resolve()` only probes routability — Jupiter discovers
 * routes internally, so there is no pool state to hold.
 */
export class JupiterVenue implements VenueAdapter<JupiterContext> {
  readonly kind = 'jupiter' as const;
  private readonly apiBase: string;
  private readonly apiKey?: string;

  constructor(readonly rpc: SolanaRpcClient, opts: JupiterVenueOptions = {}) {
    this.apiBase = (opts.apiBase ?? process.env['SOLADMIN_JUPITER_API_BASE'] ?? 'https://lite-api.jup.ag').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env['SOLADMIN_JUPITER_API_KEY'];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  /** Raw ExactIn quote request against /swap/v1/quote. */
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupiterQuote> {
    const url =
      `${this.apiBase}/swap/v1/quote?inputMint=${inputMint}` +
      `&outputMint=${outputMint}&amount=${amount.toString()}` +
      `&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    const res = await retry(() => fetch(url, { headers: this.headers() }), {
      retries: 3,
      backoffMs: 400,
      label: 'jupiter quote',
    });
    if (!res.ok) throw new Error(`jupiter quote failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return (await res.json()) as JupiterQuote;
  }

  /**
   * Converts a quote into swap instructions for `user`. Jupiter's setup/swap/
   * cleanup/other ixs and its ALTs are kept; its compute-budget ixs are
   * dropped — priority fees are owned by our transaction builder.
   */
  async swapIxSet(quoteResp: JupiterQuote, user: PublicKey): Promise<SwapIxSet> {
    const body = {
      quoteResponse: quoteResp,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: false,
      // We set our own compute budget; no jupiter-side CU/priority ixs.
      prioritizationFeeLamports: 'no',
    };
    const res = await retry(
      () =>
        fetch(`${this.apiBase}/swap/v1/swap-instructions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        }),
      { retries: 3, backoffMs: 400, label: 'jupiter swap-instructions' },
    );
    if (!res.ok) {
      throw new Error(`jupiter swap-instructions failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
    const json = (await res.json()) as JupiterSwapInstructionsResponse;

    const instructions: TransactionInstruction[] = [
      ...(json.setupInstructions ?? []).map(decodeIx),
      decodeIx(json.swapInstruction),
      ...(json.otherInstructions ?? []).map(decodeIx),
      ...(json.cleanupInstruction ? [decodeIx(json.cleanupInstruction)] : []),
    ];

    const lutAddrs = json.addressLookupTableAddresses ?? [];
    const lookupTables: AddressLookupTableAccount[] = [];
    if (lutAddrs.length > 0) {
      const infos = await retry(
        () => this.rpc.connection.getMultipleAccountsInfo(lutAddrs.map((a) => new PublicKey(a))),
        { retries: 3, label: 'jupiter ALT fetch' },
      );
      for (let i = 0; i < lutAddrs.length; i++) {
        const info = infos[i];
        if (!info) throw new Error(`address lookup table ${lutAddrs[i]} not found`);
        lookupTables.push(
          new AddressLookupTableAccount({
            key: new PublicKey(lutAddrs[i]!),
            state: AddressLookupTableAccount.deserialize(info.data),
          }),
        );
      }
    }
    return { instructions, lookupTables: lookupTables.length > 0 ? lookupTables : undefined };
  }

  async resolve(mint: PublicKey): Promise<JupiterContext> {
    const q = await this.quote(WSOL_MINT.toBase58(), mint.toBase58(), 1_000_000n, 300).catch((err) => {
      throw new Error(`jupiter: mint ${mint.toBase58()} not routable — ${String(err)}`);
    });
    log.debug({ outAmount: q.outAmount }, 'jupiter route probe ok');
    return {
      kind: 'jupiter',
      mint: mint.toBase58(),
      poolAddress: 'aggregator',
      state: {},
      label: `jupiter aggregator (${q.routePlan?.map((r) => r.swapInfo.label ?? '?').join(', ') || 'unknown route'})`,
    };
  }

  async refresh(ctx: JupiterContext): Promise<JupiterContext> {
    return ctx; // quotes are fetched per-leg; nothing stateful to refresh
  }

  /**
   * Prices a round trip with two real Jupiter quotes. The sell leg quotes a
   * hair under the buy leg's expected output (0.3% buffer) so transient
   * shortfalls fail safe (bundle reverts) rather than strand the bundle.
   */
  async quoteRoundTrip(ctx: JupiterContext, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote> {
    const buy = await this.quote(WSOL_MINT.toBase58(), ctx.mint, solLamports, slippageBps);
    const tokensEst = BigInt(buy.otherAmountThreshold);
    const sellIn = (tokensEst * 997n) / 1000n; // 0.3% under expected out
    const sell = await this.quote(ctx.mint, WSOL_MINT.toBase58(), sellIn, slippageBps);
    ctx.state.buyQuote = buy;
    ctx.state.sellQuote = sell;
    const solBack = BigInt(sell.otherAmountThreshold);
    return {
      venue: 'jupiter',
      maxSolIn: solLamports,
      expectedSolIn: solLamports,
      tokensOut: sellIn,
      expectedSolOut: solBack,
      minSolOut: solBack,
      expectedCostLamports: solLamports > solBack ? solLamports - solBack : 0n,
      quotedAt: Date.now(),
    };
  }

  async buyIxs(ctx: JupiterContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const q = ctx.state.buyQuote ?? (await this.quote(WSOL_MINT.toBase58(), ctx.mint, quote.maxSolIn, 300));
    ctx.state.buyQuote = q;
    return this.swapIxSet(q, user);
  }

  async sellIxs(ctx: JupiterContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const q =
      ctx.state.sellQuote ??
      (await this.quote(ctx.mint, WSOL_MINT.toBase58(), quote.tokensOut, 300));
    ctx.state.sellQuote = q;
    return this.swapIxSet(q, user);
  }

  async sellTokensIxs(ctx: JupiterContext, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet> {
    const q = await this.quote(ctx.mint, WSOL_MINT.toBase58(), tokensIn, slippageBps);
    return this.swapIxSet(q, user);
  }
}
