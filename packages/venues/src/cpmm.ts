/**
 * Raydium CPMM adapter — constant-product pools (incl. Token-2022 pairs).
 * Direct program calls, instruction encoding mirrors the public
 * raydium-cp-swap program (IDL-derived, verified on-chain).
 *
 * Verified constants:
 *   program        CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 *   authority PDA  ["vault_and_lp_mint_auth_seed"] = GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL
 *   swap_base_input  disc [143,190,90,218,196,30,51,222]
 *   swap_base_output disc [55,217,98,86,163,74,180,173]
 *
 * Pool account layout (637+ bytes, bincode after 8-byte disc):
 *   amm_config@8 pool_creator@40 token0_vault@72 token1_vault@104
 *   lp_mint@136 token0_mint@168 token1_mint@200 token0_program@232
 *   token1_program@264 observation_key@296 auth_bump@328 status@329
 *   lp_mint_dec@330 mint0_dec@331 mint1_dec@332 lp_supply@333
 *   protocol_fees0@341 protocol_fees1@349 fund_fees0@357 fund_fees1@365
 *   open_time@373 recent_epoch@381 creator_fee_on@389 enable_creator_fee@390
 *   _padding(6)@391 creator_fees0@397 creator_fees1@405
 *
 * Swap accounts (13): payer(w,s), authority, amm_config, pool_state(w),
 *   input_token_account(w), output_token_account(w), input_vault(w),
 *   output_vault(w), input_token_program, output_token_program,
 *   input_token_mint, output_token_mint, observation_state(w)
 *
 * Reserves live in the vault token accounts; accumulated protocol/fund/creator
 * fees are subtracted to get effective reserves.
 * @module
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger, retry } from '@solana-toolkit/utils';
import {
  WSOL_MINT,
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

const log = moduleLogger('venue.cpmm');

export const CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const CPMM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
export const CPMM_SWAP_BASE_INPUT_DISC = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);
export const CPMM_SWAP_BASE_OUTPUT_DISC = Buffer.from([55, 217, 98, 86, 163, 74, 180, 173]);
export const CPMM_FEE_DENOMINATOR = 1_000_000n;
/** Fallback trade fee (0.25%) when the AmmConfig account can't be read. */
export const CPMM_DEFAULT_TRADE_FEE_RATE = 2_500n;

export const CPMM_POOL_MIN_SIZE = 637;

/** Parsed CPMM pool state (offsets verified against the on-chain layout). */
export interface CpmmPoolState {
  ammConfig: PublicKey;
  poolCreator: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  lpMint: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  observationKey: PublicKey;
  authBump: number;
  /** bit2 set = swaps disabled. */
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  creatorFeesToken0: bigint;
  creatorFeesToken1: bigint;
}

export function parseCpmmPoolState(data: Buffer): CpmmPoolState {
  if (data.length < 413) throw new Error(`cpmm pool account too short: ${data.length}`);
  return {
    ammConfig: readPubkey(data, 8),
    poolCreator: readPubkey(data, 40),
    token0Vault: readPubkey(data, 72),
    token1Vault: readPubkey(data, 104),
    lpMint: readPubkey(data, 136),
    token0Mint: readPubkey(data, 168),
    token1Mint: readPubkey(data, 200),
    token0Program: readPubkey(data, 232),
    token1Program: readPubkey(data, 264),
    observationKey: readPubkey(data, 296),
    authBump: data[328]!,
    status: data[329]!,
    lpMintDecimals: data[330]!,
    mint0Decimals: data[331]!,
    mint1Decimals: data[332]!,
    lpSupply: readU64(data, 333),
    protocolFeesToken0: readU64(data, 341),
    protocolFeesToken1: readU64(data, 349),
    fundFeesToken0: readU64(data, 357),
    fundFeesToken1: readU64(data, 365),
    creatorFeeOn: data[389]!,
    enableCreatorFee: data[390] !== 0,
    creatorFeesToken0: readU64(data, 397),
    creatorFeesToken1: readU64(data, 405),
  };
}

