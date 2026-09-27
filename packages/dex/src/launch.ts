/**
 * Launch + bundled-buy flows.
 *
 *  - Pump.fun Launch + Buy: create coin + up to 28 simultaneous buyer
 *    wallets, bundled through Jito (atomic chunks of ≤5 transactions).
 *  - Moonit Launch + Buy: launch via the official prepareMint API (backend
 *    authority co-signs; the transaction is signed locally), then up to 6
 *    bundled buyers on the bonding curve.
 *  - Raydium AMM v4 launch: OpenBook V1 market creation + AMM v4 pool seeding.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { SendOutcome } from '@solana-toolkit/types';
import { chunk, moduleLogger, sleep } from '@solana-toolkit/utils';
import type { TransactionRequest } from '@solana-toolkit/transaction-builder';
import type { DexContext } from './context.js';
import { moonLikeBuyOut } from './swap.js';
import {
  PROGRAMS,
  WSOL_MINT,
  ammV4CreatePoolInstruction,
  decodeBondingCurve,
  deriveAmmV4PoolKeys,
  openbookV1CreateMarketInstructions,
  prepareSerumMarket,
  pumpBondingCurvePda,
  pumpBuyInstruction,
  pumpCreateInstruction,
  moonitBuyInstruction,
  moonitCurvePda,
  moonitQuoteBuyTokensOut,
  decodeMoonitCurve,
  MoonitFixedSide,
  withRentLamports,
  createAssociatedTokenAccountInstruction,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('launch');

/** Jito bundle hard limit. */
const JITO_BUNDLE_MAX_TXS = 5;

export interface LaunchBuyResult {
  mint: string;
  outcomes: SendOutcome[];
  buyerSignatures: string[];
  simulated: boolean;
}

/**
 * Pump.fun Launch + Buy.
 *
 * MINT PATH (pumpfun): the mint is created by the Pump.fun program itself
 * (`pumpCreateInstruction`, a fresh keypair signs; the token lives in the
 * SPL Token program and trades on the Pump.fun bonding curve). This path is
 * deliberately SEPARATE from `services.createToken`, which creates mints via
 * the SPL Token or Token-2022 programs with configurable extensions — do not
 * merge the two; downstream operations detect the mint's owning program to
 * pick the right token program and quote logic (bonding curve vs AMM pair).
 *
 * The treasury launches the coin; then every buyer wallet (max 28) sends an
 * independent buy transaction. Transactions are bundled through Jito in
 * atomic groups: bundle 1 = create + up to 4 buys, subsequent bundles = up to
 * 5 buys each, submitted sequentially after the previous bundle lands.
 *
 * SECURITY: buyer wallets are pre-funded by the caller (see
 * `services.fundWallets`); only SOL needed for the buy + fees should be held.
 *
 * ANONYMITY: each launch must use a FRESH treasury and FRESH buyer wallets
 * (see `freshLaunchLineage` in market-maker) — never reuse addresses across
 * launches; reuse creates a permanent on-chain link between them.
 */
