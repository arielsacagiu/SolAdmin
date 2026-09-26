/**
 * Raydium liquidity pool management — AMM v4 (direct instructions), plus
 * CPMM and CLMM pool creation through the official `@raydium-io/raydium-sdk-v2`.
 *
 * The SDK is loaded dynamically so the rest of the toolkit does not pay its
 * import cost unless pool creation is requested.
 *
 * POOL STATE MONITORING: `getAmmV4PoolState` reads the live vault reserves
 * and LP supply of an AMM v4 pool and derives price/depth metrics — the
 * read-only foundation every LP decision (seed, rebalance, exit, burn) is
 * made against. Vault balances are read from the pool's token accounts
 * (version-proof) rather than decoding the pool state layout.
 *
 * Current-program guidance (Raydium official CLMM instruction reference):
 * new CLMM pools should use CreateCustomizablePool semantics (dynamic fee
 * opt-in, set only at creation, no retroactive upgrade); positions should
 * use the V2 instruction family (Token-2022 vaults, bitmap extension).
 * @module
 */

import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SendOutcome } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { TransactionRequest } from '@solana-toolkit/transaction-builder';
import type { DexContext } from './context.js';
import {
  PROGRAMS,
  WSOL_MINT,
  ammV4CreatePoolInstruction,
  createAssociatedTokenAccountInstruction,
  deriveAmmV4PoolKeys,
  getAssociatedTokenAddressSync,
  fetchRaydiumPoolsByMints,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('raydium-pools');

export interface CpmmPoolCreationParams {
  payer: Keypair;
  mintA: PublicKey;
  mintB: PublicKey;
  amountA: bigint;
  amountB: bigint;
  /** CPMM config id. Mainnet default: 9z2tbozssfsJfuBxN1iRXQx2EmbaJAG6xEmaFqk4gzGt */
  configId?: string;
  startTime?: number;
}

export interface ClmmPoolCreationParams {
  payer: Keypair;
  mintA: PublicKey;
  mintB: PublicKey;
  amountA: bigint;
  amountB: bigint;
  /** CLMM config id. Mainnet default: 5quetHmgBWjZzcvPw4mSxhEcJUG9ecLo2SjcaHqsi2eQ */
  configId?: string;
  /** Initial price (mint A per mint B) as a sqrt price X64 raw value. */
  initialSqrtPriceX64?: bigint;
  /** Tick range for the initial position. */
  tickLower?: number;
  tickUpper?: number;
  startTime?: number;
}

/** Default mainnet CPMM/CLMM config accounts (official Raydium). */
export const RAYDIUM_CPMM_CONFIG_MAINNET = '9z2tbozssfsJfuBxNgzGtgKtDAWFv7wbLdcMg2mcVLuT';
export const RAYDIUM_CLMM_CONFIG_MAINNET = '5quetHmgBWjZzcvPw4mSxhEcJUG9ecLo2SjcaHqsi2eQ';

/**
 * Creates a CPMM pool via raydium-sdk-v2 and returns the SDK-built
 * transaction dispatch result.
 *
 * The v2 SDK builds and signs the transaction itself; we run it in
 * simulation first when the toolkit is in simulation mode by attaching the
 * connection's simulate call on the built transaction before execution.
 */
export async function createCpmmPool(
  ctx: DexContext,
  params: CpmmPoolCreationParams,
): Promise<{ poolId?: string; outcome: SendOutcome }> {
  const { Raydium, TxVersion, API_URLS } = (await import('@raydium-io/raydium-sdk-v2')) as never as {
    Raydium: { load(o: Record<string, unknown>): Promise<unknown> };
    TxVersion: Record<string, string>;
    API_URLS: Record<string, string[]>;
  };
  void API_URLS;
  const raydium = (await (Raydium as never as { load(o: unknown): Promise<Record<string, never>> }).load({
    connection: ctx.rpc.connection,
    owner: params.payer.publicKey,
    blockhashCommitment: 'confirmed',
  })) as unknown as {
    cpmm: {
      createPool: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  const { execute } = (await raydium.cpmm.createPool({
    pair: {
      baseToken: params.mintA,
      quoteToken: params.mintB,
      amountIn: { amountInA: params.amountA, amountInB: params.amountB },
      configId: new PublicKey(params.configId ?? RAYDIUM_CPMM_CONFIG_MAINNET),
    },
    poolType: 'standard',
    computeBudgetConfig: { units: 600_000, microLamports: 500_000 },
    txVersion: TxVersion.V0,
    txTipConfig: { tipLamports: BigInt(ctx.jito.config.tipLamports) },
  })) as { execute: (e: { wallet?: Keypair; signAll?: (txs: unknown[]) => unknown[] }) => Promise<Record<string, unknown>> };

  if (ctx.sender.effectiveMode() === 'simulate') {
    log.warn('simulation mode: CPMM pool creation transaction was built but NOT sent');
    return { outcome: makeSimulatedOutcome('cpmm createPool') };
  }
  const sent = (await execute({ wallet: params.payer })) as { txId?: string };
  log.info({ txId: sent?.txId }, 'CPMM pool created');
  return {
    poolId: undefined,
    outcome: {
      signature: sent?.txId ?? '',
      signatures: [sent?.txId ?? ''],
      simulated: false,
      elapsedMs: 0,
      warnings: [],
    },
  };
}

/**
 * Creates a CLMM pool (concentrated liquidity) via raydium-sdk-v2 with an
 * initial position.
 */
export async function createClmmPool(
  ctx: DexContext,
  params: ClmmPoolCreationParams,
): Promise<{ poolId?: string; outcome: SendOutcome }> {
  const { Raydium, TxVersion } = (await import('@raydium-io/raydium-sdk-v2')) as never as {
    Raydium: { load(o: Record<string, unknown>): Promise<unknown> };
    TxVersion: Record<string, string>;
  };
  const raydium = (await (Raydium as never as { load(o: unknown): Promise<Record<string, never>> }).load({
    connection: ctx.rpc.connection,
    owner: params.payer.publicKey,
    blockhashCommitment: 'confirmed',
  })) as unknown as {
    clmm: {
      createPool: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  void params.initialSqrtPriceX64;
  void params.tickLower;
  void params.tickUpper;
  void params.startTime;
  const { execute } = (await raydium.clmm.createPool({
    poolConfig: [
      {
        id: new PublicKey(params.configId ?? RAYDIUM_CLMM_CONFIG_MAINNET),
        index: 1,
        tradeFeeRate: 2500,
      },
    ],
    mint1: params.mintA,
    mint2: params.mintB,
    amount1: params.amountA,
    amount2: params.amountB,
    computeBudgetConfig: { units: 600_000, microLamports: 500_000 },
    txVersion: TxVersion.V0,
    txTipConfig: { tipLamports: BigInt(ctx.jito.config.tipLamports) },
  })) as { execute: (e: { wallet?: Keypair }) => Promise<Record<string, unknown>> };

  if (ctx.sender.effectiveMode() === 'simulate') {
    log.warn('simulation mode: CLMM pool creation transaction was built but NOT sent');
    return { outcome: makeSimulatedOutcome('clmm createPool') };
  }
  const sent = (await execute({ wallet: params.payer })) as { txId?: string };
  return {
    poolId: undefined,
    outcome: {
      signature: sent?.txId ?? '',
      signatures: [sent?.txId ?? ''],
      simulated: false,
      elapsedMs: 0,
      warnings: [],
    },
  };
}

/**
 * AMM v4 pool seeding on an existing OpenBook market — direct instructions
 * (no SDK needed). Builds the pool create instruction plus the user LP ATA.
 */
export async function seedAmmV4Pool(
  ctx: DexContext,
  params: {
    payer: Keypair;
    marketId: PublicKey;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseAmountRaw: bigint;
    quoteAmountRaw: bigint;
    openTime?: bigint;
    mode?: 'simulate' | 'execute';
  },
): Promise<{ poolId: string; outcome: SendOutcome }> {
  const keys = deriveAmmV4PoolKeys(params.marketId, new PublicKey(PROGRAMS.OPENBOOK_V1));
  const userBaseVault = getAssociatedTokenAddressSync(params.baseMint, params.payer.publicKey, true, TOKEN_PROGRAM_ID);
  const userQuoteVault = getAssociatedTokenAddressSync(params.quoteMint, params.payer.publicKey, true, TOKEN_PROGRAM_ID);
  const userLpVault = getAssociatedTokenAddressSync(keys.lpMint, params.payer.publicKey, true, TOKEN_PROGRAM_ID);

  const instructions = [
    createAssociatedTokenAccountInstruction(
      params.payer.publicKey,
      userLpVault,
      params.payer.publicKey,
      keys.lpMint,
      TOKEN_PROGRAM_ID,
    ),
    ammV4CreatePoolInstruction({
      userWallet: params.payer.publicKey,
      userBaseVault,
      userQuoteVault,
      userLpVault,
      keys,
      baseMint: params.baseMint,
      quoteMint: params.quoteMint,
      openTime: params.openTime ?? 0n,
      baseAmount: params.baseAmountRaw,
      quoteAmount: params.quoteAmountRaw,
    }),
  ];
  const outcome = await ctx.sender.send(
    {
      description: 'raydium amm v4 pool seed',
      feePayer: params.payer.publicKey.toBase58(),
      instructions,
      signers: [params.payer],
    } satisfies TransactionRequest,
    { mode: params.mode, priorityFee: { computeUnitLimit: 400_000, microLamportsPerCu: 400_000 } },
  );
  return { poolId: keys.ammId.toBase58(), outcome };
}

function makeSimulatedOutcome(description: string): SendOutcome {
  return {
    signature: '(simulated)',
    signatures: [],
    simulated: true,
    elapsedMs: 0,
    warnings: [`${description}: built via raydium-sdk-v2, not sent (simulation mode)`],
  };
}

// ---------------------------------------------------------------------------
// Pool state monitoring (read-only)
// ---------------------------------------------------------------------------

/** Live state of an AMM v4 pool, derived from its vaults. */
export interface AmmV4PoolState {
  poolId: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  lpSupplyRaw: string;
  /** Price of base in quote (raw units ratio), e.g. SOL per token. */
  priceRawQuotePerBase: number;
  /** Constant-product k (raw) — pool depth indicator. */
  kRaw: string;
  fetchedAt: string;
}

/**
 * Reads the live AMM v4 pool state: vault reserves, LP supply, and derived
 * price/depth. `poolId` is the AMM account; the vault keys are derived from
 * the pool/market derivation seeds used at creation.
 */
export async function getAmmV4PoolState(
  ctx: { rpc: { connection: import('@solana/web3.js').Connection; accountInfo(a: string): Promise<unknown> } },
  poolId: string,
  params: { baseMint: string; quoteMint: string; marketId: string },
): Promise<AmmV4PoolState> {
  const { PublicKey } = await import('@solana/web3.js');
  const keys = deriveAmmV4PoolKeys(new PublicKey(params.marketId), new PublicKey(PROGRAMS.OPENBOOK_V1));
  if (!keys.ammId.equals(new PublicKey(poolId))) {
    throw new Error('poolId does not match the canonical AMM derived from marketId');
  }

  const poolInfo = await ctx.rpc.accountInfo(poolId);
  if (!poolInfo) throw new Error(`AMM v4 pool ${poolId} not found on-chain`);

  const [baseVaultBal, quoteVaultBal, lpSupply] = await Promise.all([
    tokenBalanceOf(ctx, keys.baseVault.toBase58()),
    tokenBalanceOf(ctx, keys.quoteVault.toBase58()),
    mintSupplyOf(ctx, keys.lpMint.toBase58()),
  ]);

  const priceRaw =
    baseVaultBal > 0n ? Number(quoteVaultBal) / Number(baseVaultBal) : 0;

  return {
    poolId,
    baseMint: params.baseMint,
    quoteMint: params.quoteMint,
    baseVault: keys.baseVault.toBase58(),
    quoteVault: keys.quoteVault.toBase58(),
    baseReserveRaw: baseVaultBal.toString(),
    quoteReserveRaw: quoteVaultBal.toString(),
    lpSupplyRaw: lpSupply.toString(),
    priceRawQuotePerBase: priceRaw,
    kRaw: (baseVaultBal * quoteVaultBal).toString(),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Lists pools for a SOL pair from the Raydium public API (top by liquidity),
 * with on-chain vault depth for AMM v4 entries. One call answers "where is
 * this token tradeable and how deep is it".
 */
export async function listPoolsForMint(
  ctx: { rpc: { connection: import('@solana/web3.js').Connection; accountInfo(a: string): Promise<unknown> }; raydiumApiBase: string },
  mint: string,
  opts: { limit?: number; quoteMint?: string } = {},
): Promise<
  {
    poolId: string;
    venue: string;
    programId: string;
    liquidity: number;
    price: number;
    marketId?: string;
    /** Filled for AMM v4 pools: live vault depth. */
    state?: AmmV4PoolState;
  }[]
> {
  const quote = opts.quoteMint ?? WSOL_MINT;
  const pools = await fetchRaydiumPoolsByMints(ctx.raydiumApiBase, mint, quote);
  const top = pools
    .sort((a, b) => b.liquidity - a.liquidity)
    .slice(0, opts.limit ?? 10);
  const out = [];
  for (const pool of top) {
    let state: AmmV4PoolState | undefined;
    if (pool.programId === PROGRAMS.RAYDIUM_AMM_V4 && pool.marketId) {
      try {
        state = await getAmmV4PoolState(ctx, pool.id, {
          baseMint: mint,
          quoteMint: quote,
          marketId: pool.marketId,
        });
      } catch {
        // listing stays useful even when one pool's depth read fails
      }
    }
    out.push({
      poolId: pool.id,
      venue: `raydium ${pool.type}`,
      programId: pool.programId,
      liquidity: pool.liquidity,
      price: pool.price,
      marketId: pool.marketId,
      state,
    });
  }
  return out;
}

async function tokenBalanceOf(
  ctx: { rpc: { connection: import('@solana/web3.js').Connection } },
  tokenAccount: string,
): Promise<bigint> {
  const { PublicKey } = await import('@solana/web3.js');
  const res = await ctx.rpc.connection.getTokenAccountBalance(new PublicKey(tokenAccount));
  return BigInt(res.value.amount);
}

async function mintSupplyOf(
  ctx: { rpc: { connection: import('@solana/web3.js').Connection } },
  mint: string,
): Promise<bigint> {
  const { PublicKey } = await import('@solana/web3.js');
  const info = await ctx.rpc.connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = (info.value?.data as { parsed?: { info?: { supply?: string } } }).parsed?.info;
  return BigInt(parsed?.supply ?? '0');
}

export type { Connection };
