/**
 * Top-level orchestration: loads wallets + funder keystores, builds the
 * sender stack, runs the engine, then unwinds (sell residual + sweep SOL).
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import type { ToolkitConfig } from '@solana-toolkit/types';
import { createJitoClient, createRpcClient, PriorityFeeMonitor } from '@solana-toolkit/rpc-client';
import { TransactionSender } from '@solana-toolkit/transaction-builder';
import { loadKeystore } from '@solana-toolkit/wallet-manager';
import { moduleLogger, showSecurityBanner } from '@solana-toolkit/utils';
import type { VenueAdapter, VenueContext } from '@solana-toolkit/venues';
import { resolveVenue } from '@solana-toolkit/venues';
import type { VolumeBotConfig } from './config.js';
import { VolumeBot, type VolumeBotRunReport } from './engine.js';
import { unwindPool, type UnwindReport } from './unwind.js';
import { loadWalletPool } from './wallets.js';

const log = moduleLogger('volume-bot');

export interface RunVolumeBotOptions {
  toolkit: ToolkitConfig;
  config: VolumeBotConfig;
  /** 'execute' only when the caller already enforced the --execute gate. */
  mode: 'simulate' | 'execute';
  /** Keystore password (defaults to SOLADMIN_KEYSTORE_PASSWORD). */
  keystorePassword?: string;
  outputDir?: string;
  shouldStop?: () => boolean;
}

export interface VolumeBotResult {
  run: VolumeBotRunReport;
  unwind?: UnwindReport;
}

/**
 * Full volume-bot lifecycle: load → resolve venue → (optionally) fund →
 * trade rounds → unwind + consolidate. Simulation-mode safe throughout.
 */
export async function runVolumeBot(opts: RunVolumeBotOptions): Promise<VolumeBotResult> {
  const { toolkit, config, mode } = opts;
  showSecurityBanner();
  log.warn(
    'INTEGRITY NOTICE: this tool creates synthetic trading volume. Artificial ' +
      'volume and wash trading can violate laws, exchange rules and venue ' +
      'policies. Use only for local testing, program fuzzing, staging, or ' +
      'explicitly disclosed research.',
  );

  const rpc = createRpcClient(toolkit.rpc);
  const jito = createJitoClient(toolkit.jito);
  const feeMonitor = toolkit.safety.priorityFee.dynamic
    ? new PriorityFeeMonitor(
        rpc,
        toolkit.safety.priorityFee.percentile ?? 60,
        toolkit.safety.priorityFee.microLamportsPerCu ?? 200_000,
      )
    : undefined;
  const sender = new TransactionSender(rpc, jito, toolkit.safety, feeMonitor);

  const pool = loadWalletPool(config.wallets, opts.keystorePassword);
  const funder: Keypair | undefined = config.funderKeystore
    ? loadKeystore(config.funderKeystore, opts.keystorePassword)
    : undefined;

  const bot = new VolumeBot({
    rpc,
    sender,
    jito,
    config,
    mode,
    pool,
    funder,
    outputDir: opts.outputDir ?? toolkit.outputDir,
    shouldStop: opts.shouldStop,
  });

  await bot.prepare();
  const run = await bot.run();

  // Unwind: sell residual tokens + consolidate — only when configured and
  // something meaningful was produced (or execute mode, where dust may exist).
  let unwind: UnwindReport | undefined;
  const needsUnwind = config.unwind.sellResidualTokens || config.unwind.consolidateTo || funder;
  if (needsUnwind && (run.roundTripsSucceeded > 0 || mode === 'execute')) {
    const resolved = await resolveVenue(rpc, new PublicKey(config.mint), config.venue, {
      cpmmPoolAddress: config.cpmmPoolAddress,
      launchlab: { shareFeeRate: config.launchlabShareFeeRate },
    }).catch(() => null);
    if (resolved) {
      unwind = await unwindPool(
        rpc,
        sender,
        resolved.adapter as VenueAdapter<VenueContext>,
        resolved.ctx,
        config,
        pool,
        { mode },
        funder,
      );
    } else {
      log.warn('unwind skipped — venue could not be re-resolved');
    }
  }

  return { run, unwind };
}
