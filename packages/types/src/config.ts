/**
 * Declarative configuration types (JSON/YAML) for the toolkit and for the
 * end-to-end lifecycle automation scripts.
 * @module
 */

import type { Cluster, CommitmentLevel, PriorityFeeConfig, RuntimeMode } from './common.js';

/** RPC and execution environment configuration. */
export interface RpcConfig {
  /** HTTP JSON-RPC endpoint. Any provider: Helius, QuickNode, local validator. */
  rpcUrl: string;
  /**
   * Failover pool of HTTP JSON-RPC endpoints. When set, the RPC client
   * health-checks and rotates across these URLs (round-robin with healthy
   * preference, exponential backoff on failure). `rpcUrl` is kept as the
   * primary/first endpoint. Can also be provided via the comma-separated
   * `SOLADMIN_RPC_URLS` environment variable.
   */
  rpcUrls?: string[];
  /** WebSocket endpoint for subscriptions. Optional. */
  wsUrl?: string;
  cluster: Cluster;
  commitment: CommitmentLevel;
  /** Retries applied when rate-limited (default 5). */
  maxRetries?: number;
  /** Backoff base in ms for RPC retries (default 500). */
  retryBackoffMs?: number;
}

/** Jito Block Engine configuration. */
export interface JitoConfig {
  /** Block engine base URL, e.g. https://mainnet.block-engine.jito.wtf */
  blockEngineUrl: string;
  /** Tip attached to the final transaction of each bundle, in lamports. */
  tipLamports: number;
  /** Relay single transactions through /api/v1/transactions. */
  relaySingleTxs: boolean;
  /** Timeout in ms for bundle status polling. */
  statusTimeoutMs?: number;
}

/** Global safety configuration. */
export interface SafetyConfig {
  /** When true nothing is ever sent to the network. Default: true. */
  simulationMode: boolean;
  /** Default priority fee configuration applied to all sends. */
  priorityFee: PriorityFeeConfig;
  /** Abort sends whose pre-flight simulation consumes more than this many CUs. */
  maxComputeUnits?: number;
  /** Abort sends whose estimated total cost exceeds this many lamports. */
  maxTotalCostLamports?: number;
}

/** Root configuration file (config/toolkit.yaml or JSON equivalent). */
export interface ToolkitConfig {
  rpc: RpcConfig;
  jito: JitoConfig;
  safety: SafetyConfig;
  /** Arbitrary named keystore paths, e.g. { "funder": "./wallets/funder.keystore.json" } */
  keystores?: Record<string, string>;
  /** Output directory for reports/CSV exports (default ./output). */
  outputDir?: string;
}

/** Launchpad selection for lifecycle automation. */
export type LaunchpadKind = 'pumpfun' | 'moonit' | 'raydium-amm-v4';

/** Token creation stage of the lifecycle config. */
export interface LifecycleCreateTokenStage {
  enabled: boolean;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyRaw: string;
  metadataUri: string;
  imageFilePath?: string;
  /** SPL or Token-2022 with extensions. */
  tokenProgram: 'spl' | 'token-2022';
  extensions?: {
    transferFeeBps?: number;
    transferFeeMaxRaw?: string;
    taxFixedBps?: number;
    metadataOnChain?: boolean;
    freezeAuthority?: boolean;
  };
}

/** Launch stage (Pump.fun / Moonit / Raydium AMM v4). */
export interface LifecycleLaunchStage {
  launchpad: LaunchpadKind;
  /** Number of simultaneous buy wallets (Pump.fun supports up to 28, Moonit up to 6). */
  bundledBuyers: number;
  /** SOL per buyer, in raw lamports, sent to bonding curve buys. */
  buyLamportsPerWallet: string;
  /** Slippage basis points applied to buys. */
  slippageBps: number;
  /** Jito tip lamports per bundle. */
  jitoTipLamports: string;
  /** Delay between launches when multiple tokens are processed. */
  launchDelayMs?: number;
}

/** Monitoring stage. */
export interface LifecycleMonitorStage {
  enabled: boolean;
  /** Poll/subscription interval in ms. */
  intervalMs: number;
  /** Subscribe to bonding-curve trade events for the mint. */
  subscribeTrades: boolean;
  /** Print price/reserves on every trade event. */
  verbose: boolean;
}

/** Automated exit stage. */
export interface LifecycleExitStage {
  enabled: boolean;
  /** Sell when price reaches this multiple of entry price (e.g. 2.0). */
  takeProfitMultiplier?: number;
  /** Sell when price falls to this fraction of entry price (e.g. 0.5). */
  stopLossFraction?: number;
  /** Sell everything after N minutes regardless of price. */
  maxHoldSeconds?: number;
  /** Slippage bps for the exit sells. */
  slippageBps: number;
  /** Route exits through (jupiter preferred, pumpfun/raydium direct fallback). */
  route: 'jupiter' | 'pumpfun' | 'raydium' | 'moonit';
}

/** Consolidation stage — sweep SOL + tokens back to the treasury wallet. */
export interface LifecycleConsolidateStage {
  enabled: boolean;
  destinationKeystore: string;
  /** Also swap remaining tokens to SOL before consolidating. */
  swapTokensToSol: boolean;
  slippageBps: number;
  /** Keep this much SOL in each wallet for rent (default 0). */
  leaveLamportsPerWallet?: string;
}

/** Full lifecycle automation config (create → launch → buy → monitor → exit → consolidate). */
export interface LifecycleConfig {
  /** Treating keystore that funds everything and signs launches. */
  treasuryKeystore: string;
  /** Directory containing buyer wallet keystores (generated if missing). */
  buyerKeystoreDir: string;
  create: LifecycleCreateTokenStage;
  launch: LifecycleLaunchStage;
  monitor: LifecycleMonitorStage;
  exit: LifecycleExitStage;
  consolidate: LifecycleConsolidateStage;
  /** Run everything in simulation mode regardless of safety config. */
  simulationMode?: boolean;
}

/** Narrow helper used by commands that only need a mode decision. */
export interface ModeOverride {
  mode?: RuntimeMode;
}
