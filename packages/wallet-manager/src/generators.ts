/**
 * Batch wallet generation and vanity address generation.
 *
 * SECURITY: batch generators write ONLY encrypted keystores and a public
 * `batch.json` with labels + public keys. Private keys never appear in any
 * plaintext file.
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import type { VanityCriteria, VanityResult, WalletRecord } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { writeEncryptedKeystore } from './keystore.js';

const log = moduleLogger('wallet-gen');

export interface BatchGenerateOptions {
  /** Output directory for keystores and the public batch file. */
  outDir: string;
  /** Number of wallets. */
  count: number;
  /** Label prefix; wallets are labeled `<prefix>-1`, `<prefix>-2`, ... */
  labelPrefix: string;
  /** Keystore encryption password. */
  password: string;
  /** Optional per-file label. */
  saveKeystores?: boolean;
}

export interface BatchGenerateResult {
  outDir: string;
  wallets: WalletRecord[];
  batchFile: string;
  keystores: string[];
}

/**
 * Generates `count` wallets. Writes `<outDir>/batch.json` with public records
 * and one encrypted keystore per wallet (`<outDir>/<label>.keystore.json`).
 */
export function generateBatchWallets(opts: BatchGenerateOptions): BatchGenerateResult {
  if (opts.count <= 0 || opts.count > 10_000) {
    throw new Error(`refusing to generate ${opts.count} wallets (allowed: 1..10000)`);
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  const wallets: WalletRecord[] = [];
  const keystores: string[] = [];
  for (let i = 1; i <= opts.count; i++) {
    const label = `${opts.labelPrefix}-${i}`;
    const kp = Keypair.generate();
    const file = path.join(opts.outDir, `${label}.keystore.json`);
    writeEncryptedKeystore(kp, opts.password, file, label);
    wallets.push({ label, publicKey: kp.publicKey.toBase58() });
    keystores.push(file);
  }
  const batchFile = path.join(opts.outDir, 'batch.json');
  fs.writeFileSync(batchFile, JSON.stringify({ createdAt: new Date().toISOString(), wallets }, null, 2), 'utf8');
  log.info({ count: opts.count, outDir: opts.outDir }, 'batch wallets generated');
  return { outDir: opts.outDir, wallets, batchFile, keystores };
}

/**
 * Generates vanity addresses matching prefix/suffix criteria.
 *
 * Uses naive rejection sampling in the main thread; for heavy prefixes this
 * is intentionally simple and honest about the cost. Case-insensitive
 * matching is ~32x faster than case-sensitive.
 */
export function generateVanityWallets(criteria: VanityCriteria, outDir?: string, password?: string): VanityResult[] {
  const want = criteria.count ?? 1;
  const results: VanityResult[] = [];
  const started = Date.now();
  let attempts = 0n;

  const starts = (criteria.startsWith ?? '').replace(/^[1OIl0]+$/, (m) => m); // keep as-is, validate below
  if (criteria.startsWith !== undefined && !/^[1-9A-HJ-NP-Za-km-z]*$/.test(criteria.startsWith)) {
    throw new Error('vanity prefix contains non-base58 characters');
  }
  if (criteria.endsWith !== undefined && !/^[1-9A-HJ-NP-Za-km-z]*$/.test(criteria.endsWith)) {
    throw new Error('vanity suffix contains non-base58 characters');
  }
  void starts;

  while (results.length < want) {
    attempts++;
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    if (matches(addr, criteria)) {
      const label = `vanity-${results.length + 1}`;
      if (outDir && password) {
        writeEncryptedKeystore(kp, password, path.join(outDir, `${label}.keystore.json`), label);
      }
      results.push({
        label,
        publicKey: addr,
        secretKeyHex: Buffer.from(kp.secretKey).toString('hex'),
        attempts,
        elapsedMs: Date.now() - started,
      });
      log.info({ address: addr, attempts: attempts.toString() }, 'vanity match found');
    }
  }
  return results;
}

function matches(address: string, criteria: VanityCriteria): boolean {
  const cs = criteria.caseSensitive ?? false;
  const addr = cs ? address : address.toLowerCase();
  const prefix = criteria.startsWith ? (cs ? criteria.startsWith : criteria.startsWith.toLowerCase()) : undefined;
  const suffix = criteria.endsWith ? (cs ? criteria.endsWith : criteria.endsWith.toLowerCase()) : undefined;
  if (prefix && !addr.startsWith(prefix)) return false;
  if (suffix && !addr.endsWith(suffix)) return false;
  return true;
}

/**
 * Loads a batch.json wallet list.
 */
export function loadBatchWallets(file: string): WalletRecord[] {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { wallets: WalletRecord[] };
  if (!Array.isArray(parsed.wallets)) throw new Error('batch.json missing wallets array');
  return parsed.wallets;
}