/** trade_fee_rate (u64) lives at offset 27 in the AmmConfig account. */
export function parseCpmmTradeFeeRate(ammConfigData: Buffer): bigint {
  if (ammConfigData.length < 35) return CPMM_DEFAULT_TRADE_FEE_RATE;
  const rate = readU64(ammConfigData, 27);
  return rate > 0n && rate < CPMM_FEE_DENOMINATOR ? rate : CPMM_DEFAULT_TRADE_FEE_RATE;
}

export interface CpmmContext extends VenueContext {
  kind: 'cpmm';
  state: {
    pool: CpmmPoolState;
    /** True when our tradable mint is token0 (WSOL = token1). */
    mintIsToken0: boolean;
    /** Effective reserves after subtracting accumulated fees. */
    baseReserves: bigint;
    quoteReserves: bigint;
    /** Fee rate in parts-per-million (AmmConfig denominator 1e6). */
    tradeFeeRate: bigint;
  };
}

/**
 * Finds the CPMM pool for `mint`+WSOL via getProgramAccounts memcmp on the
 * token mints (offsets 168/200). `token1` = WSOL is checked first, then
 * `token0` (mint order is sort-based and not guaranteed).
 */
export async function findCpmmPool(
  rpc: SolanaRpcClient,
  mint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): Promise<{ address: PublicKey; state: CpmmPoolState; mintIsToken0: boolean } | null> {
  const scan = async (t0: PublicKey, t1: PublicKey, mintIsToken0: boolean) => {
    const accounts = await retry(
      () =>
        rpc.connection.getProgramAccounts(CPMM_PROGRAM_ID, {
          filters: [
            { memcmp: { offset: 168, bytes: t0.toBase58() } },
            { memcmp: { offset: 200, bytes: t1.toBase58() } },
          ],
          dataSlice: { offset: 0, length: CPMM_POOL_MIN_SIZE },
        }),
      { retries: 3, label: 'cpmm pool scan' },
    );
    for (const { pubkey, account } of accounts) {
      try {
        return { address: pubkey, state: parseCpmmPoolState(Buffer.from(account.data)), mintIsToken0 };
      } catch {
        continue;
      }
    }
    return null;
  };
  return (await scan(mint, quoteMint, true)) ?? (await scan(quoteMint, mint, false));
}

interface CpmmAccounts {
  pool: PublicKey;
  ammConfig: PublicKey;
  userInAta: PublicKey;
  userOutAta: PublicKey;
  inVault: PublicKey;
  outVault: PublicKey;
  inTokenProgram: PublicKey;
  outTokenProgram: PublicKey;
  inMint: PublicKey;
  outMint: PublicKey;
  observation: PublicKey;
}

function cpmmMetas(a: CpmmAccounts, user: PublicKey) {
  return [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: CPMM_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: a.ammConfig, isSigner: false, isWritable: false },
    { pubkey: a.pool, isSigner: false, isWritable: true },
    { pubkey: a.userInAta, isSigner: false, isWritable: true },
    { pubkey: a.userOutAta, isSigner: false, isWritable: true },
    { pubkey: a.inVault, isSigner: false, isWritable: true },
    { pubkey: a.outVault, isSigner: false, isWritable: true },
    { pubkey: a.inTokenProgram, isSigner: false, isWritable: false },
    { pubkey: a.outTokenProgram, isSigner: false, isWritable: false },
    { pubkey: a.inMint, isSigner: false, isWritable: false },
    { pubkey: a.outMint, isSigner: false, isWritable: false },
    { pubkey: a.observation, isSigner: false, isWritable: true },
  ];
}

/** swap_base_input(amount_in, min_amount_out). */
export function buildCpmmSwapBaseInputIx(
  a: CpmmAccounts,
  user: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: cpmmMetas(a, user),
    programId: CPMM_PROGRAM_ID,
    data: Buffer.concat([CPMM_SWAP_BASE_INPUT_DISC, u64le(amountIn), u64le(minAmountOut)]),
  });
}

