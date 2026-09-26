/**
 * Raydium LaunchLab adapter — the bonding curve behind letsbonk.fun / bonk.fun
 * ("Bonk" venue on ct.app). Direct program calls.
 *
 * Verified on-chain constants:
 *   program            LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
 *   buy_exact_in disc  [250,234,13,123,213,156,19,236]
 *   sell_exact_in disc [149,39,222,155,211,124,152,26]
 *   fee denominator    1_000_000 (parts per million)
 *
 * Swap accounts (15, shared by all four buy/sell variants):
 *   payer(w,s), authority, global_config, platform_config, pool_state(w),
 *   user_base_token(w), user_quote_token(w), base_vault(w), quote_vault(w),
 *   base_mint, quote_mint, base_token_program, quote_token_program,
 *   event_authority, program
 *
 * PoolState (bincode, after 8-byte Anchor disc; base_mint at offset 205,
 * quote_mint at 237) carries global_config, platform_config, both vaults and
 * the creator — so a single pool read resolves every needed key.
 *
 * Effective reserves: base = virtual_base - real_base,
 *                     quote = virtual_quote + real_quote (constant product).
 * @module
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger, retry } from '@solana-toolkit/utils';
import {
  WSOL_MINT,
  anchorIxDiscriminator,
  ata,
  constantProductIn,
  constantProductOut,
  ensureAtaIx,
  fetchAccountData,
  readPubkey,
  readU64,
  u64le,
  unwrapSolIx,
  wrapSolIxs,
} from './common.js';
import type { RoundTripQuote, SwapIxSet, VenueAdapter, VenueContext } from './types.js';

const log = moduleLogger('venue.launchlab');

export const LAUNCHLAB_PROGRAM_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const LAUNCHLAB_BUY_EXACT_IN_DISC = Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]);
export const LAUNCHLAB_SELL_EXACT_IN_DISC = Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]);
export const LAUNCHLAB_BUY_EXACT_OUT_DISC = Buffer.from([24, 211, 116, 40, 105, 3, 153, 56]);
export const LAUNCHLAB_SELL_EXACT_OUT_DISC = Buffer.from([95, 200, 71, 34, 8, 9, 11, 166]);

export const LAUNCHLAB_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  LAUNCHLAB_PROGRAM_ID,
)[0];

/** PoolState min size: 8 disc + ~421 data (62-byte tail padding included). */
export const LAUNCHPAD_POOL_MIN_SIZE = 429;

/**
 * Default assumed total fee in basis points (protocol + platform). The true
 * rate lives in global_config/platform_config; this conservative default is
 * used for quote sizing — the on-chain `share_fee_rate` arg is passed through
 * from config.
 */
export const LAUNCHLAB_DEFAULT_FEE_BPS = 125n;

/** Parsed LaunchLab PoolState (little-endian after the 8-byte Anchor disc). */
export interface LaunchpadPoolState {
  epoch: bigint;
  authBump: number;
  /** 0=Fund, 1=Live, 2=Ended(migrated) */
  status: number;
  baseDecimals: number;
  quoteDecimals: number;
  migrateType: number;
  supply: bigint;
  totalBaseSell: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  totalQuoteFundRaising: bigint;
  quoteProtocolFee: bigint;
  platformFee: bigint;
  migrateFee: bigint;
  globalConfig: PublicKey;
  platformConfig: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  creator: PublicKey;
  /** bit0=base is Token2022, bit1=quote is Token2022 (0=SPL). */
  tokenProgramFlag: number;
  ammCreatorFeeOn: number;
}

export interface LaunchLabContext extends VenueContext {
  kind: 'launchlab';
  state: LaunchpadPoolState & { baseReserves: bigint; quoteReserves: bigint };
  /** share_fee_rate arg forwarded to swap ixs (platform fee share, ppm units). */
  shareFeeRate: bigint;
}

/**
 * Decodes a Launchpad PoolState account. Offsets (byte-exact):
 *   epoch@8, auth_bump@16, status@17, base_dec@18, quote_dec@19,
 *   migrate_type@20, supply@21, total_base_sell@29, virtual_base@37,
 *   virtual_quote@45, real_base@53, real_quote@61, total_quote_fund@69,
 *   quote_protocol_fee@77, platform_fee@85, migrate_fee@93,
 *   vesting(5×u64)@101-141, global_config@141?? — see layout constants below.
 */
