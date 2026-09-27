/**
 * Configuration loading: .env, YAML and JSON files with schema validation and
 * safe defaults. Simulation mode is enforced by default.
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import dotenv from 'dotenv';
import type {
  JitoConfig,
  RpcConfig,
  SafetyConfig,
  ToolkitConfig,
} from '@solana-toolkit/types';
import { logger } from './logger.js';

/**
 * Loads `.env` (or the file pointed at by SOLADMIN_ENV_FILE) into process.env.
 */
export function loadEnvFile(envPath?: string): void {
  const file = envPath ?? process.env['SOLADMIN_ENV_FILE'] ?? '.env';
  if (fs.existsSync(file)) {
    dotenv.config({ path: file });
  }
}

/**
 * Reads and parses a YAML or JSON configuration file (extension decides).
 */
export function parseConfigFile<T>(file: string): T {
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  if (file.endsWith('.json')) {
    return JSON.parse(raw) as T;
  }
  return YAML.parse(raw) as T;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds the toolkit configuration from environment variables.
 */
export function configFromEnv(): ToolkitConfig {
  const cluster = envStr('SOLADMIN_CLUSTER', 'mainnet') as RpcConfig['cluster'];
  // Failover pool: SOLADMIN_RPC_URLS is a comma-separated list of endpoints.
  // When present it feeds the resilient multi-endpoint manager in the
  // rpc-client; the first entry (or SOLADMIN_RPC_URL) stays primary.
  const rpcUrls = (process.env['SOLADMIN_RPC_URLS'] ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const primaryRpcUrl = envStr(
    'SOLADMIN_RPC_URL',
    cluster === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com',
  );
  const rpc: RpcConfig = {
    rpcUrl: primaryRpcUrl,
    // Dedupe while preserving order; the primary URL always leads the pool.
    rpcUrls: Array.from(new Set([primaryRpcUrl, ...rpcUrls])),
    wsUrl: process.env['SOLADMIN_RPC_WS_URL'],
    cluster,
    commitment: envStr('SOLADMIN_COMMITMENT', 'confirmed') as RpcConfig['commitment'],
    maxRetries: envInt('SOLADMIN_RPC_MAX_RETRIES', 5),
    retryBackoffMs: envInt('SOLADMIN_RPC_RETRY_BACKOFF_MS', 500),
  };
  const jito: JitoConfig = {
    blockEngineUrl: envStr('SOLADMIN_JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
    tipLamports: envInt('SOLADMIN_JITO_TIP_LAMPORTS', 100_000),
    relaySingleTxs: envBool('SOLADMIN_JITO_TX_RELAY', true),
    statusTimeoutMs: envInt('SOLADMIN_JITO_STATUS_TIMEOUT_MS', 30_000),
  };
  const safety: SafetyConfig = {
    simulationMode: envBool('SOLADMIN_SIMULATION_MODE', true),
    priorityFee: {
      dynamic: envBool('SOLADMIN_DYNAMIC_PRIORITY_FEE', false),
      microLamportsPerCu: envInt('SOLADMIN_DEFAULT_CU_PRICE_MICROLAMPORTS', 200_000),
      maxMicroLamportsPerCu: envInt('SOLADMIN_MAX_CU_PRICE_MICROLAMPORTS', 10_000_000),
    },
  };
  return { rpc, jito, safety, outputDir: envStr('SOLADMIN_OUTPUT_DIR', './output') };
}

/**
 * Loads a toolkit config from an optional YAML/JSON file, merged over env
 * defaults. When `file` is missing the env-derived configuration is used.
 */
export function loadToolkitConfig(file?: string): ToolkitConfig {
  const base = configFromEnv();
  if (!file) return base;
  const override = parseConfigFile<Partial<ToolkitConfig>>(file);
  const merged: ToolkitConfig = {
    ...base,
    ...override,
    rpc: { ...base.rpc, ...(override.rpc ?? {}) },
    jito: { ...base.jito, ...(override.jito ?? {}) },
    safety: {
      ...base.safety,
      ...(override.safety ?? {}),
      priorityFee: { ...base.safety.priorityFee, ...(override.safety?.priorityFee ?? {}) },
    },
  };
  logger().debug({ file }, 'toolkit config loaded');
  return merged;
}

/**
 * Validates a lifecycle/automation config minimally (throws on hard errors).
 */
export function assertLifecycleConfigShape(cfg: unknown): void {
  const c = cfg as Record<string, unknown>;
  if (!c || typeof c !== 'object') throw new Error('lifecycle config must be an object');
  for (const key of ['create', 'launch', 'monitor', 'exit', 'consolidate']) {
    if (!c[key] || typeof c[key] !== 'object') {
      throw new Error(`lifecycle config missing "${key}" stage`);
    }
  }
  if (typeof c['treasuryKeystore'] !== 'string') {
    throw new Error('lifecycle config missing treasuryKeystore');
  }
}
