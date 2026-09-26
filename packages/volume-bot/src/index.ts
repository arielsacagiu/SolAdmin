/**
 * @solana-toolkit/volume-bot — Anti-MEV volume bot: atomic buy+sell round
 * trips (intra-transaction or Jito bundles), wallet pools, budget caps,
 * funding and unwind/consolidation. Simulation-first throughout.
 * @module
 */

export {
  parseVolumeBotConfig,
  loadVolumeBotConfig,
  type VolumeBotConfig,
  type VolumeBotWalletsConfig,
  type VolumeBotSchedule,
  type VolumeBotBudget,
  type VolumeBotUnwind,
  type RoundTripExecution,
} from './config.js';

export { BudgetTracker, BudgetExhausted, type WalletLedger } from './budget.js';

export {
  loadWalletPool,
  generateWalletPool,
  planFunding,
  fundWalletPool,
  WALLET_OVERHEAD_LAMPORTS,
  type PoolWallet,
  type FundPlanEntry,
} from './wallets.js';

export {
  VolumeBot,
  type VolumeBotDeps,
  type VolumeBotRunReport,
  type VolumeBotRoundRecord,
} from './engine.js';

export { unwindPool, type UnwindReport } from './unwind.js';

export { runVolumeBot, type RunVolumeBotOptions, type VolumeBotResult } from './run.js';