/** swap_base_output(max_amount_in, amount_out_less_fee). Exact-OUT. */
export function buildCpmmSwapBaseOutputIx(
  a: CpmmAccounts,
  user: PublicKey,
  maxAmountIn: bigint,
  amountOut: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: cpmmMetas(a, user),
    programId: CPMM_PROGRAM_ID,
    data: Buffer.concat([CPMM_SWAP_BASE_OUTPUT_DISC, u64le(maxAmountIn), u64le(amountOut)]),
  });
}

export class CpmmVenue implements VenueAdapter<CpmmContext> {
  readonly kind = 'cpmm' as const;

  constructor(
    readonly rpc: SolanaRpcClient,
    private readonly opts: { poolAddress?: string } = {},
  ) {}

  async resolve(mint: PublicKey): Promise<CpmmContext> {
    let found: { address: PublicKey; state: CpmmPoolState; mintIsToken0: boolean } | null = null;
    if (this.opts.poolAddress) {
      const address = new PublicKey(this.opts.poolAddress);
      const data = await fetchAccountData(this.rpc, address);
      if (!data) throw new Error(`cpmm: pool ${address.toBase58()} not found`);
      const state = parseCpmmPoolState(data);
      const mintIsToken0 = state.token0Mint.equals(mint);
      if (!mintIsToken0 && !state.token1Mint.equals(mint)) {
        throw new Error(`cpmm: pool ${address.toBase58()} does not contain mint ${mint.toBase58()}`);
      }
      found = { address, state, mintIsToken0 };
    } else {
      found = await findCpmmPool(this.rpc, mint);
    }
    if (!found) throw new Error(`cpmm: no CPMM pool for mint ${mint.toBase58()}`);
    const p = found.state;
    if (p.status & 0b100) throw new Error(`cpmm: pool ${found.address.toBase58()} has swaps disabled`);

    const [v0, v1, cfgData] = await Promise.all([
      fetchTokenAmount(this.rpc, p.token0Vault),
      fetchTokenAmount(this.rpc, p.token1Vault),
      fetchAccountData(this.rpc, p.ammConfig),
    ]);
    const tradeFeeRate = cfgData ? parseCpmmTradeFeeRate(cfgData) : CPMM_DEFAULT_TRADE_FEE_RATE;

    // Effective reserves subtract accumulated protocol/fund/creator fees.
    const eff0 = v0 - p.protocolFeesToken0 - p.fundFeesToken0 - p.creatorFeesToken0;
    const eff1 = v1 - p.protocolFeesToken1 - p.fundFeesToken1 - p.creatorFeesToken1;
    const baseReserves = found.mintIsToken0 ? eff0 : eff1;
    const quoteReserves = found.mintIsToken0 ? eff1 : eff0;
    if (baseReserves <= 0n || quoteReserves <= 0n) {
      throw new Error(`cpmm: pool ${found.address.toBase58()} has empty reserves`);
    }
    return {
      kind: 'cpmm',
      mint: mint.toBase58(),
      poolAddress: found.address.toBase58(),
      state: { pool: p, mintIsToken0: found.mintIsToken0, baseReserves, quoteReserves, tradeFeeRate },
      label: `raydium cpmm pool ${found.address.toBase58()}`,
    };
  }

  async refresh(ctx: CpmmContext): Promise<CpmmContext> {
    return this.resolve(new PublicKey(ctx.mint));
  }

  private feeBps(ctx: CpmmContext): bigint {
    return (ctx.state.tradeFeeRate * 10_000n) / CPMM_FEE_DENOMINATOR;
  }

  quoteSolForTokens(ctx: CpmmContext, tokensOut: bigint): bigint {
    return constantProductIn(tokensOut, ctx.state.quoteReserves, ctx.state.baseReserves, this.feeBps(ctx));
  }

  quoteTokensForSol(ctx: CpmmContext, solLamports: bigint): bigint {
    return constantProductOut(solLamports, ctx.state.quoteReserves, ctx.state.baseReserves, this.feeBps(ctx));
  }

