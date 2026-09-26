/**
 * `soladmin volbot` — Anti-MEV volume bot.
 *
 * Every subcommand runs through the shared bootstrap: simulation mode unless
 * `--execute` is passed AND SOLADMIN_SIMULATION_MODE=false.
 *
 * INTEGRITY: synthetic volume can be market manipulation. See README.
 * @module
 */

import { Command, Option } from 'commander';
import { PublicKey } from '@solana/web3.js';
import { lamportsToSol, moduleLogger } from '@solana-toolkit/utils';
import { createJitoClient, createRpcClient, PriorityFeeMonitor } from '@solana-toolkit/rpc-client';
import { TransactionSender } from '@solana-toolkit/transaction-builder';
import { loadKeystore } from '@solana-toolkit/wallet-manager';
import {
  loadVolumeBotConfig,
  runVolumeBot,
  loadWalletPool,
  unwindPool,
  type VolumeBotConfig,
} from '@solana-toolkit/volume-bot';
import { resolveVenue } from '@solana-toolkit/venues';
import { bootstrap, type GlobalOptions } from '../shared.js';

const log = moduleLogger('cli.volbot');

const INTEGRITY_NOTE =
  'NOTE: volbot creates SYNTHETIC volume (buy+sell round trips from your own ' +
  'wallets). Artificial volume / wash trading can violate laws, exchange ' +
  'rules and venue policies — use only for local testing, program fuzzing, ' +
  'staging, or explicitly disclosed research.';