export function parseLaunchpadPoolState(data: Buffer): LaunchpadPoolState {
  if (data.length < 367) {
    throw new Error(`launchpad pool account too short: ${data.length}`);
  }
  return {
    epoch: readU64(data, 8),
    authBump: data[16]!,
    status: data[17]!,
    baseDecimals: data[18]!,
    quoteDecimals: data[19]!,
    migrateType: data[20]!,
    supply: readU64(data, 21),
    totalBaseSell: readU64(data, 29),
    virtualBase: readU64(data, 37),
    virtualQuote: readU64(data, 45),
    realBase: readU64(data, 53),
    realQuote: readU64(data, 61),
    totalQuoteFundRaising: readU64(data, 69),
    quoteProtocolFee: readU64(data, 77),
    platformFee: readU64(data, 85),
    migrateFee: readU64(data, 93),
    // vesting_schedule: 5 × u64 at 101..141 (unused for quoting)
    globalConfig: readPubkey(data, 141),
    platformConfig: readPubkey(data, 173),
    baseMint: readPubkey(data, 205),
    quoteMint: readPubkey(data, 237),
    baseVault: readPubkey(data, 269),
    quoteVault: readPubkey(data, 301),
    creator: readPubkey(data, 333),
    tokenProgramFlag: data[365]!,
    ammCreatorFeeOn: data[366]!,
  };
}

/** Effective reserves per the LaunchLab constant-product curve. */
export function launchpadReserves(p: LaunchpadPoolState): { base: bigint; quote: bigint } {
  const base = p.virtualBase - p.realBase;
  const quote = p.virtualQuote + p.realQuote;
  return { base: base < 0n ? 0n : base, quote: quote < 0n ? 0n : quote };
}

/** Pool vault authority PDA: ["vault_and_lp_mint_auth_seed", pool] with stored bump. */
export function launchpadAuthority(poolId: PublicKey, bump: number): PublicKey {
  return PublicKey.createProgramAddressSync(
    [Buffer.from('vault_and_lp_mint_auth_seed'), poolId.toBuffer(), Buffer.from([bump])],
    LAUNCHLAB_PROGRAM_ID,
  );
}

/** Candidate pool PDA seeds: ["pool", base_mint, quote_mint] (LaunchLab convention). */
export function launchpadPoolPda(baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), baseMint.toBuffer(), quoteMint.toBuffer()],
    LAUNCHLAB_PROGRAM_ID,
  )[0];
}

/** Discovers the launchlab pool for `baseMint` via memcmp scan (offsets 205/237). */
export async function findLaunchpadPool(
  rpc: SolanaRpcClient,
  baseMint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): Promise<{ address: PublicKey; state: LaunchpadPoolState } | null> {
  // Fast path: derive the PDA and read it directly.
  const derived = launchpadPoolPda(baseMint, quoteMint);
  const derivedData = await fetchAccountData(rpc, derived).catch(() => null);
  if (derivedData && derivedData.length >= 367) {
    const state = parseLaunchpadPoolState(derivedData);
    if (state.baseMint.equals(baseMint)) {
      return { address: derived, state };
    }
  }
  // Fallback: program scan (slow on public RPC — prefer a private endpoint).
  const accounts = await retry(
    () =>
      rpc.connection.getProgramAccounts(LAUNCHLAB_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 205, bytes: baseMint.toBase58() } }],
        dataSlice: { offset: 0, length: 367 },
      }),
    { retries: 3, label: 'launchlab pool scan' },
  );
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    try {
      const state = parseLaunchpadPoolState(data);
      if (state.quoteMint.equals(quoteMint)) return { address: pubkey, state };
    } catch {
      continue;
    }
  }
  return null;
}

interface LaunchpadAccounts {
  pool: PublicKey;
  authority: PublicKey;
  globalConfig: PublicKey;
  platformConfig: PublicKey;
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
}

