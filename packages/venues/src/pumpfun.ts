/**
 * Pump.fun bonding-curve adapter — direct calls to the official Pump.fun
 * program (no third-party SDK).
 *
 * Verified on-chain constants (pinned against real landed transactions):
 *   program                 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   fee program             pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
 *   global PDA              4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
 *   event authority PDA     Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1
 *   fee_config PDA          8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt
 *     = PDA["fee_config", PUMP_PROGRAM] under the pump_fees program
 *   global volume accum.    Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y
 *     = PDA["global_volume_accumulator"] under the pump program
 *   default fee collector   62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV
 *
 * Curve account layout (81 bytes minimum):
 *   disc(8) vTokenReserves(8) vSolReserves(8) realTokenReserves(8)
 *   realSolReserves(8) tokenTotalSupply(8) complete(1) creator(32)
 *
 * Fees: 0.95% protocol + 0.30% creator = 1.25% total on each side.
 * @module
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger } from '@solana-toolkit/utils';
import {
  anchorIxDiscriminator,
  ata,
  ensureAtaIx,
  fetchAccountData,
  readPubkey,
  readU64,
} from './common.js';
import type { RoundTripQuote, SwapIxSet, VenueAdapter, VenueContext } from './types.js';

const log = moduleLogger('venue.pumpfun');

export const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMPFUN_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMPFUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMPFUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMPFUN_FEE_CONFIG = new PublicKey('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
export const PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey('Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
export const PUMPFUN_DEFAULT_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

/** Total fee charged per trade side: 0.95% protocol + 0.30% creator. */
export const PUMPFUN_TOTAL_FEE_BPS = 125n;

export const PUMPFUN_BUY_DISC = anchorIxDiscriminator('buy'); // 66063d1201daebea
export const PUMPFUN_SELL_DISC = anchorIxDiscriminator('sell'); // 33e685a4017f83ad

/** Parsed bonding-curve state. */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** True once the coin graduated to PumpSwap — the curve no longer trades. */
  complete: boolean;
  /** Coin creator — seeds the creator_vault PDA. */
  creator: PublicKey;
}

export interface PumpfunContext extends VenueContext {
  kind: 'pumpfun';
  state: BondingCurveState;
}

export function pumpfunBondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}

export function pumpfunCreatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}

export function pumpfunUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMPFUN_PROGRAM_ID,
  )[0];
}

/** Decodes a bonding-curve account. Throws on missing/short/foreign data. */
export function parseBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < 81) throw new Error(`bonding curve account too short: ${data.length}`);
  return {
    virtualTokenReserves: readU64(data, 8),
    virtualSolReserves: readU64(data, 16),
    realTokenReserves: readU64(data, 24),
    realSolReserves: readU64(data, 32),
    tokenTotalSupply: readU64(data, 40),
    complete: data[48] !== 0,
    creator: readPubkey(data, 49),
  };
}

/**
 * Tokens received for `solLamports` spent (exact-IN). Mirrors the curve's
 * integer math: the 1.25% fee is taken off the SOL before the curve output.
 */
export function pumpfunTokensForSol(state: BondingCurveState, solLamports: bigint): bigint {
  if (solLamports <= 0n) return 0n;
  const net = (solLamports * (10_000n - PUMPFUN_TOTAL_FEE_BPS)) / 10_000n;
  return (state.virtualTokenReserves * net) / (state.virtualSolReserves + net);
}

/**
 * Lamports needed to buy exactly `tokensOut` (exact-OUT). Inverse of the
 * curve with the fee added on top — includes a +1 lamport rounding guard.
 */
export function pumpfunSolForTokens(state: BondingCurveState, tokensOut: bigint): bigint {
  if (tokensOut <= 0n || state.virtualTokenReserves <= tokensOut) return 0n;
  const gross =
    (tokensOut * state.virtualSolReserves) / (state.virtualTokenReserves - tokensOut) + 1n;
  return (gross * 10_000n) / (10_000n - PUMPFUN_TOTAL_FEE_BPS) + 1n;
}

/** Lamports received for selling `tokensIn` (post-fee). */
export function pumpfunSolForTokenSell(state: BondingCurveState, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross =
    (tokensIn * state.virtualSolReserves) / (state.virtualTokenReserves + tokensIn);
  return (gross * (10_000n - PUMPFUN_TOTAL_FEE_BPS)) / 10_000n;
}

interface BuyAccounts {
  feeRecipient: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  user: PublicKey;
  tokenProgram: PublicKey;
  creatorVault: PublicKey;
}

/**
 * Legacy `buy` — 16 accounts (post fee-program layout):
 *   global, fee_recipient(w), mint, bonding_curve(w), associated_bonding_curve(w),
 *   associated_user(w), user(w,s), system_program, token_program, creator_vault(w),
 *   event_authority, program, global_volume_accumulator,
 *   user_volume_accumulator(w), fee_config, fee_program
 */