export function registerVolbotCommands(program: Command): void {
  const volbot = program
    .command('volbot')
    .description('Anti-MEV volume bot — atomic buy+sell round trips (intra-tx or Jito bundles)');

  volbot
    .command('run')
    .description('Run the volume bot from a YAML/JSON config (simulation by default)')
    .requiredOption('--file <path>', 'volume-bot config file (YAML or JSON)')
    .addOption(new Option('--rounds <n>', 'override schedule.rounds'))
    .addOption(new Option('--size <lamports>', 'override tradeLamports (fixed size)'))
    .action(async (cmdOpts: { file: string; rounds?: string; size?: string }) => {
      const globals = program.opts() as GlobalOptions;
      const { config, mode } = await bootstrap(globals);
      log.warn(INTEGRITY_NOTE);

      const botConfig = loadVolumeBotConfig(cmdOpts.file);
      if (cmdOpts.rounds) botConfig.schedule.rounds = Number(cmdOpts.rounds);
      if (cmdOpts.size) botConfig.tradeLamports = { min: BigInt(cmdOpts.size), max: BigInt(cmdOpts.size) };

      let stopping = false;
      const onSigint = () => {
        if (!stopping) {
          stopping = true;
          log.warn('SIGINT — finishing current round, then unwinding');
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const result = await runVolumeBot({
          toolkit: config,
          config: botConfig,
          mode,
          outputDir: config.outputDir,
          shouldStop: () => stopping,
        });
        printRunSummary(result, globals.json === true);
      } finally {
        process.off('SIGINT', onSigint);
      }
    });

  volbot
    .command('quote')
    .description('Dry-run a round trip: resolve the venue and print the priced quote')
    .requiredOption('--mint <mint>', 'token mint to volume')
    .addOption(new Option('--venue <venue>', 'pumpfun|pumpswap|launchlab|cpmm|jupiter|auto').default('auto'))
    .addOption(new Option('--size <lamports>', 'SOL size in lamports').default('10000000'))
    .addOption(new Option('--slippage-bps <bps>', 'slippage').default('300'))
    .action(async (cmdOpts: { mint: string; venue: string; size: string; slippageBps: string }) => {
      const globals = program.opts() as GlobalOptions;
      const { config } = await bootstrap(globals);
      const rpc = createRpcClient(config.rpc);
      const { adapter, ctx } = await resolveVenue(rpc, new PublicKey(cmdOpts.mint), cmdOpts.venue as never);
      const quote = await adapter.quoteRoundTrip(ctx, BigInt(cmdOpts.size), Number(cmdOpts.slippageBps));
      const out = {
        venue: ctx.kind,
        label: ctx.label,
        pool: ctx.poolAddress,
        maxSolIn: quote.maxSolIn.toString(),
        maxSolInSol: lamportsToSol(quote.maxSolIn),
        tokensOut: quote.tokensOut.toString(),
        expectedSolOut: quote.expectedSolOut.toString(),
        minSolOut: quote.minSolOut.toString(),
        expectedCostLamports: quote.expectedCostLamports.toString(),
        expectedCostSol: lamportsToSol(quote.expectedCostLamports),
      };
      print(out, globals.json === true);
    });

  volbot
    .command('unwind')
    .description('Sell residual tokens and sweep SOL out of the wallet pool')
    .requiredOption('--file <path>', 'volume-bot config file (YAML or JSON)')
    .action(async (cmdOpts: { file: string }) => {
      const globals = program.opts() as GlobalOptions;
      const { config, mode } = await bootstrap(globals);
      const botConfig: VolumeBotConfig = loadVolumeBotConfig(cmdOpts.file);
      const rpc = createRpcClient(config.rpc);
      const jito = createJitoClient(config.jito);
      const feeMonitor = config.safety.priorityFee.dynamic
        ? new PriorityFeeMonitor(rpc, config.safety.priorityFee.percentile ?? 60)
        : undefined;
      const sender = new TransactionSender(rpc, jito, config.safety, feeMonitor);
      const pool = loadWalletPool(botConfig.wallets);
      const funder = botConfig.funderKeystore ? loadKeystore(botConfig.funderKeystore) : undefined;
      const { adapter, ctx } = await resolveVenue(rpc, new PublicKey(botConfig.mint), botConfig.venue, {
        cpmmPoolAddress: botConfig.cpmmPoolAddress,
        launchlab: { shareFeeRate: botConfig.launchlabShareFeeRate },
      });
      const report = await unwindPool(rpc, sender, adapter, ctx, botConfig, pool, { mode }, funder);
      print(report, globals.json === true);
    });

  volbot
    .command('balances')
    .description('Print SOL balances of the wallet pool')
    .requiredOption('--file <path>', 'volume-bot config file (YAML or JSON)')
    .action(async (cmdOpts: { file: string }) => {
      const globals = program.opts() as GlobalOptions;
      const { config } = await bootstrap(globals);
      const botConfig = loadVolumeBotConfig(cmdOpts.file);
      const rpc = createRpcClient(config.rpc);
      const pool = loadWalletPool(botConfig.wallets);
      const bals = await rpc.balances(pool.map((w) => w.keypair.publicKey.toBase58()));
      const rows = pool.map((w, i) => ({
        wallet: w.keypair.publicKey.toBase58(),
        lamports: (bals[i] ?? 0n).toString(),
        sol: lamportsToSol(bals[i] ?? 0n),
      }));
      print(rows, globals.json === true);
    });
}

function printRunSummary(result: Awaited<ReturnType<typeof runVolumeBot>>, json: boolean): void {
  const r = result.run;
  const summary = {
    mode: r.mode,
    venue: r.venue,
    pool: r.pool,
    roundsAttempted: r.roundsAttempted,
    roundTripsSucceeded: r.roundTripsSucceeded,
    roundTripsFailed: r.roundTripsFailed,
    grossVolumeSol: lamportsToSol(r.grossVolumeLamports),
    expectedNetCostSol: lamportsToSol(r.expectedNetCostLamports),
    realizedNetCostSol: r.realizedNetCostLamports === null ? null : lamportsToSol(r.realizedNetCostLamports),
    unwind: result.unwind
      ? {
          walletsProcessed: result.unwind.walletsProcessed,
          tokensSoldWallets: result.unwind.tokensSoldWallets,
          solSweptWallets: result.unwind.solSweptWallets,
        }
      : undefined,
    signatures: r.outcomes.flatMap((o) => o.signatures).slice(0, 20),
  };
  print(summary, json);
}

function print(value: unknown, json: boolean): void {
  if (json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.dir(value, { depth: 6, colors: process.stdout.isTTY });
}
