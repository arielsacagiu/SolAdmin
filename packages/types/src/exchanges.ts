/**
 * Exchange bulk withdrawal types (Binance, OKX, Bybit, Bitget, Gate.io, MEXC).
 * @module
 */

/** Supported centralized exchanges with official withdrawal APIs. */
export type ExchangeKind = 'binance' | 'okx' | 'bybit' | 'bitget' | 'gate' | 'mexc';

/** Credentials for one exchange. */
export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  /** OKX and Bitget need a passphrase. */
  passphrase?: string;
}

/** One withdrawal request. */
export interface WithdrawalRequest {
  /** Exchange asset code, e.g. SOL. */
  asset: string;
  /** Chain/network identifier as required by the exchange, e.g. Solana. */
  network: string;
  destinationAddress: string;
  amount: number;
  /** Client-supplied id for idempotency where supported. */
  clientOrderId?: string;
  /** Optional memo (mostly non-Solana chains). */
  memo?: string;
}

/** Result of one withdrawal submission. */
export interface WithdrawalOutcome {
  exchange: ExchangeKind;
  requestId: string;
  accepted: boolean;
  exchangeWithdrawId?: string;
  rawResponse: unknown;
  error?: string;
}

/** Bulk withdrawal job. */
export interface BulkWithdrawalJob {
  exchange: ExchangeKind;
  requests: WithdrawalRequest[];
  /** Simulate: validate and sign requests but do not submit. Default true. */
  simulationMode: boolean;
}
