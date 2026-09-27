/**
 * Jito Block Engine client — local implementation of the bundle submission
 * JSON-RPC used by validators and searchers.
 *
 * Endpoints:
 *   POST {blockEngineUrl}/api/v1/bundles       → sendBundle / getBundleStatuses /
 *                                                  getInflightBundleStatuses / getTipAccounts
 *   POST {blockEngineUrl}/api/v1/transactions  → direct low-latency transaction
 *                                                relay with tip verification
 *
 * A tip is mandatory: the last transaction of a bundle must transfer SOL to a
 * Jito tip account. `JitoBundleClient` handles tip account discovery with a
 * pinned fallback list verified from the official Jito docs.
 * @module
 */

import type { JitoConfig } from '@solana-toolkit/types';
import { moduleLogger, proxiedFetch, retry, securePick } from '@solana-toolkit/utils';

const fetch = proxiedFetch();

const log = moduleLogger('jito');

/** SOL per 1e9 lamports (feed values are in SOL). */
const LAMPORTS_PER_SOL_NUMBER = 1_000_000_000;

/**
 * The 8 canonical Jito tip accounts (https://docs.jito.wtf). Refreshed at
 * runtime through `getTipAccounts`; used as a fallback when the engine does
 * not answer.
 */
export const JITO_TIP_ACCOUNTS_FALLBACK = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
] as const;

/** Jito-enforced minimum bundle tip (docs.jito.wtf): bundles below this are dropped. */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;

/** Jito's public tip-floor API (landed tip percentiles, refreshed each minute). */
export const JITO_TIP_FLOOR_URL_DEFAULT = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

/** One sample of the tip-floor feed. Amounts are SOL per landed bundle. */
export interface TipFloorSample {
  time: string;
  landedTips: {
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  };
  emaP50: number;
}

/** Jito block engine regions on mainnet. */
export const JITO_REGIONS = [
  'mainnet',
  'amsterdam',
  'dublin',
  'frankfurt',
  'london',
  'ny',
  'slc',
  'singapore',
  'tokyo',
] as const;

export interface BundleStatus {
  bundleId: string;
  status: string;
  slot?: number;
  transactions?: string[];
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

export class JitoBundleClient {
  private tipAccounts: string[] = [...JITO_TIP_ACCOUNTS_FALLBACK];
  private rpcId = 1;

  constructor(public readonly config: JitoConfig) {
    log.info({ engine: config.blockEngineUrl, tipLamports: config.tipLamports }, 'Jito bundle client initialized');
  }

  /** Base URL for the bundle endpoint. */
  get bundlesUrl(): string {
    return `${this.config.blockEngineUrl.replace(/\/$/, '')}/api/v1/bundles`;
  }

  /** Base URL for the single-transaction relay endpoint. */
  get transactionsUrl(): string {
    return `${this.config.blockEngineUrl.replace(/\/$/, '')}/api/v1/transactions`;
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.rpcId++,
      method,
      params,
    };
    const res = await fetch(this.bundlesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Jito RPC ${method} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`Jito RPC ${method} error: ${json.error.message}`);
    return json.result as T;
  }

  /**
   * Submits an atomic bundle of base64-encoded signed transactions.
   * The bundle must include a tip; append one via `appendTipInstruction`
   * helpers in transaction-builder before calling this.
   */
  async sendBundle(base64Txs: string[]): Promise<string> {
    const result = await retry(
      () => this.rpcCall<{ bundle_id: string }>('sendBundle', [[...base64Txs], { encoding: 'base64' }]),
      { retries: 3, backoffMs: 300, label: 'jito sendBundle' },
    );
    const bundleId = result.bundle_id;
    log.info({ bundleId, txCount: base64Txs.length }, 'bundle submitted to Jito block engine');
    return bundleId;
  }

