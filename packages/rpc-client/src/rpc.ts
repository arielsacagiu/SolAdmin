/**
 * Hardened Solana JSON-RPC client wrapper.
 *
 * Wraps `@solana/web3.js` Connection with structured logging, retry with
 * exponential backoff, and typed helpers used across the toolkit. It is the
 * ONLY place that constructs a `Connection`, so endpoint and commitment policy
 * is centralized.
 * @module
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureStatus,
  type TransactionSignature,
} from '@solana/web3.js';
import type { RpcConfig } from '@solana-toolkit/types';
import { moduleLogger, retry } from '@solana-toolkit/utils';

const log = moduleLogger('rpc-client');

export class SolanaRpcClient {
  readonly connection: Connection;
  readonly config: RpcConfig;

  constructor(config: RpcConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment as Commitment,
      wsEndpoint: config.wsUrl,
      confirmTransactionInitialTimeout: 60_000,
    });
    log.info(
      { rpcUrl: config.rpcUrl, cluster: config.cluster, commitment: config.commitment },
      'RPC client initialized',
    );
  }

  /** Latest blockhash with expiry, with retry. */
  async latestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    return retry(
      () => this.connection.getLatestBlockhash(this.config.commitment as Commitment),
      { retries: this.config.maxRetries ?? 5, backoffMs: this.config.retryBackoffMs ?? 500, label: 'getLatestBlockhash' },
    );
  }

  /** Balance in lamports. */
  async balance(address: string): Promise<bigint> {
    const value = await retry(
      () => this.connection.getBalance(address as never, this.config.commitment as Commitment),
      { retries: this.config.maxRetries ?? 5, label: 'getBalance' },
    );
    return BigInt(value);
  }

  /** Multiple balances in one batched call. */
  async balances(addresses: string[]): Promise<bigint[]> {
    const infos = await retry(
      () => this.connection.getMultipleAccountsInfo(addresses as never, this.config.commitment as Commitment),
      { retries: this.config.maxRetries ?? 5, label: 'getMultipleAccountsInfo' },
    );
    return infos.map((info) => BigInt(info?.lamports ?? 0));
  }

  /** Account info (raw) or null. */
  async accountInfo(address: string) {
    return retry(
      () => this.connection.getAccountInfo(address as never, this.config.commitment as Commitment),
      { retries: this.config.maxRetries ?? 5, label: 'getAccountInfo' },
    );
  }

  /** Raw parsed account data via getTokenAccountsByOwner or getProgramAccounts helpers live in services. */
  async confirm(signature: TransactionSignature): Promise<{ value: { err: unknown } }> {
    const latest = await this.latestBlockhash();
    const conf = await this.connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      this.config.commitment as Commitment,
    );
    return conf;
  }

  /** Sends a raw (already signed, base64) versioned transaction through the RPC endpoint. */
  async sendRawTransaction(base64Tx: string, opts: { skipPreflight?: boolean; maxRetries?: number } = {}): Promise<string> {
    const bytes = Buffer.from(base64Tx, 'base64');
    return retry(
      async () => {
        const vtx = VersionedTransaction.deserialize(bytes);
        return this.connection.sendTransaction(vtx, {
          skipPreflight: opts.skipPreflight ?? false,
          maxRetries: opts.maxRetries ?? 0,
          preflightCommitment: this.config.commitment as Commitment,
        });
      },
      { retries: 2, backoffMs: 400, label: 'sendRawTransaction' },
    );
  }

  /**
   * Reconstructs readable transaction history for an address.
   * Returns up to `limit` recent signatures with block times and fees.
   */
  async transactionHistory(address: string, limit = 25) {
    const sigs = await retry(
      () => this.connection.getSignaturesForAddress(address as never, { limit }),
      { retries: this.config.maxRetries ?? 5, label: 'getSignaturesForAddress' },
    );
    return sigs.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime,
      status: s.err ? ('failed' as const) : ('success' as const),
      memo: s.memo ?? undefined,
    }));
  }
}

/**
 * Convenience constructor from an `RpcConfig`.
 */
export function createRpcClient(config: RpcConfig): SolanaRpcClient {
  return new SolanaRpcClient(config);
}

/**
 * Generates a random keypair (used by generators; wallet manager wraps persistently).
 */
export function randomKeypair(): Keypair {
  return Keypair.generate();
}
