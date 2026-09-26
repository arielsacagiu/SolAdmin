/**
 * Venue adapter interface shared by every supported liquidity source.
 * Adapters are intentionally low-level: they expose raw instructions so the
 * volume bot (or any caller) can pack several swaps into a single atomic
 * transaction or a Jito bundle.
 * @module
 */

import type { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';

/** Supported venues for round-trip trading. */
export type VenueKind = 'pumpfun' | 'pumpswap' | 'launchlab' | 'cpmm' | 'jupiter' | 'auto';

/**
 * Instructions plus (optionally) address lookup tables the caller must attach
 * to the v0 message — required by Jupiter routes.
 */
export interface SwapIxSet {
  instructions: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
}

/**
 * Resolved venue state for one mint. Opaque to callers — each adapter keeps
 * its own parsed pool/curve data here. Always call {@link VenueAdapter.refresh}
 * before building instructions so reserves are current.
 */
export interface VenueContext {
  /** Venue this context was resolved for (never 'auto' after resolution). */
  kind: Exclude<VenueKind, 'auto'>;
  /** The tradable mint. */
  mint: string;
  /** Primary pool/curve account address. */
  poolAddress: string;
  /** Adapter-specific decoded state. */
  state: unknown;
  /** Human-readable venue description for logs/reports. */
  label: string;
}

/**
 * A priced atomic round trip produced by {@link VenueAdapter.quoteRoundTrip}:
 * exact tokens pinned on the buy leg, worst-case SOL in, expected SOL back.
 * Adapters may stash remote quotes (Jupiter) in their context so `buyIxs` /
 * `sellIxs` can consume them.
 */
export interface RoundTripQuote {
  /** Venue the quote came from. */
  venue: VenueContext['kind'];
  /** SOL spend cap for the buy leg in lamports (slippage-inclusive). */
  maxSolIn: bigint;
  /** Expected SOL the buy leg spends (pre-slippage, post-fee estimate). */
  expectedSolIn: bigint;
  /** Exact/pinned token amount the buy leg delivers. */
  tokensOut: bigint;
  /** Expected lamports the sell leg returns (post-fee). */
  expectedSolOut: bigint;
  /** Minimum lamports accepted on the sell leg (slippage-inclusive). */
  minSolOut: bigint;
  /** Expected net cost of the round trip in lamports (fees + spread). */
  expectedCostLamports: bigint;
  /** Millisecond timestamp the quote was produced at. */
  quotedAt: number;
}

/**
 * A tradable venue for one mint. Implementations own pool discovery, reserve
 * fetching, quote math and instruction encoding.
 */
export interface VenueAdapter<C extends VenueContext = VenueContext> {
  readonly kind: VenueContext['kind'];
  readonly rpc: SolanaRpcClient;
  /**
   * Discovers the trading venue for `mint` and returns a resolved context.
   * Must throw a descriptive error when no suitable pool/curve exists.
   */
  resolve(mint: PublicKey): Promise<C>;
  /** Re-fetches live reserves/state into a fresh context. */
  refresh(ctx: C): Promise<C>;
  /**
   * Prices an atomic buy→sell round trip of `solLamports` SOL, applying
   * `slippageBps` protection on both legs. Implementations may write prepared
   * quotes into the passed context for `buyIxs`/`sellIxs` to consume.
   */
  quoteRoundTrip(ctx: C, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote>;
  /** Buy instructions for a quoted round trip. */
  buyIxs(ctx: C, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet>;
  /** Sell instructions for a quoted round trip. */
  sellIxs(ctx: C, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet>;
  /**
   * Sell-side instructions for unwinding an arbitrary `tokensIn` balance
   * (not part of a round trip). Applies `slippageBps` to the min-out bound.
   */
  sellTokensIxs(ctx: C, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet>;
  /** Optional cleanup leg appended after the sell (e.g. WSOL unwrap). */
  cleanupIxs?(ctx: C, user: PublicKey): TransactionInstruction[];
}