export async function pumpfunLaunchBuy(
  ctx: DexContext,
  params: {
    treasury: Keypair;
    name: string;
    symbol: string;
    uri: string;
    buyers: Keypair[];
    /** SOL (lamports) each buyer spends on the curve. */
    buyLamportsPerBuyer: bigint;
    slippageBps: number;
    mode?: 'simulate' | 'execute';
  },
): Promise<LaunchBuyResult> {
  if (params.buyers.length === 0 || params.buyers.length > 28) {
    throw new Error(`Pump.fun launch supports 1..28 buyers, got ${params.buyers.length}`);
  }
  const mint = Keypair.generate();
  const mintPk = mint.publicKey;

  // 1. Create instruction (treasury signs; mint keypair signs).
  const create = pumpCreateInstruction({
    user: params.treasury.publicKey,
    mint: mintPk,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    creator: params.treasury.publicKey,
  });

  const createReq: TransactionRequest = {
    description: `pump.fun create ${params.name}`,
    feePayer: params.treasury.publicKey.toBase58(),
    instructions: [create],
    signers: [params.treasury, mint],
  };

  // 2. Compute each buyer's expected tokens from initial reserves:
  //    1,073,000,000 virtual tokens / 30 SOL virtual SOL.
  const vToken = 1_073_000_000_000_000n;
  const vSol = 30_000_000_000n;
  const buyTxs: TransactionRequest[] = params.buyers.map((buyer, i) => {
    const effectiveIn = params.buyLamportsPerBuyer - (params.buyLamportsPerBuyer * 100n) / 10_000n; // 1% fee
    const tokensOut = moonLikeBuyOut(vSol, vToken, effectiveIn);
    const ix = pumpBuyInstruction({
      user: buyer.publicKey,
      mint: mintPk,
      curveCreator: params.treasury.publicKey.toBase58(),
      amount: tokensOut,
      maxSolCost: params.buyLamportsPerBuyer,
    });
    return {
      description: `pump.fun buyer-${i + 1}`,
      feePayer: buyer.publicKey.toBase58(),
      instructions: [ix],
      signers: [buyer],
    } satisfies TransactionRequest;
  });

  // 3. Bundle: create + buys in atomic Jito groups.
  const mode = params.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const groups: TransactionRequest[][] = [];
  const firstGroup: TransactionRequest[] = [createReq, ...buyTxs.slice(0, JITO_BUNDLE_MAX_TXS - 1)];
  groups.push(firstGroup);
  for (const rest of chunk(buyTxs.slice(JITO_BUNDLE_MAX_TXS - 1), JITO_BUNDLE_MAX_TXS)) {
    groups.push(rest);
  }

  const outcomes: SendOutcome[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    log.info({ group: gi + 1, txs: group.length }, 'submitting launch bundle group');
    const outcome = await ctx.sender.sendBundle(group, { mode });
    outcomes.push(outcome);
    if (mode === 'execute' && gi < groups.length - 1) {
      // Give the on-chain state a moment between non-atomic groups.
      await sleep(2_000);
    }
  }

  return {
    mint: mintPk.toBase58(),
    outcomes,
    buyerSignatures: outcomes.flatMap((o) => o.signatures),
    simulated: mode === 'simulate',
  };
}

// ---------------------------------------------------------------------------
// Moonit launch + buy
// ---------------------------------------------------------------------------

/** Moonit API base URLs (official, free). */
export const MOONIT_API_MAINNET = 'https://api.moonit.xyz';
export const MOONIT_API_DEVNET = 'https://api.devnet.moonit.xyz';

export interface MoonitLaunchParams {
  name: string;
  symbol: string;
  description: string;
  imageFilePath: string;
  decimals: number;
  totalSupplyRaw: bigint;
  /** SOL to collect initially on the curve (min 0.02 for flat curve per docs). */
  collateralCollectedLamports: bigint;
  curveType: 'classic' | 'flat';
  twitterLink?: string;
  telegramLink?: string;
  websiteLink?: string;
}

/**
 * Calls Moonit's prepareMint API. The backend authority co-signs the mint
 * transaction (required by the on-chain program); the returned transaction
 * is then signed LOCALLY by the treasury.
 */
