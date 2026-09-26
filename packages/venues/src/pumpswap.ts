/**
 * PumpSwap (pump_amm) adapter — the constant-product AMM that pump.fun tokens
 * graduate to. Direct program calls; no third-party SDK.
 *
 * Verified on-chain constants:
 *   program            pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *   global_config      ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
 *   protocol fee rcpt  62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV
 *   protocol fee ATA   94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb
 *   event_authority    GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR
 *   global vol. accum. C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw
 *   fee_config PDA     5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx
 *   fee program        pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ (shared w/ pump.fun)
 *
 * Pool account layout (301-byte full variant; offsets verified on-chain):
 *   disc(8) bump(1) index(2) creator(32) base_mint(32)@43 quote_mint(32)@75
 *   lp_mint(32)@107 pool_base_ata(32)@139 pool_quote_ata(32)@171
 *   lp_supply(8)@203 coin_creator(32)@211 is_mayhem(1)@243
 *
 * Pool accounts are NOT PDAs — discovered via getProgramAccounts memcmp on
 * base_mint/quote_mint. Reserves live in the pool's two vault ATAs.
 * Fees: 20bps LP + 5bps protocol (+ creator share) — priced with a buffer.
 * @module
 */

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger, retry } from '@solana-toolkit/utils';
import {
  WSOL_MINT,
  anchorAccountDiscriminator,
  anchorIxDiscriminator,
  ata,
  constantProductIn,
  constantProductOut,
  ensureAtaIx,
  fetchAccountData,
  fetchTokenAmount,
  readPubkey,
  readU64,
  u64le,
  unwrapSolIx,
  wrapSolIxs,
} from './common.js';
import type { RoundTripQuote, SwapIxSet, VenueAdapter, VenueContext } from './types.js';

const log = moduleLogger('venue.pumpswap');

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMPSWAP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMPSWAP_PROTOCOL_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const PUMPSWAP_PROTOCOL_FEE_ATA = new PublicKey('94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb');
export const PUMPSWAP_EVENT_AUTHORITY = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey('C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw');
export const PUMPSWAP_FEE_CONFIG = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
export const PUMPSWAP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

export const PUMPSWAP_POOL_DISCRIMINATOR = anchorAccountDiscriminator('Pool'); // f19a6d0411b16dbc
export const PUMPSWAP_BUY_DISC = anchorIxDiscriminator('buy'); // 66063d1201daebea
export const PUMPSWAP_SELL_DISC = anchorIxDiscriminator('sell'); // 33e685a4017f83ad

/** Conservative total fee buffer: 20bps LP + 5bps protocol + creator share. */
export const PUMPSWAP_FEE_BPS = 30n;

/** Parsed PumpSwap pool account (fields at verified offsets). */
export interface PumpSwapPool {
  bump: number;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
}

export interface PumpSwapContext extends VenueContext {
  kind: 'pumpswap';
  state: {
    pool: PumpSwapPool;
    baseReserves: bigint;
    quoteReserves: bigint;
  };
}

export function parsePumpSwapPool(data: Buffer): PumpSwapPool {
  if (data.length < 244) throw new Error(`pumpswap pool account too short: ${data.length}`);
  return {
    bump: data[8]!,
    index: data.readUInt16LE(9),
    creator: readPubkey(data, 11),
    baseMint: readPubkey(data, 43),
    quoteMint: readPubkey(data, 75),
    lpMint: readPubkey(data, 107),
    poolBaseTokenAccount: readPubkey(data, 139),
    poolQuoteTokenAccount: readPubkey(data, 171),
    lpSupply: readU64(data, 203),
    coinCreator: readPubkey(data, 211),
    isMayhemMode: data[243] !== 0,
  };
}

/** creator_vault authority PDA: ["creator_vault", coin_creator] under pAMM. */
export function pumpswapCreatorVaultAuthority(coinCreator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM_ID,
  )[0];
}

/** user_volume_accumulator PDA: ["user_volume_accumulator", user] under the fee program. */
export function pumpswapUserVolumeAccumulator(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMPSWAP_FEE_PROGRAM,
  )[0];
}

/**
 * Discovers the PumpSwap pool for a mint via a getProgramAccounts memcmp
 * filter on base_mint (offset 43) — quote is always WSOL on canonical pools.
 */