export function buildPumpfunBuyIx(a: BuyAccounts, tokensOut: bigint, maxSolCost: bigint): TransactionInstruction {
  const keys = [
    { pubkey: PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: a.feeRecipient, isSigner: false, isWritable: true },
    { pubkey: a.mint, isSigner: false, isWritable: false },
    { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
    { pubkey: a.associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: a.associatedUser, isSigner: false, isWritable: true },
    { pubkey: a.user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: a.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: a.creatorVault, isSigner: false, isWritable: true },
    { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
    { pubkey: pumpfunUserVolumeAccumulatorPda(a.user), isSigner: false, isWritable: true },
    { pubkey: PUMPFUN_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([PUMPFUN_BUY_DISC, u64leBuf(tokensOut), u64leBuf(maxSolCost)]);
  return new TransactionInstruction({ keys, programId: PUMPFUN_PROGRAM_ID, data });
}

/**
 * Legacy `sell` — 14 accounts. NOTE: `creator_vault` precedes `token_program`
 * (opposite of buy) and there are no volume accumulators.
 */
export function buildPumpfunSellIx(a: Omit<BuyAccounts, never>, tokensIn: bigint, minSolOut: bigint): TransactionInstruction {
  const keys = [
    { pubkey: PUMPFUN_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: a.feeRecipient, isSigner: false, isWritable: true },
    { pubkey: a.mint, isSigner: false, isWritable: false },
    { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
    { pubkey: a.associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: a.associatedUser, isSigner: false, isWritable: true },
    { pubkey: a.user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: a.creatorVault, isSigner: false, isWritable: true },
    { pubkey: a.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([PUMPFUN_SELL_DISC, u64leBuf(tokensIn), u64leBuf(minSolOut)]);
  return new TransactionInstruction({ keys, programId: PUMPFUN_PROGRAM_ID, data });
}

function u64leBuf(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

export class PumpfunVenue implements VenueAdapter<PumpfunContext> {
  readonly kind = 'pumpfun' as const;

  constructor(readonly rpc: SolanaRpcClient) {}

  async resolve(mint: PublicKey): Promise<PumpfunContext> {
    const bondingCurve = pumpfunBondingCurvePda(mint);
    const data = await fetchAccountData(this.rpc, bondingCurve);
    if (!data) {
      throw new Error(`pump.fun: no bonding curve for mint ${mint.toBase58()} (never created or already graduated)`);
    }
    const state = parseBondingCurve(data);
    if (state.complete) {
      throw new Error(`pump.fun: bonding curve for ${mint.toBase58()} is complete — use the pumpswap venue`);
    }
    return {
      kind: 'pumpfun',
      mint: mint.toBase58(),
      poolAddress: bondingCurve.toBase58(),
      state,
      label: `pump.fun bonding curve ${bondingCurve.toBase58()}`,
    };
  }

  /**
   * Fee recipient from the Global account (offset 41: disc8 + initialized1 +
   * authority32). Falls back to the current well-known default.
   */
  private async fetchFeeRecipient(): Promise<PublicKey> {
    const data = await fetchAccountData(this.rpc, PUMPFUN_GLOBAL).catch(() => null);
    if (data && data.length >= 73) return readPubkey(data, 41);
    return PUMPFUN_DEFAULT_FEE_RECIPIENT;
  }

  async refresh(ctx: PumpfunContext): Promise<PumpfunContext> {
    return this.resolve(new PublicKey(ctx.mint));
  }

  quoteSolForTokens(ctx: PumpfunContext, tokensOut: bigint): bigint {
    return pumpfunSolForTokens(ctx.state, tokensOut);
  }

  quoteTokensForSol(ctx: PumpfunContext, solLamports: bigint): bigint {
    return pumpfunTokensForSol(ctx.state, solLamports);
  }

  quoteSolForTokenSell(ctx: PumpfunContext, tokensIn: bigint): bigint {
    return pumpfunSolForTokenSell(ctx.state, tokensIn);
  }

  private accounts(ctx: PumpfunContext, user: PublicKey, feeRecipient: PublicKey): BuyAccounts {
    const mint = new PublicKey(ctx.mint);
    const bondingCurve = new PublicKey(ctx.poolAddress);
    const creatorVault = pumpfunCreatorVaultPda(ctx.state.creator);
    return {
      feeRecipient,
      mint,
      bondingCurve,
      associatedBondingCurve: ata(bondingCurve, mint, TOKEN_PROGRAM_ID),
      associatedUser: ata(user, mint, TOKEN_PROGRAM_ID),
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      creatorVault,
    };
  }

  async quoteRoundTrip(ctx: PumpfunContext, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote> {
    const slip = BigInt(slippageBps);
    const tokensOut = this.quoteTokensForSol(ctx, solLamports);
    const expectedSolIn = this.quoteSolForTokens(ctx, tokensOut);
    const maxSolIn = (expectedSolIn * (10_000n + slip)) / 10_000n;
    const expectedSolOut = this.quoteSolForTokenSell(ctx, tokensOut);
    const minSolOut = (expectedSolOut * (10_000n - slip)) / 10_000n;
    return {
      venue: 'pumpfun',
      maxSolIn,
      expectedSolIn,
      tokensOut,
      expectedSolOut,
      minSolOut,
      expectedCostLamports: expectedSolIn > expectedSolOut ? expectedSolIn - expectedSolOut : 0n,
      quotedAt: Date.now(),
    };
  }

  async buyIxs(ctx: PumpfunContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user, await this.fetchFeeRecipient());
    log.debug({ user: user.toBase58(), tokensOut: quote.tokensOut.toString(), maxSolIn: quote.maxSolIn.toString() }, 'pumpfun buy ixs');
    return {
      instructions: [
        ensureAtaIx(user, user, a.mint, TOKEN_PROGRAM_ID),
        buildPumpfunBuyIx(a, quote.tokensOut, quote.maxSolIn),
      ],
    };
  }

  async sellIxs(ctx: PumpfunContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user, await this.fetchFeeRecipient());
    return { instructions: [buildPumpfunSellIx(a, quote.tokensOut, quote.minSolOut)] };
  }

  async sellTokensIxs(ctx: PumpfunContext, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet> {
    const est = this.quoteSolForTokenSell(ctx, tokensIn);
    const minSolOut = (est * (10_000n - BigInt(slippageBps))) / 10_000n;
    const a = this.accounts(ctx, user, await this.fetchFeeRecipient());
    return { instructions: [buildPumpfunSellIx(a, tokensIn, minSolOut)] };
  }
}