export async function moonitPrepareMint(
  params: MoonitLaunchParams,
  creator: PublicKey,
  cluster: 'mainnet' | 'devnet',
): Promise<{ transaction: string; mint?: string }> {
  const base = cluster === 'devnet' ? MOONIT_API_DEVNET : MOONIT_API_MAINNET;
  const res = await fetch(`${base}/api/tokens/prepare-mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      symbol: params.symbol,
      description: params.description,
      imageUrl: params.imageFilePath,
      decimals: params.decimals,
      totalSupply: params.totalSupplyRaw.toString(),
      collateralCollected: params.collateralCollectedLamports.toString(),
      curveType: params.curveType === 'flat' ? 1 : 0,
      migrationTarget: 0,
      twitterLink: params.twitterLink ?? '',
      telegramLink: params.telegramLink ?? '',
      websiteLink: params.websiteLink ?? '',
      creatorPK: creator.toBase58(),
    }),
  });
  if (!res.ok) {
    throw new Error(`Moonit prepareMint failed: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { transaction?: string; tx?: string; mint?: string };
  const tx = json.transaction ?? json.tx;
  if (!tx) throw new Error('Moonit prepareMint returned no transaction');
  return { transaction: tx, mint: json.mint };
}

/**
 * Moonit Launch + Buy: sign the prepared mint transaction locally, submit it,
 * then bundle up to 6 buyer transactions on the fresh curve.
 */
export async function moonitLaunchBuy(
  ctx: DexContext,
  params: {
    treasury: Keypair;
    launch: MoonitLaunchParams;
    buyers: Keypair[];
    buyLamportsPerBuyer: bigint;
    slippageBps: number;
    mode?: 'simulate' | 'execute';
  },
): Promise<LaunchBuyResult> {
  if (params.buyers.length === 0 || params.buyers.length > 6) {
    throw new Error(`Moonit launch supports 1..6 buyers, got ${params.buyers.length}`);
  }
  const cluster = ctx.cluster === 'devnet' ? 'devnet' : 'mainnet';
  const { transaction, mint } = await moonitPrepareMint(params.launch, params.treasury.publicKey, cluster);
  const mintKey = mint ?? extractMintFromTx(transaction);
  const mode = params.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');

  // Sign + submit the launch transaction through the standard sender path.
  const vtx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
  vtx.sign([params.treasury]);
  const launchOutcome: SendOutcome = mode === 'simulate'
    ? { signature: '(simulated)', signatures: [], simulated: true, elapsedMs: 0, warnings: [] }
    : {
        signature: Buffer.from(vtx.signatures[0]!).toString('base64'),
        signatures: [],
        simulated: false,
        elapsedMs: 0,
        warnings: [],
      };
  if (mode === 'execute') {
    await ctx.jito.sendTransaction(Buffer.from(vtx.serialize()).toString('base64'));
    await sleep(4_000); // let the launch land before buys
  }

  // Bundle the buys.
  const curveInfo = await ctx.rpc.accountInfo(moonitCurvePda(mintKey).toBase58());
  const buyTxs: TransactionRequest[] = [];
  for (const buyer of params.buyers) {
    const effectiveIn = params.buyLamportsPerBuyer;
    let tokensOut: bigint;
    if (curveInfo) {
      const curve = decodeMoonitCurve(Buffer.from(curveInfo.data));
      tokensOut = moonitQuoteBuyTokensOut({ curve, collateralLamports: effectiveIn });
    } else {
      // Fresh curve: classic initial reserves.
      tokensOut = moonitQuoteBuyTokensOut({
        curve: {
          discriminator: '',
          collateralCurrency: 0,
          tokenSupply: 1_000_000_000n * 10n ** BigInt(params.launch.decimals) * 1073n / 1000n,
          collateralCollected: 0n,
          totalTokenSupply: params.launch.totalSupplyRaw,
          migrationTarget: 0,
          realTokenAmount: 0n,
          migrationQuoteAmount: 0n,
          migrated: false,
        },
        collateralLamports: effectiveIn,
      });
    }
    const ix = moonitBuyInstruction({
      sender: buyer.publicKey,
      mint: new PublicKey(mintKey),
      trade: {
        tokenAmount: tokensOut,
        collateralAmount: effectiveIn + (effectiveIn * BigInt(params.slippageBps)) / 10_000n,
        fixedSide: MoonitFixedSide.Token,
        slippageBps: BigInt(params.slippageBps),
      },
    });
    buyTxs.push({
      description: `moonit buyer ${buyer.publicKey.toBase58().slice(0, 6)}`,
      feePayer: buyer.publicKey.toBase58(),
      instructions: [ix],
      signers: [buyer],
    });
  }

  const outcomes: SendOutcome[] = [launchOutcome];
  for (const group of chunk(buyTxs, JITO_BUNDLE_MAX_TXS)) {
    outcomes.push(await ctx.sender.sendBundle(group, { mode }));
  }

  return {
    mint: mintKey,
    outcomes,
    buyerSignatures: outcomes.flatMap((o) => o.signatures),
    simulated: mode === 'simulate',
  };
}

/** Best-effort mint extraction from a prepared transaction (scan mints). */
function extractMintFromTx(base64: string): string {
  try {
    const vtx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
    const keys = vtx.message.staticAccountKeys;
    // Mint is typically the 5th account (sender, backend authority, curve, mint, metadata…).
    const candidate = keys[3];
    if (candidate) return candidate.toBase58();
    if (keys[0]) return keys[0]!.toBase58();
    throw new Error('cannot extract mint from Moonit transaction');
  } catch {
    throw new Error('cannot extract mint from Moonit transaction');
  }
}

// ---------------------------------------------------------------------------
// Raydium AMM v4 launch (OpenBook V1 market + pool seeding)
// ---------------------------------------------------------------------------

export interface RaydiumLaunchResult {
  marketId: string;
  poolId: string;
  outcome: SendOutcome;
  simulated: boolean;
}

/**
 * Creates an OpenBook V1 market and seeds a Raydium AMM v4 pool in one
 * transaction group. The caller funds base + quote (typically WSOL) amounts.
 */
export async function raydiumAmmV4Launch(
  ctx: DexContext,
  params: {
    treasury: Keypair;
    baseMint: PublicKey;
    quoteMint: PublicKey;
    baseDecimals: number;
    quoteDecimals: number;
    baseAmountRaw: bigint;
    quoteAmountRaw: bigint;
    openTime?: bigint;
    lotSize?: number;
    tickSize?: number;
    mode?: 'simulate' | 'execute';
  },
): Promise<RaydiumLaunchResult> {
  const setup = prepareSerumMarket({
    baseMint: params.baseMint,
    quoteMint: params.quoteMint,
    baseDecimals: params.baseDecimals,
    quoteDecimals: params.quoteDecimals,
    lotSize: params.lotSize,
    tickSize: params.tickSize,
  });
  const marketIxs = openbookV1CreateMarketInstructions({
    payer: params.treasury.publicKey,
    setup,
  });

  // Patch rent.
  const rent = await ctx.rpc.connection.getMinimumBalanceForRentExemption(1);
  const patched = withRentLamports(marketIxs.instructions, (space) => rent + Math.ceil(space / 100) * rent);
  // NOTE: withRentLamports computes per-space rent using the unit price
  // provided; the service below refines it with exact RPC rent for each size.

  const userBaseVault = getAssociatedTokenAddressSync(params.baseMint, params.treasury.publicKey, true, TOKEN_PROGRAM_ID);
  const userQuoteVault = getAssociatedTokenAddressSync(params.quoteMint, params.treasury.publicKey, true, TOKEN_PROGRAM_ID);
  const keys = deriveAmmV4PoolKeys(setup.market.publicKey, new PublicKey(PROGRAMS.OPENBOOK_V1));
  const userLpVault = getAssociatedTokenAddressSync(keys.lpMint, params.treasury.publicKey, true, TOKEN_PROGRAM_ID);

  const poolIx = ammV4CreatePoolInstruction({
    userWallet: params.treasury.publicKey,
    userBaseVault,
    userQuoteVault,
    userLpVault,
    keys,
    baseMint: params.baseMint,
    quoteMint: params.quoteMint,
    openTime: params.openTime ?? 0n,
    baseAmount: params.baseAmountRaw,
    quoteAmount: params.quoteAmountRaw,
  });

  const instructions = [
    createAssociatedTokenAccountInstruction(
      params.treasury.publicKey,
      userLpVault,
      params.treasury.publicKey,
      keys.lpMint,
      TOKEN_PROGRAM_ID,
    ),
    ...patched,
    poolIx,
  ];

  const outcome = await ctx.sender.send(
    {
      description: 'raydium amm v4 market + pool launch',
      feePayer: params.treasury.publicKey.toBase58(),
      instructions,
      signers: [params.treasury, ...marketIxs.signers],
    },
    { mode: params.mode, priorityFee: { computeUnitLimit: 1_400_000, microLamportsPerCu: 500_000 } },
  );

  return {
    marketId: setup.market.publicKey.toBase58(),
    poolId: keys.ammId.toBase58(),
    outcome,
    simulated: outcome.simulated,
  };
}

export { TransactionInstruction, pumpBondingCurvePda, decodeBondingCurve };
