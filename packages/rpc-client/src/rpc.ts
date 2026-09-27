/**
 * Hardened Solana JSON-RPC client wrapper with multi-endpoint failover.
 *
 * Wraps `@solana/web3.js` Connection with structured logging, retry with
 * exponential backoff, typed helpers used across the toolkit, and a
 * resilient endpoint-pool manager:
 *
 *  - Holds a pool of endpoints from `RpcConfig.rpcUrls` (or the
 *    comma-separated `SOLADMIN_RPC_URLS` env var, parsed by the utils config
 *    loader); a single `rpcUrl` behaves as a one-element pool.
 *  - Health-checks endpoints (getSlot / getHealth) before (re)selecting them.
 *  - Rotates round-robin with a healthy-endpoint preference and applies
 *    exponential backoff (per-endpoint cooldown) on failure.
 *  - Automatically falls back to the next healthy endpoint on errors.
 *
 * It is the ONLY place that constructs a `Connection`, so endpoint and
 * commitment policy is centralized. `this.connection` is a transparent proxy
 * over the pool: every call (including legacy `ctx.rpc.connection.*` uses)
 * routes through the failover manager.
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
import { moduleLogger, proxiedFetch, retry } from '@solana-toolkit/utils';

const log = moduleLogger('rpc-client');

/** Per-endpoint health/backoff state inside the failover pool. */
interface EndpointState {
  url: string;
  connection: Connection;
  /** Consecutive failures; reset on any success. */
  consecutiveFailures: number;
  /** Epoch ms until which this endpoint is skipped (exponential backoff). */
  cooldownUntil: number;
}

export class SolanaRpcClient {
  readonly config: RpcConfig;
  /** Proxy over the endpoint pool — see module docs. Use like a normal Connection. */
  readonly connection: Connection;

  private readonly endpoints: EndpointState[];
  private rrIndex = 0;

  constructor(config: RpcConfig) {
    this.config = config;
    // Pool: rpcUrls (deduped, primary first) or the single rpcUrl.
    const urls = Array.from(new Set(config.rpcUrls?.length ? [...config.rpcUrls] : [config.rpcUrl]));
    this.endpoints = urls.map((url) => ({
      url,
      connection: new Connection(url, {
        commitment: config.commitment as Commitment,
        wsEndpoint: config.wsUrl,
        confirmTransactionInitialTimeout: 60_000,
        fetch: proxiedFetch(),
      }),
      consecutiveFailures: 0,
      cooldownUntil: 0,
    }));
    this.connection = this.buildConnectionProxy();
    log.info(
      { rpcUrl: this.endpoints[0]!.url, pool: this.endpoints.map((e) => e.url), cluster: config.cluster, commitment: config.commitment },
      'RPC client initialized with failover pool',
    );
  }

  // -------------------------------------------------------------------------
  // Endpoint pool: health checking, rotation, failover
  // -------------------------------------------------------------------------

  /** Health-checks an endpoint via getSlot (a recent slot means the node is alive and in sync). */
  private async isHealthy(state: EndpointState): Promise<boolean> {
    try {
      const slot = await state.connection.getSlot(this.config.commitment as Commitment);
      return typeof slot === 'number' && slot > 0;
    } catch {
      return false;
    }
  }

  /**
   * Picks the next endpoint: round-robin with healthy preference. Endpoints
   * in a failure cooldown are skipped unless none is available (then the
   * least-recently-cooled one is used so calls still attempt progress).
   */
  private pickEndpoint(): EndpointState {
    const now = Date.now();
    const n = this.endpoints.length;
    for (let i = 0; i < n; i++) {
      const state = this.endpoints[(this.rrIndex + i) % n]!;
      if (state.cooldownUntil <= now) {
        this.rrIndex = (this.rrIndex + i + 1) % n;
        return state;
      }
    }
    // All endpoints cooling down: take the one whose cooldown ends first.
    const soonest = [...this.endpoints].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0]!;
    this.rrIndex = (this.endpoints.indexOf(soonest) + 1) % n;
    return soonest;
  }

  private markFailure(state: EndpointState): void {
    state.consecutiveFailures++;
    const backoff = (this.config.retryBackoffMs ?? 500) * 2 ** Math.min(state.consecutiveFailures, 6);
    state.cooldownUntil = Date.now() + backoff;
    log.warn(
      { url: state.url, consecutiveFailures: state.consecutiveFailures, cooldownMs: backoff },
      'RPC endpoint failed — rotating to next healthy endpoint',
    );
  }

  private markSuccess(state: EndpointState): void {
    if (state.consecutiveFailures > 0) {
      log.info({ url: state.url }, 'RPC endpoint recovered');
    }
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }

  /**
   * Runs an RPC call against the pool: picks a healthy endpoint, and on
   * failure marks it, applies exponential backoff, and falls back to the
   * next endpoint (one full rotation max before surfacing the error).
   */
  private async withFailover<T>(label: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    const n = this.endpoints.length;
    let lastError: unknown;
    for (let attempt = 0; attempt < n; attempt++) {
      const state = this.pickEndpoint();
      try {
        const out = await fn(state.connection);
        this.markSuccess(state);
        return out;
      } catch (err) {
        lastError = err;
        this.markFailure(state);
        if (attempt < n - 1) {
          log.debug({ label, from: state.url }, 'RPC call failed — trying next endpoint');
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Transparent Connection proxy: every method call is routed through the
   * failover manager, so legacy `ctx.rpc.connection.<method>` uses inherit
   * multi-endpoint health checking and rotation automatically.
   */
  private buildConnectionProxy(): Connection {
    const self = this;
    return new Proxy({} as Connection, {
      get(_target, prop: string) {
        const endpoint = self.pickEndpoint();
        const value = Reflect.get(endpoint.connection as unknown as Record<string, unknown>, prop);
        if (typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          return self.withFailover(prop, (connection) => {
            const fn = Reflect.get(connection as unknown as Record<string, unknown>, prop) as (...a: unknown[]) => Promise<unknown>;
            return fn(...args);
          });
        };
      },
    });
  }

  /** Current active endpoint URL (observability). */
  get activeEndpointUrl(): string {
    return this.pickEndpoint().url;
  }

  /** Health snapshot of the whole pool (observability / diagnostics). */
  async poolHealth(): Promise<{ url: string; healthy: boolean; consecutiveFailures: number }[]> {
    return Promise.all(
      this.endpoints.map(async (state) => ({
        url: state.url,
        healthy: await this.isHealthy(state),
        consecutiveFailures: state.consecutiveFailures,
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Typed helpers (all routed through the failover pool)
  // -------------------------------------------------------------------------

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
