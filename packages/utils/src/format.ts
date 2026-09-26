/**
 * Formatting, CSV, and small shared helpers.
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Converts raw lamports to a SOL number (lossy for display only).
 */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

/**
 * Converts a decimal SOL amount to raw lamports (floor).
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * Number(LAMPORTS_PER_SOL)));
}

/**
 * Formats base units with decimals for display.
 */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const out = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

/**
 * Escapes one CSV field.
 */
export function csvEscape(value: string | number | bigint | boolean | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serializes rows to CSV text.
 */
export function toCsv(headers: string[], rows: (string | number | bigint | boolean | null | undefined)[][]): string {
  const head = headers.map(csvEscape).join(',');
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

/**
 * Writes CSV to a file, creating parent directories.
 */
export function writeCsv(file: string, headers: string[], rows: (string | number | bigint | boolean | null | undefined)[][]): string {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const text = toCsv(headers, rows);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * Writes pretty JSON to a file, creating parent directories.
 */
export function writeJson(file: string, data: unknown): string {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

/**
 * Simple retry with exponential backoff for flaky RPC/HTTP calls.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; backoffMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
  const backoff = opts.backoffMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const sleep = backoff * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, sleep));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Chunks an array into pieces of `size`.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Sleep helper.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Truncates a string in the middle for compact logging.
 */
export function ellipsizeMiddle(value: string, max = 16): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