function launchpadMetas(a: LaunchpadAccounts, user: PublicKey) {
  return [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: a.authority, isSigner: false, isWritable: false },
    { pubkey: a.globalConfig, isSigner: false, isWritable: false },
    { pubkey: a.platformConfig, isSigner: false, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userBaseAta, isSigner: false, isWritable: true },
    { pubkey: a.userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: a.baseVault, isSigner: false, isWritable: true },
    { pubkey: a.quoteVault, isSigner: false, isWritable: true },
    { pubkey: a.baseMint, isSigner: false, isWritable: false },
    { pubkey: a.quoteMint, isSigner: false, isWritable: false },
    { pubkey: a.baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: a.quoteTokenProgram, isSigner: false, isWritable: false },
    { pubkey: LAUNCHLAB_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: LAUNCHLAB_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

/** buy_exact_in(amount_in quote, min_base_out, share_fee_rate). */
export function buildLaunchpadBuyExactInIx(
  a: LaunchpadAccounts,
  user: PublicKey,
  quoteIn: bigint,
  minBaseOut: bigint,
  shareFeeRate: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    LAUNCHLAB_BUY_EXACT_IN_DISC,
    u64le(quoteIn),
    u64le(minBaseOut),
    u64le(shareFeeRate),
  ]);
  return new TransactionInstruction({ keys: launchpadMetas(a, user), programId: LAUNCHLAB_PROGRAM_ID, data });
}

/** buy_exact_out(amount_out base, maximum_amount_in quote, share_fee_rate). */
export function buildLaunchpadBuyExactOutIx(
  a: LaunchpadAccounts,
  user: PublicKey,
  baseOut: bigint,
  maxQuoteIn: bigint,
  shareFeeRate: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    LAUNCHLAB_BUY_EXACT_OUT_DISC,
    u64le(baseOut),
    u64le(maxQuoteIn),
    u64le(shareFeeRate),
  ]);
  return new TransactionInstruction({ keys: launchpadMetas(a, user), programId: LAUNCHLAB_PROGRAM_ID, data });
}

/** sell_exact_in(amount_in base, min_quote_out, share_fee_rate). */
export function buildLaunchpadSellExactInIx(
  a: LaunchpadAccounts,
  user: PublicKey,
  baseIn: bigint,
  minQuoteOut: bigint,
  shareFeeRate: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    LAUNCHLAB_SELL_EXACT_IN_DISC,
    u64le(baseIn),
    u64le(minQuoteOut),
    u64le(shareFeeRate),
  ]);
  return new TransactionInstruction({ keys: launchpadMetas(a, user), programId: LAUNCHLAB_PROGRAM_ID, data });
}

