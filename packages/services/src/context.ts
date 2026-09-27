/**
 * Shared service context: RPC + sender + config + output directory, one
 * instance passed to every feature service.
 * @module
 */

import type { ToolkitConfig } from '@solana-toolkit/types';
import {
  JitoBundleClient,
  PriorityFeeMonitor,
  SolanaRpcClient,
  createJitoClient,
  createRpcClient,
} from '@solana-toolkit/rpc-client';
import { HistoryRecorder, TransactionSender } from '@solana-toolkit/transaction-builder';

export interface ServiceContext {
  rpc: SolanaRpcClient;
  jito: JitoBundleClient;
  feeMonitor: PriorityFeeMonitor;
  sender: TransactionSender;
  history: HistoryRecorder;
  config: ToolkitConfig;
  outputDir: string;
}

/**
 * Structural context subset (rpc + sender) shared by `ServiceContext` and
 * the dex package's `DexContext`. Functions that only read balances and send
 * transactions accept this type so either context can be passed without
 * unsafe casts.
 */
export type ChainContext = Pick<ServiceContext, 'rpc' | 'sender'>;

export function createServiceContext(config: ToolkitConfig): ServiceContext {
  const rpc = createRpcClient(config.rpc);
  const jito = createJitoClient(config.jito);
  const feeMonitor = new PriorityFeeMonitor(rpc);
  const sender = new TransactionSender(rpc, jito, config.safety, feeMonitor);
  return {
    rpc,
    jito,
    feeMonitor,
    sender,
    history: new HistoryRecorder(config.outputDir ?? './output'),
    config,
    outputDir: config.outputDir ?? './output',
  };
}
