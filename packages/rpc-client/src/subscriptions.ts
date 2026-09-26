/**
 * Real-time monitoring over RPC WebSockets.
 *
 * Thin, typed wrapper around `logsSubscribe`, `accountSubscribe`,
 * `programSubscribe` and `signatureSubscribe` with auto-reconnect and
 * structured event logging. Users register handlers and get unsubscribe
 * functions back.
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { Commitment } from '@solana/web3.js';
import type { SubscriptionKind } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { SolanaRpcClient } from './rpc.js';

const log = moduleLogger('monitor');

export type MonitorHandler = (event: {
  kind: SubscriptionKind;
  subscription: number;
  slot?: number;
  signature?: string;
  publicKey?: string;
  logs?: string[];
  data?: unknown;
  err?: unknown;
}) => void;

export class SubscriptionManager {
  private subs = new Map<number, { kind: SubscriptionKind; remove: () => Promise<void> }>();

  constructor(private readonly rpc: SolanaRpcClient) {}

  /**
   * Subscribe to log events mentioning an address (or "*").
   */
  async subscribeLogs(address: string, handler: MonitorHandler): Promise<number> {
    const sub = await this.rpc.connection.onLogs(
      address === '*' ? 'all' : new PublicKey(address),
      (ev, ctx) =>
        handler({
          kind: 'logs',
          subscription: 0,
          slot: ctx.slot,
          signature: ev.signature,
          logs: ev.logs,
          err: ev.err,
        }),
      this.rpc.config.commitment as Commitment,
    );
    this.track(sub, 'logs', this.rpc.connection.removeOnLogsListener.bind(this.rpc.connection));
    log.debug({ sub, address }, 'logsSubscribe active');
    return sub;
  }

  /**
   * Subscribe to raw account changes.
   */
  async subscribeAccount(address: string, handler: MonitorHandler): Promise<number> {
    const sub = await this.rpc.connection.onAccountChange(
      new PublicKey(address),
      (info, ctx) => handler({ kind: 'account', subscription: 0, slot: ctx.slot, publicKey: address, data: info }),
      this.rpc.config.commitment as Commitment,
    );
    this.track(sub, 'account', this.rpc.connection.removeAccountChangeListener.bind(this.rpc.connection));
    return sub;
  }

  /**
   * Subscribe to all account updates of a program (e.g. Pump.fun bonding curves).
   */
  async subscribeProgram(programId: string, handler: MonitorHandler): Promise<number> {
    const sub = await this.rpc.connection.onProgramAccountChange(
      new PublicKey(programId),
      (info, ctx) => handler({ kind: 'program', subscription: 0, slot: ctx.slot, publicKey: info.accountId.toBase58(), data: info.accountInfo }),
      this.rpc.config.commitment as Commitment,
    );
    this.track(sub, 'program', this.rpc.connection.removeProgramAccountChangeListener.bind(this.rpc.connection));
    return sub;
  }

  /**
   * Subscribe to confirmation of one signature.
   */
  async subscribeSignature(signature: string, handler: MonitorHandler): Promise<number> {
    const sub = await this.rpc.connection.onSignature(
      signature,
      (result, ctx) => handler({ kind: 'signature', subscription: 0, slot: ctx.slot, signature, err: result?.err }),
      this.rpc.config.commitment as Commitment,
    );
    void sub;
    this.track(sub, 'signature', this.rpc.connection.removeSignatureListener.bind(this.rpc.connection));
    return sub;
  }

  private track(sub: number, kind: SubscriptionKind, remove: (id: number) => Promise<void>): void {
    this.subs.set(sub, { kind, remove: async () => remove(sub) });
  }

  /** Removes a single subscription. */
  async unsubscribe(sub: number): Promise<void> {
    const entry = this.subs.get(sub);
    if (!entry) return;
    await entry.remove().catch((err) => log.warn({ err, sub }, 'unsubscribe failed'));
    this.subs.delete(sub);
  }

  /** Removes all subscriptions. */
  async unsubscribeAll(): Promise<void> {
    await Promise.allSettled([...this.subs.keys()].map((id) => this.unsubscribe(id)));
  }
}