function resolveTokenPrograms(flag: number): { base: PublicKey; quote: PublicKey } {
  return {
    base: flag & 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    quote: flag & 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}

export interface LaunchLabVenueOptions {
  /** share_fee_rate forwarded to every swap ix (ppm). Default 0. */
  shareFeeRate?: bigint;
  /** Assumed total fee buffer in bps for quote sizing. Default 125 (1.25%). */
  assumedFeeBps?: bigint;
}

export class LaunchLabVenue implements VenueAdapter<LaunchLabContext> {
  readonly kind = 'launchlab' as const;
  private readonly shareFeeRate: bigint;
  private readonly feeBps: bigint;

  constructor(readonly rpc: SolanaRpcClient, opts: LaunchLabVenueOptions = {}) {
    this.shareFeeRate = opts.shareFeeRate ?? 0n;
    this.feeBps = opts.assumedFeeBps ?? LAUNCHLAB_DEFAULT_FEE_BPS;
  }

  async resolve(mint: PublicKey): Promise<LaunchLabContext> {
    const found = await findLaunchpadPool(this.rpc, mint);
    if (!found) {
      throw new Error(`launchlab: no WSOL pool found for mint ${mint.toBase58()}`);
    }
    const state = found.state;
    if (state.status !== 1) {
      throw new Error(`launchlab: pool ${found.address.toBase58()} not live (status=${state.status})`);
    }
    const { base, quote } = launchpadReserves(state);
    if (base === 0n || quote === 0n) throw new Error('launchlab: pool has no effective reserves');
    return {
      kind: 'launchlab',
      mint: mint.toBase58(),
      poolAddress: found.address.toBase58(),
      state: { ...state, baseReserves: base, quoteReserves: quote },
      shareFeeRate: this.shareFeeRate,
      label: `launchlab pool ${found.address.toBase58()}`,
    };
  }

  async refresh(ctx: LaunchLabContext): Promise<LaunchLabContext> {
    return this.resolve(new PublicKey(ctx.mint));
  }

  quoteSolForTokens(ctx: LaunchLabContext, tokensOut: bigint): bigint {
    return constantProductIn(tokensOut, ctx.state.quoteReserves, ctx.state.baseReserves, this.feeBps);
  }

  quoteTokensForSol(ctx: LaunchLabContext, solLamports: bigint): bigint {
    return constantProductOut(solLamports, ctx.state.quoteReserves, ctx.state.baseReserves, this.feeBps);
  }

  quoteSolForTokenSell(ctx: LaunchLabContext, tokensIn: bigint): bigint {
    return constantProductOut(tokensIn, ctx.state.baseReserves, ctx.state.quoteReserves, this.feeBps);
  }

  private accounts(ctx: LaunchLabContext, user: PublicKey): LaunchpadAccounts {
    const p = ctx.state;
    const pool = new PublicKey(ctx.poolAddress);
    const programs = resolveTokenPrograms(p.tokenProgramFlag);
    return {
      pool,
      authority: launchpadAuthority(pool, p.authBump),
      globalConfig: p.globalConfig,
      platformConfig: p.platformConfig,
      userBaseAta: ata(user, p.baseMint, programs.base),
      userQuoteAta: ata(user, p.quoteMint, programs.quote),
      baseVault: p.baseVault,
      quoteVault: p.quoteVault,
      baseMint: p.baseMint,
      quoteMint: p.quoteMint,
      baseTokenProgram: programs.base,
      quoteTokenProgram: programs.quote,
    };
  }

  async quoteRoundTrip(ctx: LaunchLabContext, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote> {
    const slip = BigInt(slippageBps);
    const tokensOut = this.quoteTokensForSol(ctx, solLamports);
    const expectedSolIn = this.quoteSolForTokens(ctx, tokensOut);
    const maxSolIn = (expectedSolIn * (10_000n + slip)) / 10_000n;
    const expectedSolOut = this.quoteSolForTokenSell(ctx, tokensOut);
    const minSolOut = (expectedSolOut * (10_000n - slip)) / 10_000n;
    return {
      venue: 'launchlab',
      maxSolIn,
      expectedSolIn,
      tokensOut,
      expectedSolOut,
      minSolOut,
      expectedCostLamports: expectedSolIn > expectedSolOut ? expectedSolIn - expectedSolOut : 0n,
      quotedAt: Date.now(),
    };
  }

  async buyIxs(ctx: LaunchLabContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user);
    const programs = resolveTokenPrograms(ctx.state.tokenProgramFlag);
    const instructions: TransactionInstruction[] = [
      ensureAtaIx(user, user, a.baseMint, programs.base),
      ...wrapSolIxs(user, user, quote.maxSolIn),
      // buy_exact_out pins the token output so a same-transaction sell leg
      // can reference the exact amount received.
      buildLaunchpadBuyExactOutIx(a, user, quote.tokensOut, quote.maxSolIn, ctx.shareFeeRate),
    ];
    log.debug({ user: user.toBase58(), tokensOut: quote.tokensOut.toString() }, 'launchlab buy ixs');
    return { instructions };
  }

  async sellIxs(ctx: LaunchLabContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user);
    return {
      instructions: [buildLaunchpadSellExactInIx(a, user, quote.tokensOut, quote.minSolOut, ctx.shareFeeRate)],
    };
  }

  async sellTokensIxs(ctx: LaunchLabContext, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet> {
    const est = this.quoteSolForTokenSell(ctx, tokensIn);
    const minSolOut = (est * (10_000n - BigInt(slippageBps))) / 10_000n;
    const a = this.accounts(ctx, user);
    return {
      instructions: [
        buildLaunchpadSellExactInIx(a, user, tokensIn, minSolOut, ctx.shareFeeRate),
        unwrapSolIx(user),
      ],
    };
  }

  cleanupIxs(_ctx: LaunchLabContext, user: PublicKey): TransactionInstruction[] {
    return [unwrapSolIx(user)];
  }
}
