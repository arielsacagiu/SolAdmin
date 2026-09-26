/**
 * @solana-toolkit/venues — venue adapters for atomic round-trip trading.
 * All program IDs, discriminators, PDA seeds and account layouts were verified
 * against on-chain data; see each module's header for the pinned constants.
 * @module
 */

export * from './types.js';
export {
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
  tokenAmountFromAccountData,
  tokenOwnerFromAccountData,
  tokenProgramForMintOwner,
  u64le,
  unwrapSolIx,
  wrapSolIxs,
} from './common.js';

export {
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_GLOBAL,
  PUMPFUN_EVENT_AUTHORITY,
  PUMPFUN_FEE_CONFIG,
  PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR,
  PUMPFUN_DEFAULT_FEE_RECIPIENT,
  PUMPFUN_TOTAL_FEE_BPS,
  PUMPFUN_BUY_DISC,
  PUMPFUN_SELL_DISC,
  PumpfunVenue,
  buildPumpfunBuyIx,
  buildPumpfunSellIx,
  parseBondingCurve,
  pumpfunBondingCurvePda,
  pumpfunCreatorVaultPda,
  pumpfunSolForTokenSell,
  pumpfunSolForTokens,
  pumpfunTokensForSol,
  pumpfunUserVolumeAccumulatorPda,
  type BondingCurveState,
  type PumpfunContext,
} from './pumpfun.js';

export {
  PUMPSWAP_PROGRAM_ID,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
  PUMPSWAP_PROTOCOL_FEE_ATA,
  PUMPSWAP_EVENT_AUTHORITY,
  PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMPSWAP_FEE_CONFIG,
  PUMPSWAP_FEE_PROGRAM,
  PUMPSWAP_POOL_DISCRIMINATOR,
  PUMPSWAP_BUY_DISC,
  PUMPSWAP_SELL_DISC,
  PUMPSWAP_FEE_BPS,
  PumpSwapVenue,
  buildPumpSwapBuyIx,
  buildPumpSwapSellIx,
  findPumpSwapPool,
  parsePumpSwapPool,
  pumpswapCreatorVaultAuthority,
  pumpswapUserVolumeAccumulator,
  type PumpSwapContext,
  type PumpSwapPool,
} from './pumpswap.js';

export {
  LAUNCHLAB_PROGRAM_ID,
  LAUNCHLAB_EVENT_AUTHORITY,
  LAUNCHLAB_BUY_EXACT_IN_DISC,
  LAUNCHLAB_BUY_EXACT_OUT_DISC,
  LAUNCHLAB_SELL_EXACT_IN_DISC,
  LAUNCHLAB_SELL_EXACT_OUT_DISC,
  LAUNCHPAD_POOL_MIN_SIZE,
  LAUNCHLAB_DEFAULT_FEE_BPS,
  LaunchLabVenue,
  buildLaunchpadBuyExactInIx,
  buildLaunchpadBuyExactOutIx,
  buildLaunchpadSellExactInIx,
  findLaunchpadPool,
  launchpadAuthority,
  launchpadPoolPda,
  launchpadReserves,
  parseLaunchpadPoolState,
  type LaunchLabContext,
  type LaunchLabVenueOptions,
  type LaunchpadPoolState,
} from './launchlab.js';

export {
  CPMM_PROGRAM_ID,
  CPMM_AUTHORITY,
  CPMM_SWAP_BASE_INPUT_DISC,
  CPMM_SWAP_BASE_OUTPUT_DISC,
  CPMM_FEE_DENOMINATOR,
  CPMM_DEFAULT_TRADE_FEE_RATE,
  CPMM_POOL_MIN_SIZE,
  CpmmVenue,
  buildCpmmSwapBaseInputIx,
  buildCpmmSwapBaseOutputIx,
  findCpmmPool,
  parseCpmmPoolState,
  parseCpmmTradeFeeRate,
  type CpmmContext,
  type CpmmPoolState,
} from './cpmm.js';

export {
  JupiterVenue,
  type JupiterContext,
  type JupiterQuote,
  type JupiterVenueOptions,
} from './jupiter.js';

export {
  createVenueAdapter,
  resolveVenue,
  type ResolveVenueOptions,
  type ResolvedVenue,
} from './resolve.js';
