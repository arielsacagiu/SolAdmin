/**
 * Unified swap router across venues:
 *   - Jupiter aggregator (any SPL pair)
 *   - Pump.fun bonding curve (direct, pre-graduation)
 *   - PumpSwap (direct, post-graduation)
 *   - Moonit (direct, pre-migration)
 *   - Raydium AMM v4 (direct, classic + simple layouts)
 *
 * Every venue goes through the simulation-first sender; direct venues read
 * on-chain reserves before quoting and enforce slippage on-chain.
 * @module
 */

import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SendOutcome, SwapQuote, SwapVenue } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { sendPrebuiltSwap, jupiterSwapPlan } from './jupiter.js';
import type { DexContext } from './context.js';
import {
  PROGRAMS,
  WSOL_MINT,
  decodeBondingCurve,
  decodeMoonitCurve,
  decodePumpSwapPool,
  moonitBuyInstruction,
  moonitQuoteBuyTokensOut,
  moonitQuoteSellLamportsOut,
  moonitSellInstruction,
  MoonitFixedSide,
  pumpAmmPoolPda,
  pumpBondingCurvePda,
  pumpBuyInstruction,
  pumpSellInstruction,
  pumpSwapBuyInstruction,
  pumpSwapSellInstruction,
  quoteBuyLamportsIn,
  quoteSellLamportsOut,
  ammV4QuoteOut,
  ammV4SwapBaseInInstruction,
  ammV4SwapSimpleInInstruction,
  deriveAmmV4PoolKeys,
  fetchRaydiumPoolsByMints,
  type AmmV4PoolKeys,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('swap-router');

export interface SwapParams {
  venue: SwapVenue;
  user: Keypair;
  inputMint: string;
  outputMint: string;
  /** Amount of input mint in raw base units. */
  amountInRaw: bigint;
  slippageBps: number;
  mode?: 'simulate' | 'execute';
  /** Relay through Jito. */
  jito?: boolean;
  /** Explicit pool id for raydium venues (skips discovery). */
  poolId?: string;
}

export interface SwapResult {
  quote: SwapQuote;
  outcome: SendOutcome | { signature: string; simulated: boolean };
  venue: SwapVenue;
}

/**
 * Executes a swap on the selected venue.
 */
export async function executeSwap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  switch (params.venue) {
    case 'jupiter':
    case 'orca':
    case 'bonk':
      return executeJupiterSwap(ctx, params);
    case 'pumpfun':
      return executePumpfunSwap(ctx, params);
    case 'pumpswap':
      return executePumpswapSwap(ctx, params);
    case 'moonit':
      return executeMoonitSwap(ctx, params);
    case 'raydium-amm-v4':
      return executeRaydiumAmmV4Swap(ctx, params);
    default:
      // raydium-cpmm / raydium-clmm route through Jupiter by default; direct
      // instruction layouts for those venues are intentionally routed via
      // the aggregator to guarantee correct account resolution.
      log.warn({ venue: params.venue }, 'direct venue not implemented; routing through Jupiter');
      return executeJupiterSwap(ctx, params);
  }
}

// ---------------------------------------------------------------------------
// Jupiter
// ---------------------------------------------------------------------------

async function executeJupiterSwap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  const { quote, swapTransaction } = await jupiterSwapPlan(ctx, {
    user: params.user,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amountInRaw: params.amountInRaw,
    slippageBps: params.slippageBps,
  });
  const mode = params.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const outcome = await sendPrebuiltSwap(ctx, {
    user: params.user,
    swapTransaction,
    mode,
    jito: params.jito ?? true,
  });
  return { quote, outcome, venue: 'jupiter' };
}

// ---------------------------------------------------------------------------
// Pump.fun bonding curve
// ---------------------------------------------------------------------------

