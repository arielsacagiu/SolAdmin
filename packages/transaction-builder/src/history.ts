/**
 * Local transaction history recorder (JSONL) for auditability.
 * Every executed/simulated outcome can be appended with a description so a
 * full session can be reconstructed later.
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';

const log = moduleLogger('history');

export class HistoryRecorder {
  private file: string;

  constructor(outputDir = './output', filename = 'transaction-history.jsonl') {
    fs.mkdirSync(path.resolve(outputDir), { recursive: true });
    this.file = path.join(outputDir, filename);
  }

  /**
   * Appends an entry. Never throws — history must not break operations.
   */
  record(entry: HistoryEntry): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      log.warn({ err }, 'failed to append history entry');
    }
  }

  /** Reads all entries recorded so far. */
  readAll(): HistoryEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HistoryEntry);
  }
}