  quoteSolForTokenSell(ctx: CpmmContext, tokensIn: bigint): bigint {
    return constantProductOut(tokensIn, ctx.state.baseReserves, ctx.state.quoteReserves, this.feeBps(ctx));
  }

  private accounts(ctx: CpmmContext, user: PublicKey, direction: 'buy' | 'sell'): CpmmAccounts {
    const p = ctx.state.pool;
    const mint = new PublicKey(ctx.mint);
    const buy = direction === 'buy';
    // buy: in = quote (WSOL/token1 or token0), out = base mint.
    const inMint = buy ? (ctx.state.mintIsToken0 ? p.token1Mint : p.token0Mint) : mint;
    const outMint = buy ? mint : ctx.state.mintIsToken0 ? p.token1Mint : p.token0Mint;
    const inIsToken0 = inMint.equals(p.token0Mint);
    const inProgram = inIsToken0 ? p.token0Program : p.token1Program;
    const outIsToken0 = outMint.equals(p.token0Mint);
    return {
      pool: new PublicKey(ctx.poolAddress),
      ammConfig: p.ammConfig,
      userInAta: ata(user, inMint, inProgram),
      userOutAta: ata(user, outMint, outIsToken0 ? p.token0Program : p.token1Program),
      inVault: inIsToken0 ? p.token0Vault : p.token1Vault,
      outVault: outIsToken0 ? p.token0Vault : p.token1Vault,
      inTokenProgram: inProgram,
      outTokenProgram: outIsToken0 ? p.token0Program : p.token1Program,
      inMint,
      outMint,
      observation: p.observationKey,
    };
  }

  async quoteRoundTrip(ctx: CpmmContext, solLamports: bigint, slippageBps: number): Promise<RoundTripQuote> {
    const slip = BigInt(slippageBps);
    const tokensOut = this.quoteTokensForSol(ctx, solLamports);
    const expectedSolIn = this.quoteSolForTokens(ctx, tokensOut);
    const maxSolIn = (expectedSolIn * (10_000n + slip)) / 10_000n;
    const expectedSolOut = this.quoteSolForTokenSell(ctx, tokensOut);
    const minSolOut = (expectedSolOut * (10_000n - slip)) / 10_000n;
    return {
      venue: 'cpmm',
      maxSolIn,
      expectedSolIn,
      tokensOut,
      expectedSolOut,
      minSolOut,
      expectedCostLamports: expectedSolIn > expectedSolOut ? expectedSolIn - expectedSolOut : 0n,
      quotedAt: Date.now(),
    };
  }

  async buyIxs(ctx: CpmmContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user, 'buy');
    const p = ctx.state.pool;
    return {
      instructions: [
        ...wrapSolIxs(user, user, quote.maxSolIn),
        ensureAtaIx(user, user, new PublicKey(ctx.mint), ctx.state.mintIsToken0 ? p.token0Program : p.token1Program),
        buildCpmmSwapBaseOutputIx(a, user, quote.maxSolIn, quote.tokensOut),
      ],
    };
  }

  async sellIxs(ctx: CpmmContext, user: PublicKey, quote: RoundTripQuote): Promise<SwapIxSet> {
    const a = this.accounts(ctx, user, 'sell');
    return { instructions: [buildCpmmSwapBaseInputIx(a, user, quote.tokensOut, quote.minSolOut)] };
  }

  async sellTokensIxs(ctx: CpmmContext, user: PublicKey, tokensIn: bigint, slippageBps: number): Promise<SwapIxSet> {
    const est = this.quoteSolForTokenSell(ctx, tokensIn);
    const minSolOut = (est * (10_000n - BigInt(slippageBps))) / 10_000n;
    const a = this.accounts(ctx, user, 'sell');
    return { instructions: [buildCpmmSwapBaseInputIx(a, user, tokensIn, minSolOut), unwrapSolIx(user)] };
  }

  cleanupIxs(_ctx: CpmmContext, user: PublicKey): TransactionInstruction[] {
    return [unwrapSolIx(user)];
  }
}