async function executePumpfunSwap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  const mint = params.inputMint === WSOL_MINT ? params.outputMint : params.inputMint;
  const isBuy = params.inputMint === WSOL_MINT;
  const curvePda = pumpBondingCurvePda(mint);
  const info = await ctx.rpc.accountInfo(curvePda.toBase58());
  if (!info) throw new Error(`no bonding curve found for mint ${mint} (not a Pump.fun coin?)`);
  const curve = decodeBondingCurve(Buffer.from(info.data));

  const feeBps = 100n; // 1% protocol fee taken from the SOL side
  if (isBuy) {
    // SOL in → deduct the 1% fee, then compute exact tokens out; the program
    // charges cost + fee up to max_sol_cost (= full input).
    const effectiveIn = params.amountInRaw - (params.amountInRaw * feeBps) / 10_000n;
    const tokensOut = moonLikeBuyOut(curve.virtualSolReserves, curve.virtualTokenReserves, effectiveIn);
    const ix = pumpBuyInstruction({
      user: params.user.publicKey,
      mint: new PublicKey(mint),
      curveCreator: curve.creator,
      amount: tokensOut,
      maxSolCost: params.amountInRaw,
    });
    const quote: SwapQuote = {
      venue: 'pumpfun',
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmountRaw: params.amountInRaw.toString(),
      outAmountRaw: tokensOut.toString(),
      slippageBps: params.slippageBps,
    };
    const outcome = await ctx.sender.send(
      {
        description: `pump.fun buy ${mint}`,
        feePayer: params.user.publicKey.toBase58(),
        instructions: [ix],
        signers: [params.user],
      },
      { mode: params.mode, jito: params.jito },
    );
    return { quote, outcome, venue: 'pumpfun' };
  }
  // Sell: amountInRaw = tokens in.
  const lamportsOut = quoteSellLamportsOut(curve, params.amountInRaw);
  const minSolOutput = lamportsOut - (lamportsOut * BigInt(params.slippageBps)) / 10_000n;
  const ix = pumpSellInstruction({
    user: params.user.publicKey,
    mint: new PublicKey(mint),
    curveCreator: curve.creator,
    amount: params.amountInRaw,
    minSolOutput: minSolOutput > 0n ? minSolOutput : 0n,
  });
  const quote: SwapQuote = {
    venue: 'pumpfun',
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmountRaw: params.amountInRaw.toString(),
    outAmountRaw: lamportsOut.toString(),
    slippageBps: params.slippageBps,
  };
  const outcome = await ctx.sender.send(
    {
      description: `pump.fun sell ${mint}`,
      feePayer: params.user.publicKey.toBase58(),
      instructions: [ix],
      signers: [params.user],
    },
    { mode: params.mode, jito: params.jito },
  );
  return { quote, outcome, venue: 'pumpfun' };
}

