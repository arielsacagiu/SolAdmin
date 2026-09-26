/**
 * Common primitives shared across the SolAdmin toolkit.
 * @module
 */

/** Supported deployment clusters. */
export type Cluster = 'mainnet' | 'devnet' | 'localnet';

/** Solana commitment levels used by RPC calls. */
export type CommitmentLevel =
  | 'processed'
  | 'confirmed'
  | 'finalized';

/**
 * Runtime mode.
 *
 * - `simulate` — every transaction is simulated locally against the RPC node
 *   but is never submitted to the network. This is the default everywhere.
 * - `execute` — transactions are simulated first (pre-flight), then sent.
 */
export type RuntimeMode = 'simulate' | 'execute';

/** Fee-priority strategy used when building transactions. */
export interface PriorityFeeConfig {
  /** Compute unit limit to declare. 0 = estimate via simulation. */
  computeUnitLimit?: number;
  /** Fixed micro-lamport price. Mutually exclusive with dynamic mode. */
  microLamportsPerCu?: number;
  /** When true, sample recent prioritizable transactions and follow the market. */
  dynamic?: boolean;
  /** Percentile of recent priority fees to target in dynamic mode (1-100). */
  percentile?: number;
  /** Upper bound for dynamic micro-lamports/CU. */
  maxMicroLamportsPerCu?: number;
  /** Jito tip (lamports) appended as a transfer to a Jito tip account. */
  jitoTipLamports?: number;
}

/** Standard SPL token program variants. */
export type TokenProgramKind = 'spl' | 'token-2022';

/**
 * Result of dispatching a transaction (or bundle) through the toolkit.
 */
export interface SendOutcome {
  /** Signature of the first transaction (bundle anchor). */
  signature: string;
  /** All signatures when more than one transaction was produced. */
  signatures: string[];
  /** True when the transaction was only simulated (simulation mode). */
  simulated: boolean;
  /** Simulation logs, when available. */
  simulationLogs?: string[];
  /** Consumed compute units from pre-flight simulation. */
  consumedUnits?: number;
  /** Bundle id when submitted through Jito. */
  bundleId?: string;
  /** Jito bundle status when submitted through Jito. */
  bundleStatus?: string;
  /** Elapsed milliseconds. */
  elapsedMs: number;
  /** Non-fatal warnings produced during the pipeline. */
  warnings: string[];
}

/** A named keypair held by the wallet manager. */
export interface ManagedWallet {
  label: string;
  publicKey: string;
}

/** Simple decimal/percent helpers input format. */
export interface AmountSpec {
  /** Raw base units (lamports / smallest token unit). */
  raw: bigint;
  /** Decimal representation for display. */
  decimals: number;
}