export async function findPumpSwapPool(
  rpc: SolanaRpcClient,
  baseMint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): Promise<{ address: PublicKey; pool: PumpSwapPool } | null> {
  const accounts = await retry(
    () =>
      rpc.connection.getProgramAccounts(PUMPSWAP_PROGRAM_ID, {
        filters: [
          { memcmp: { offset: 43, bytes: baseMint.toBase58() } },
          { memcmp: { offset: 75, bytes: quoteMint.toBase58() } },
        ],
        dataSlice: { offset: 0, length: 244 },
      }),
    { retries: 3, label: 'pumpswap pool scan' },
  );
  if (accounts.length === 0) return null;
  // Multiple pools can exist (custom creators); pick the first — callers that
  // care about liquidity can compare vault balances afterwards.
  const { pubkey, account } = accounts[0]!;
  return { address: pubkey, pool: parsePumpSwapPool(Buffer.from(account.data)) };
}

interface PumpSwapAccounts {
  pool: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  userBaseAta: PublicKey;
  userQuoteAta: PublicKey;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
  coinCreatorVaultAta: PublicKey;
  coinCreatorVaultAuthority: PublicKey;
  userVolumeAccumulator: PublicKey;
}

/** PumpSwap `buy` — 23 accounts (order from the official pump_amm IDL). */
export function buildPumpSwapBuyIx(
  a: PumpSwapAccounts,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
  trackVolume = true,
): TransactionInstruction {
  const keys = accountMetas(a);
  const data = Buffer.concat([
    PUMPSWAP_BUY_DISC,
    u64le(baseAmountOut),
    u64le(maxQuoteAmountIn),
    Buffer.from([trackVolume ? 1 : 0]), // OptionBool track_volume
  ]);
  return new TransactionInstruction({ keys, programId: PUMPSWAP_PROGRAM_ID, data });
}

/** PumpSwap `sell` — same 23 accounts, args (base_amount_in, min_quote_amount_out). */
export function buildPumpSwapSellIx(
  a: PumpSwapAccounts,
  baseAmountIn: bigint,
  minQuoteAmountOut: bigint,
): TransactionInstruction {
  const keys = accountMetas(a);
  const data = Buffer.concat([PUMPSWAP_SELL_DISC, u64le(baseAmountIn), u64le(minQuoteAmountOut)]);
  return new TransactionInstruction({ keys, programId: PUMPSWAP_PROGRAM_ID, data });
}

function accountMetas(a: PumpSwapAccounts) {
  return [
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.user, isSigner: true, isWritable: true },
    { pubkey: PUMPSWAP_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: a.baseMint, isSigner: false, isWritable: false },
    { pubkey: a.quoteMint, isSigner: false, isWritable: false },
    { pubkey: a.userBaseAta, isSigner: false, isWritable: true },
    { pubkey: a.userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: a.poolBaseAta, isSigner: false, isWritable: true },
    { pubkey: a.poolQuoteAta, isSigner: false, isWritable: true },
    { pubkey: PUMPSWAP_PROTOCOL_FEE_RECIPIENT, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROTOCOL_FEE_ATA, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: a.coinCreatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: a.coinCreatorVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
    { pubkey: a.userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: PUMPSWAP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },
  ];
}

export class PumpSwapVenue implements VenueAdapter<PumpSwapContext> {
  readonly kind = 'pumpswap' as const;

  constructor(readonly rpc: SolanaRpcClient) {}

  async resolve(mint: PublicKey): Promise<PumpSwapContext> {
    const found = await findPumpSwapPool(this.rpc, mint);
    if (!found) {
      throw new Error(`pumpswap: no WSOL pool found for mint ${mint.toBase58()}`);
    }
    const [baseReserves, quoteReserves] = await Promise.all([
      fetchTokenAmount(this.rpc, found.pool.poolBaseTokenAccount),
      fetchTokenAmount(this.rpc, found.pool.poolQuoteTokenAccount),
    ]);
    if (baseReserves === 0n || quoteReserves === 0n) {
      throw new Error(`pumpswap: pool ${found.address.toBase58()} has empty reserves`);
    }
    return {
      kind: 'pumpswap',
      mint: mint.toBase58(),
      poolAddress: found.address.toBase58(),
      state: { pool: found.pool, baseReserves, quoteReserves },
      label: `pumpswap pool ${found.address.toBase58()}`,
    };
  }

