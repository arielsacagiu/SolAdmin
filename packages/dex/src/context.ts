/**
 * Shared execution context for all DEX operations.
 * @module
 */

import type { JitoConfig, ToolkitConfig } from '@solana-toolkit/types';
import {
  JitoBundleClient,
  PriorityFeeMonitor,
  SolanaRpcClient,
  createJitoClient,
  createRpcClient,
} from '@solana-toolkit/rpc-client';
import { HistoryRecorder, TransactionSender } from '@solana-toolkit/transaction-builder';

export interface DexContext {
  rpc: SolanaRpcClient;
  jito: JitoBundleClient;
  feeMonitor: PriorityFeeMonitor;
  sender: TransactionSender;
  history: HistoryRecorder;
  jupiterApiBase: string;
  raydiumApiBase: string;
  cluster: string;
}

/**
 * Builds a DexContext from a ToolkitConfig.
 */
export function createDexContext(config: ToolkitConfig): DexContext {
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
    jupiterApiBase: process.env['SOLADMIN_JUPITER_API_BASE'] ?? 'https://lite-api.jup.ag',
    raydiumApiBase:
      process.env['SOLADMIN_RAYDIUM_API_BASE'] ??
      (config.rpc.cluster === 'devnet'
        ? 'https://api-v3-devnet.raydium.io'
        : 'https://api-v3.raydium.io'),
    cluster: config.rpc.cluster,
  };
}

export { JitoConfig };