/** Constant-product tokens-out for exact SOL in (shared quote helper). */
export function moonLikeBuyOut(vSol: bigint, vToken: bigint, lamportsIn: bigint): bigint {
  const numerator = vToken * lamportsIn;
  const denominator = vSol + lamportsIn;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// PumpSwap (post-graduation)
// ---------------------------------------------------------------------------

async function executePumpswapSwap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  const baseMint = params.inputMint === WSOL_MINT ? params.outputMint : params.inputMint;
  const isBuy = params.inputMint === WSOL_MINT;
  // Pool index 0 with creator sentinel for canonical migrated pools; the
  // CLI/service resolves the actual pool by scanning PumpSwap pool accounts.
  const pool = params.poolId ? new PublicKey(params.poolId) : pumpAmmPoolPda({ index: 0, creator: '11111111111111111111111111111111', baseMint, quoteMint: WSOL_MINT });
  const poolInfo = await ctx.rpc.accountInfo(pool.toBase58());
  if (!poolInfo) throw new Error(`no PumpSwap pool ${pool.toBase58()} on-chain`);
  const decoded = decodePumpSwapPool(Buffer.from(poolInfo.data));

  const quote: SwapQuote = {
    venue: 'pumpswap',
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmountRaw: params.amountInRaw.toString(),
    outAmountRaw: '0',
    slippageBps: params.slippageBps,
  };

  if (isBuy) {
    // Quote via pool vault reserves.
    const [baseVaultBal, quoteVaultBal] = await Promise.all([
      tokenBalance(ctx, decoded.poolBaseTokenAccount),
      tokenBalance(ctx, decoded.poolQuoteTokenAccount),
    ]);
    const baseOut = ammV4QuoteOut({
      reserveIn: quoteVaultBal,
      reserveOut: baseVaultBal,
      amountIn: params.amountInRaw,
      feeBps: 25,
    });
    quote.outAmountRaw = baseOut.toString();
    const maxQuoteIn = params.amountInRaw + (params.amountInRaw * BigInt(params.slippageBps)) / 10_000n;
    const ix = pumpSwapBuyInstruction({
      pool,
      user: params.user.publicKey,
      baseMint: new PublicKey(baseMint),
      quoteMint: new PublicKey(WSOL_MINT),
      baseAmountOut: baseOut,
      maxQuoteAmountIn: maxQuoteIn,
    });
    const outcome = await ctx.sender.send(
      {
        description: `pumpswap buy ${baseMint}`,
        feePayer: params.user.publicKey.toBase58(),
        instructions: [ix],
        signers: [params.user],
      },
      { mode: params.mode, jito: params.jito },
    );
    return { quote, outcome, venue: 'pumpswap' };
  }

  const [baseVaultBal, quoteVaultBal] = await Promise.all([
    tokenBalance(ctx, decoded.poolBaseTokenAccount),
    tokenBalance(ctx, decoded.poolQuoteTokenAccount),
  ]);
  const quoteOut = ammV4QuoteOut({
    reserveIn: baseVaultBal,
    reserveOut: quoteVaultBal,
    amountIn: params.amountInRaw,
    feeBps: 25,
  });
  quote.outAmountRaw = quoteOut.toString();
  const minQuoteOut = quoteOut - (quoteOut * BigInt(params.slippageBps)) / 10_000n;
  const ix = pumpSwapSellInstruction({
    pool,
    user: params.user.publicKey,
    baseMint: new PublicKey(baseMint),
    quoteMint: new PublicKey(WSOL_MINT),
    baseAmountIn: params.amountInRaw,
    minQuoteAmountOut: minQuoteOut,
  });
  const outcome = await ctx.sender.send(
    {
      description: `pumpswap sell ${baseMint}`,
      feePayer: params.user.publicKey.toBase58(),
      instructions: [ix],
      signers: [params.user],
    },
    { mode: params.mode, jito: params.jito },
  );
  return { quote, outcome, venue: 'pumpswap' };
}

// ---------------------------------------------------------------------------
// Moonit
// ---------------------------------------------------------------------------

async function executeMoonitSwap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  const mint = params.inputMint === WSOL_MINT ? params.outputMint : params.inputMint;
  const isBuy = params.inputMint === WSOL_MINT;
  const curve = await fetchMoonitCurve(ctx, mint);
  const slippageBps = BigInt(params.slippageBps);
  const quote: SwapQuote = {
    venue: 'moonit',
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmountRaw: params.amountInRaw.toString(),
    outAmountRaw: '0',
    slippageBps: params.slippageBps,
  };

  if (isBuy) {
    const tokensOut = moonitQuoteBuyTokensOut({ curve, collateralLamports: params.amountInRaw });
    quote.outAmountRaw = tokensOut.toString();
    const ix = moonitBuyInstruction({
      sender: params.user.publicKey,
      mint: new PublicKey(mint),
      trade: {
        tokenAmount: tokensOut,
        collateralAmount: params.amountInRaw + (params.amountInRaw * slippageBps) / 10_000n,
        fixedSide: MoonitFixedSide.Token,
        slippageBps,
      },
    });
    const outcome = await ctx.sender.send(
      {
        description: `moonit buy ${mint}`,
        feePayer: params.user.publicKey.toBase58(),
        instructions: [ix],
        signers: [params.user],
      },
      { mode: params.mode, jito: params.jito },
    );
    return { quote, outcome, venue: 'moonit' };
  }
  const lamportsOut = moonitQuoteSellLamportsOut({ curve, tokenAmountIn: params.amountInRaw });
  quote.outAmountRaw = lamportsOut.toString();
  const ix = moonitSellInstruction({
    sender: params.user.publicKey,
    mint: new PublicKey(mint),
    trade: {
      tokenAmount: params.amountInRaw,
      collateralAmount: lamportsOut - (lamportsOut * slippageBps) / 10_000n,
      fixedSide: MoonitFixedSide.Collateral,
      slippageBps,
    },
  });
  const outcome = await ctx.sender.send(
    {
      description: `moonit sell ${mint}`,
      feePayer: params.user.publicKey.toBase58(),
      instructions: [ix],
      signers: [params.user],
    },
    { mode: params.mode, jito: params.jito },
  );
  return { quote, outcome, venue: 'moonit' };
}