  /**
   * Polls bundle status until it lands, fails, or the timeout elapses.
   */
  async waitForBundle(bundleId: string, timeoutMs = this.config.statusTimeoutMs ?? 30_000): Promise<BundleStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: BundleStatus = { bundleId, status: 'Pending' };
    while (Date.now() < deadline) {
      try {
        const result = await this.rpcCall<{ value: { bundle_id: string; status: string; slot: number; transactions: string[] }[] }>(
          'getBundleStatuses',
          [[bundleId]],
        );
        const entry = result.value?.[0];
        if (entry) {
          last = { bundleId, status: entry.status, slot: entry.slot, transactions: entry.transactions };
          if (entry.status === 'Landed' || entry.status === 'Failed' || entry.status === 'Invalid') {
            return last;
          }
        }
      } catch (err) {
        log.debug({ err, bundleId }, 'bundle status poll failed');
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return last;
  }

  /** In-flight bundle statuses (diagnostics). */
  async getInflightBundleStatuses(bundleId: string): Promise<unknown> {
    return this.rpcCall('getInflightBundleStatuses', [[bundleId]]);
  }

  /**
   * Fetches tip accounts from the block engine, falling back to the pinned list.
   */
  async getTipAccounts(): Promise<string[]> {
    try {
      const result = await this.rpcCall<string[]>('getTipAccounts', []);
      if (Array.isArray(result) && result.length > 0) {
        this.tipAccounts = result;
      }
    } catch (err) {
      log.debug({ err }, 'getTipAccounts failed; using pinned fallback list');
    }
    return this.tipAccounts;
  }

  /**
   * Returns a random tip account to reduce contention (per Jito docs).
   */
  async randomTipAccount(): Promise<string> {
    const tips = await this.getTipAccounts();
    return securePick(tips);
  }

  /**
   * Fetches the most recent landed-tip percentiles from Jito's tip-floor API
   * (https://bundles.jito.wtf/api/v1/bundles/tip_floor). Values are SOL per
   * landed bundle; see `recommendedTipLamports` for sizing.
   */
  async fetchTipFloor(url = JITO_TIP_FLOOR_URL_DEFAULT): Promise<TipFloorSample[]> {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Jito tip floor failed: HTTP ${res.status}`);
    }
    const raw = (await res.json()) as Record<string, unknown>[];
    return raw.map((r) => {
      const num = (k: string): number => Number(r[k] ?? 0);
      return {
        time: String(r['time'] ?? ''),
        landedTips: {
          p25: num('landed_tips_25th_percentile'),
          p50: num('landed_tips_50th_percentile'),
          p75: num('landed_tips_75th_percentile'),
          p95: num('landed_tips_95th_percentile'),
          p99: num('landed_tips_99th_percentile'),
        },
        emaP50: num('ema_landed_tips_50th_percentile'),
      };
    });
  }

  /**
   * Recommended bundle tip in lamports: the configured percentile of the
   * latest landed-tip sample, floored at Jito's enforced minimum (1000
   * lamports) and at the caller's `minLamports`. Falls back to the engine
   * config tip when the feed is unreachable.
   */
  async recommendedTipLamports(
    percentile: 25 | 50 | 75 | 95 | 99 = 75,
    opts: { minLamports?: bigint; tipFloorUrl?: string } = {},
  ): Promise<bigint> {
    const min = BigInt(Math.max(Number(JITO_MIN_TIP_LAMPORTS), Number(opts.minLamports ?? 0n)));
    try {
      const [latest] = await this.fetchTipFloor(opts.tipFloorUrl);
      if (!latest) return this.config.tipLamports >= min ? BigInt(this.config.tipLamports) : min;
      const sol = {
        25: latest.landedTips.p25,
        50: latest.landedTips.p50,
        75: latest.landedTips.p75,
        95: latest.landedTips.p95,
        99: latest.landedTips.p99,
      }[percentile];
      const lamports = BigInt(Math.max(0, Math.ceil(sol * LAMPORTS_PER_SOL_NUMBER)));
      return lamports > min ? lamports : min;
    } catch (err) {
      log.debug({ err }, 'tip floor feed unavailable; using configured tip');
      return BigInt(this.config.tipLamports) > min ? BigInt(this.config.tipLamports) : min;
    }
  }

  /**
   * Relays a single signed transaction through the /api/v1/transactions
   * endpoint. The transaction must carry a tip (header-verified by Jito).
   * Returns the accepted signature or throws.
   */
  async sendTransaction(base64Tx: string): Promise<string> {
    const res = await retry(
      () =>
        fetch(this.transactionsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [base64Tx] }),
        }),
      { retries: 2, backoffMs: 250, label: 'jito sendTransaction' },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Jito transaction relay failed: HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    log.info({ httpStatus: res.status }, 'transaction relayed through Jito');
    return text;
  }
}

/**
 * Builds a Jito bundle client from config.
 */
export function createJitoClient(config: JitoConfig): JitoBundleClient {
  return new JitoBundleClient(config);
}
