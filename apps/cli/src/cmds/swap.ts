/**
 * Swap commands: unified swaps across venues, swap-all, price checks and the
 * real-time priority fee monitor.
 * @module
 */

import { Command } from 'commander';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import { executeSwap, swapAllTokensInWallet } from '@solana-toolkit/dex';
import { WSOL_MINT } from '@solana-toolkit/solana-programs';

export function registerSwapCommands(program: Command): void {
  const swap = program.command('swap').description('Solana Swap — Jupiter aggregator + direct Pump.fun/Raydium/Moonit routes');

  swap
    .command('exec')
    .description('Execute a swap on a venue')
    .requiredOption('--keystore <file>', 'trading wallet')
    .requiredOption('--venue <venue>', 'jupiter | pumpfun | pumpswap | moonit | raydium-amm-v4 | orca | bonk')
    .requiredOption('--from <mint>', 'input mint (use So111...1112 for SOL)')
    .requiredOption('--to <mint>', 'output mint')
    .requiredOption('--amount <raw>', 'amount in raw units')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--jito', 'relay through Jito')
    .action(async (opts: GlobalOptions & { keystore: string; venue: string; from: string; to: string; amount: string; slippage: number; jito?: boolean }) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const result = await executeSwap(dex, {
        venue: opts.venue as never,
        user: wallet,
        inputMint: opts.from,
        outputMint: opts.to,
        amountInRaw: BigInt(opts.amount),
        slippageBps: opts.slippage,
        jito: opts.jito,
        mode,
      });
      printResult(opts, result);
    });

  swap
    .command('all')
    .description('Fast Swap All Tokens in Wallet → SOL')
    .requiredOption('--keystore <file>')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--only <mints>', 'comma-separated allowlist')
    .option('--skip <mints>', 'comma-separated denylist')
    .action(async (opts: GlobalOptions & { keystore: string; slippage: number; only?: string; skip?: string }) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const result = await swapAllTokensInWallet(dex, {
        wallet,
        slippageBps: opts.slippage,
        mode,
        onlyMints: opts.only?.split(','),
        skipMints: opts.skip?.split(','),
      });
      printResult(opts, {
        swapped: result.swapped.length,
        skipped: result.skipped.length,
        failures: result.failures.length,
        details: result,
      });
    });

  swap
    .command('price')
    .description('Current price of a token (SOL) via Jupiter price API')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { mint: string }) => {
      const { dex } = await bootstrap(opts);
      const res = await fetch(`${dex.jupiterApiBase}/price/v3?ids=${opts.mint}`, {
        headers: { accept: 'application/json' },
      });
      const json = (await res.json()) as Record<string, { price?: string }>;
      printResult(opts, { mint: opts.mint, price: json[opts.mint]?.price ?? null });
    });

  swap
    .command('fee-monitor')
    .description('Real-time priority fee / gas price monitor (prints samples until Ctrl-C)')
    .requiredOption('--interval <ms>', 'poll interval in ms', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & { interval: number }) => {
      const { dex } = await bootstrap(opts);
      const { watchPriorityFees } = await import('@solana-toolkit/dex');
      await watchPriorityFees(dex, opts.interval, (sample) => {
        // eslint-disable-next-line no-console
        console.log(
          `[${sample.fetchedAt}] slot=${sample.slot} μLamports/CU=${sample.microLamportsPerCu} samples=${sample.samples.length}`,
        );
      });
      await new Promise(() => {}); // run until Ctrl-C
    });

  void WSOL_MINT;
}