  async refresh(ctx: PumpSwapContext): Promise<PumpSwapContext> {
    return this.resolve(new PublicKey(ctx.mint));
  }

  quoteSolForTokens(ctx: PumpSwapContext, tokensOut: bigint): bigint {
    return constantProductIn(tokensOut, ctx.state.quoteReserves, ctx.state.baseReserves, PUMPSWAP_FEE_BPS);
  }

  quoteTokensForSol(ctx: PumpSwapContext, solLamports: bigint): bigint {
    return constantProductOut(solLamports, ctx.state.quoteReserves, ctx.state.baseReserves, PUMPSWAP_FEE_BPS);
  }

  quoteSolForTokenSell(ctx: PumpSwapContext, tokensIn: bigint): bigint {
    return constantProductOut(tokensIn, ctx.state.baseReserves, ctx.state.quoteReserves, PUMPSWAP_FEE_BPS);
  }

  private accounts(ctx: PumpSwapContext, user: PublicKey): PumpSwapAccounts {
    const p = ctx.state.pool;
    const coinCreatorVaultAuthority = pumpswapCreatorVaultAuthority(p.coinCreator);
    return {
      pool: new PublicKey(ctx.poolAddress),
      user,
      baseMint: p.baseMint,
      quoteMint: p.quoteMint,
      userBaseAta: ata(user, p.baseMint, TOKEN_PROGRAM_ID),
      userQuoteAta: ata(user, p.quoteMint, TOKEN_PROGRAM_ID),
      poolBaseAta: p.poolBaseTokenAccount,
      poolQuoteAta: p.poolQuoteTokenAccount,
      coinCreatorVaultAta: ata(coinCreatorVaultAuthority, p.quoteMint, TOKEN_PROGRAM_ID),
      coinCreatorVaultAuthority,
      userVolumeAccumulator: pumpswapUserVolumeAccumulator(user),
    };
  }

  async quoteRoundTrip(ctx: PumpSwapContext, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote> {
    const slip = BigInt(slippageBps);
    const tokensOut = this.quoteTokensForSol(ctx, solLamports);
    const expectedSolIn = this.quoteSolForTokens(ctx, tokensOut);
    const maxSolIn = (expectedSolIn * (10_000n + slip)) / 10_000n;
    const expectedSolOut = this.quoteSolForTokenSell(ctx, tokensOut);
    const minSolOut = (expectedSolOut * (10_000n - slip)) / 10_000n;
    return {
      venue: 'pumpswap',
      maxSolIn,
      expectedSolIn,
      tokensOut,
      expectedSolOut,
      minSolOut,
      expectedCostLamports: expectedSolIn > expectedSolOut ? expectedSolIn - expectedSolOut : 0n,
      quotedAt: Date.now(),
    };
  }

  /**
   * Buy: wrap `maxSolIn` into WSOL, ensure base ATA, then exact-OUT buy.
   * Caller appends {@link cleanupIxs} after the sell leg to unwrap.
   */
  async buyIxs(ctx: PumpSwapContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user);
    return {
      instructions: [
        ...wrapSolIxs(user, user, quote.maxSolIn),
        ensureAtaIx(user, user, a.baseMint, TOKEN_PROGRAM_ID),
        buildPumpSwapBuyIx(a, quote.tokensOut, quote.maxSolIn),
      ],
    };
  }

  async sellIxs(ctx: PumpSwapContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user);
    return { instructions: [buildPumpSwapSellIx(a, quote.tokensOut, quote.minSolOut)] };
  }

  async sellTokensIxs(ctx: PumpSwapContext, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet> {
    const est = this.quoteSolForTokenSell(ctx, tokensIn);
    const minSolOut = (est * (10_000n - BigInt(slippageBps))) / 10_000n;
    const a = this.accounts(ctx, user);
    return { instructions: [buildPumpSwapSellIx(a, tokensIn, minSolOut), unwrapSolIx(user)] };
  }

  cleanupIxs(_ctx: PumpSwapContext, user: PublicKey): TransactionInstruction[] {
    return [unwrapSolIx(user)];
  }
}
