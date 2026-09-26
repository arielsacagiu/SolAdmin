/**
 * Transaction-building and sending types.
 * @module
 */

import type { PriorityFeeConfig, RuntimeMode, SendOutcome } from './common.js';

/** How a prepared transaction is dispatched. */
export type DispatchChannel = 'rpc' | 'jito-bundle' | 'jito-tx';

/** Options accepted by every send/execute API in the toolkit. */
export interface SendOptions {
  /** Overrides the global simulation mode for a single call. */
  mode?: RuntimeMode;
  /** Priority fee / tip configuration. */
  priorityFee?: PriorityFeeConfig;
  /** Submit as a Jito bundle (multi-tx atomic). */
  jito?: boolean;
  /** Simulation commitment for pre-flight. Default: processed. */
  simulationCommitment?: 'processed' | 'confirmed';
  /** Skip pre-flight simulation (NOT recommended; used only for race-critical snipes). */
  skipSimulation?: boolean;
  /** Max confirm attempts with fresh blockhash on failure. */
  maxRetries?: number;
  /** Called right before the transaction is signed. */
  beforeSend?: (prepared: PreparedTransaction) => void | Promise<void>;
}

/** A transaction that has been assembled and fee-configured but not signed yet. */
export interface PreparedTransaction {
  /** Versioned message bytes before signing. */
  compiledMessage: Uint8Array;
  /** Instructions summary for logging. */
  instructionCount: number;
  /** Fee payer public key. */
  feePayer: string;
  /** Human description of what this transaction does. */
  description: string;
}

/** Signed transaction ready for dispatch. */
export interface SignedTransaction {
  /** Fully signed versioned transaction bytes. */
  bytes: Uint8Array;
  /** Base64 representation for RPC/Jito submission. */
  base64: string;
  /** First signature. */
  signature: string;
  description: string;
}

/** Callback for transaction history reconstruction. */
export interface HistoryEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  fee: number;
  status: 'success' | 'failed';
  description?: string;
  timestampLogged: string;
}

/** Uniform result type used by service-level operations. */
export interface OperationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Transactions produced while running the operation. */
  outcomes: SendOutcome[];
}

/** Simulate-only report. */
export interface SimulationReport {
  ok: boolean;
  logs: string[];
  consumedUnits: number;
  error?: string;
}