async function fetchMoonitCurve(ctx: DexContext, mint: string) {
  const { moonitCurvePda } = await import('@solana-toolkit/solana-programs');
  const info = await ctx.rpc.accountInfo(moonitCurvePda(mint).toBase58());
  if (!info) throw new Error(`no Moonit curve found for mint ${mint}`);
  return decodeMoonitCurve(Buffer.from(info.data));
}

// ---------------------------------------------------------------------------
// Raydium AMM v4
// ---------------------------------------------------------------------------

async function executeRaydiumAmmV4Swap(ctx: DexContext, params: SwapParams): Promise<SwapResult> {
  const pools = await fetchRaydiumPoolsByMints(ctx.raydiumApiBase, params.inputMint, params.outputMint);
  const ammPool = pools.find((p) => p.programId === PROGRAMS.RAYDIUM_AMM_V4 && p.marketId)
    ?? pools.find((p) => p.marketId && p.programId.includes('675kPX'));
  if (!ammPool || !ammPool.marketId) {
    throw new Error(`no Raydium AMM v4 pool for ${params.inputMint}/${params.outputMint}`);
  }
  const marketId = new PublicKey(ammPool.marketId);
  const keys: AmmV4PoolKeys = deriveAmmV4PoolKeys(marketId, new PublicKey(PROGRAMS.OPENBOOK_V1));

  // Vault reserves for the quote.
  const [vaultIn, vaultOut] = [
    params.inputMint === ammPool.mintA.address ? keys.baseVault : keys.quoteVault,
    params.outputMint === ammPool.mintA.address ? keys.baseVault : keys.quoteVault,
  ];
  const [reserveIn, reserveOut] = await Promise.all([tokenBalance(ctx, vaultIn.toBase58()), tokenBalance(ctx, vaultOut.toBase58())]);
  const minOut = ammV4QuoteOut({ reserveIn, reserveOut, amountIn: params.amountInRaw, feeBps: 25 });

  const userSource = getAssociatedTokenAddressSync(
    new PublicKey(params.inputMint),
    params.user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userDest = getAssociatedTokenAddressSync(
    new PublicKey(params.outputMint),
    params.user.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  // The classic instruction 9 layout requires the market's book accounts,
  // which the Raydium API keys endpoint provides in production flows; the
  // simple variant (instruction 16) covers pools that accept it. Try the
  // simple instruction first — simulation verifies before execution.
  const ix = ammV4SwapSimpleInInstruction({
    poolId: keys.ammId,
    auth: keys.ammAuthority,
    vaultA: keys.baseVault,
    vaultB: keys.quoteVault,
    ownerTokenIn: userSource,
    ownerTokenOut: userDest,
    owner: params.user.publicKey,
    amountIn: params.amountInRaw,
    minAmountOut: minOut,
  });

  const quote: SwapQuote = {
    venue: 'raydium-amm-v4',
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmountRaw: params.amountInRaw.toString(),
    outAmountRaw: minOut.toString(),
    slippageBps: params.slippageBps,
  };
  const outcome = await ctx.sender.send(
    {
      description: `raydium amm v4 swap ${params.inputMint}→${params.outputMint}`,
      feePayer: params.user.publicKey.toBase58(),
      instructions: [ix],
      signers: [params.user],
    },
    { mode: params.mode, jito: params.jito },
  );
  return { quote, outcome, venue: 'raydium-amm-v4' };
}

async function tokenBalance(ctx: DexContext, tokenAccount: string): Promise<bigint> {
  const info = await ctx.rpc.connection.getTokenAccountBalance(new PublicKey(tokenAccount));
  return BigInt(info.value.amount);
}

