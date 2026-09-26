/**
 * Trading automation commands: market maker batch swap, anti-MEV volume bot,
 * bundled buy/sell, Jito sniping, token auto-sell.
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  bundledSell,
  bundledTrade,
  runVolumeBot,
} from '@solana-toolkit/dex';
import {
  increaseHolders,
  increaseTransactions,
  runBatchSwap,
} from '@solana-toolkit/dex';
import { runAutoSell, runPumpfunSniper, samplePrice } from '@solana-toolkit/dex';

async function loadKeystores(spec: string) {
  const files = JSON.parse(fs.readFileSync(spec, 'utf8')) as string[];
  const wallets = [];
  for (const f of files) wallets.push(await loadWallet(f));
  return wallets;
}

export function registerTradingCommands(program: Command): void {
  const trading = program.command('trade').description('Market maker, volume bot, bundles, sniping, auto-sell');

  trading
    .command('batch-swap')
    .description('Market Maker — Batch Swap legs across a venue')
    .requiredOption('--keystore <file>', 'trading wallet')
    .requiredOption('--venue <venue>', 'pumpfun | raydium-amm-v4 | jupiter | orca | bonk')
    .requiredOption('--mint <mint>', 'token mint traded against SOL')
    .requiredOption('--legs <spec>', 'JSON [{direction, amountRaw}]')
    .requiredOption('--rounds <n>', 'number of rounds', (v: string) => parseInt(v, 10))
    .requiredOption('--interval <ms>', 'ms between legs', (v: string) => parseInt(v, 10))
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--jito', 'route through Jito')
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      const legs = (JSON.parse(fs.readFileSync(opts.legs as string, 'utf8')) as {
        direction: 'buy' | 'sell';
        amountRaw: string;
      }[]).map((l) => ({ direction: l.direction, amountRaw: BigInt(l.amountRaw) }));
      const report = await runBatchSwap(dex, {
        venue: opts.venue as never,
        user: wallet,
        mint: opts.mint as string,
        legs,
        intervalMs: opts.interval as number,
        rounds: opts.rounds as number,
        slippageBps: opts.slippage as number,
        useJito: Boolean(opts.jito),
        mode,
      });
      printResult(opts, report);
    });

  trading
    .command('mm')
    .description('Market Maker — MM-skew mode: independent buy/sell schedules with inventory rails')
    .requiredOption('--keystore <file>', 'trading wallet')
    .requiredOption('--venue <venue>', 'pumpfun | pumpswap | raydium-amm-v4 | jupiter | orca | bonk')
    .requiredOption('--mint <mint>', 'token mint traded against SOL')
    .requiredOption('--rounds <n>', 'legs to fire PER SIDE before stopping', (v: string) => parseInt(v, 10))
    .requiredOption('--buy-sol <lamports>', 'SOL notional per buy leg')
    .requiredOption('--buy-interval <ms>', 'ms between buy legs', (v: string) => parseInt(v, 10))
    .requiredOption('--sell-raw <raw>', 'token notional per sell leg (raw units)')
    .requiredOption('--sell-interval <ms>', 'ms between sell legs', (v: string) => parseInt(v, 10))
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--jitter <bps>', 'per-leg size jitter in bps (default 300 = ±3%)', (v: string) => parseInt(v, 10))
    .option('--max-inventory <raw>', 'skip buys when inventory (raw) would exceed this')
    .option('--min-inventory <raw>', 'skip sells when inventory (raw) is below this')
    .option('--jito', 'route legs through Jito')
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      const jitterBps = (opts.jitter as number | undefined) ?? 300;
      const report = await runBatchSwap(dex, {
        venue: opts.venue as never,
        user: wallet,
        mint: opts.mint as string,
        legs: [],
        intervalMs: 0,
        rounds: opts.rounds as number,
        slippageBps: opts.slippage as number,
        useJito: Boolean(opts.jito),
        mode,
        buySchedule: {
          direction: 'buy',
          amountRaw: BigInt(String(opts.buySol)),
          intervalMs: opts.buyInterval as number,
          jitterBps,
        },
        sellSchedule: {
          direction: 'sell',
          amountRaw: BigInt(String(opts.sellRaw)),
          intervalMs: opts.sellInterval as number,
          jitterBps,
        },
        inventoryRails:
          opts.maxInventory || opts.minInventory
            ? {
                maxInventoryRaw: opts.maxInventory ? BigInt(String(opts.maxInventory)) : undefined,
                minInventoryRaw: opts.minInventory ? BigInt(String(opts.minInventory)) : undefined,
              }
            : undefined,
      });
      printResult(opts, report);
    });

  trading
    .command('volume-bot')
    .description('Anti-MEV volume bot — atomic buy+sell Jito bundles with DontFront protection')
    .requiredOption('--wallets <spec>', 'JSON array of trading keystore paths')
    .requiredOption('--venue <venue>', 'jupiter | pumpfun | pumpswap | raydium-amm-v4 | bonk | orca')
    .requiredOption('--mint <mint>')
    .requiredOption('--buy-sol <lamports>', 'base SOL per buy leg (jittered ±30% by default)')
    .requiredOption('--pairs <n>', 'buy+sell pairs to run', (v: string) => parseInt(v, 10))
    .requiredOption('--interval <ms>', 'base ms between pairs (jittered)', (v: string) => parseInt(v, 10))
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--sell-amount <raw>', 'fixed sell size (raw; default: sell the buy output)')
    .option('--pair-mode <mode>', 'atomic-bundle (default) | intra-tx | separated')
    .option('--tip-mode <mode>', 'static (default) | tip-floor (follow Jito landed-tip feed)')
    .option('--tip-percentile <p>', 'landed-tip percentile for tip-floor mode: 25|50|75|95|99', (v: string) => parseInt(v, 10))
    .option('--tip <lamports>', 'static Jito tip per pair (lamports)')
    .option('--no-dontfront', 'disable the jitodontfront anti-frontrun marker')
    .option('--jitter <bps>', 'buy-size jitter in bps (default 3000 = ±30%)', (v: string) => parseInt(v, 10))
    .option('--interval-jitter <bps>', 'interval jitter in bps (default 3000)', (v: string) => parseInt(v, 10))
    .option('--min-interval <ms>', 'minimum ms between pairs (default 2000)', (v: string) => parseInt(v, 10))
    .option('--max-cost <lamports>', 'skip a pair when estimated round-trip cost exceeds this (lamports)')
    .option('--failure-limit <n>', 'stop after N consecutive failed pairs (default 3)', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallets = await loadKeystores(String(opts.wallets));
      const pairMode = (opts['pairMode'] ?? 'atomic-bundle') as 'atomic-bundle' | 'intra-tx' | 'separated';
      const report = await runVolumeBot(dex, {
        venue: opts.venue as never,
        wallets,
        mint: opts.mint as string,
        buyLamports: BigInt(opts.buySol as string),
        sellAmountRaw: opts.sellAmount ? BigInt(String(opts.sellAmount)) : undefined,
        slippageBps: opts.slippage as number,
        intervalMs: opts.interval as number,
        pairs: opts.pairs as number,
        mode,
        pairMode,
        applyDontFront: opts['dontfront'] !== false,
        tipMode: (opts['tipMode'] ?? 'static') as 'static' | 'tip-floor',
        tipPercentile: (opts['tipPercentile'] ?? 75) as 25 | 50 | 75 | 95 | 99,
        tipLamports: opts.tip ? BigInt(String(opts.tip)) : undefined,
        maxRoundTripCostLamports: opts['maxCost'] ? BigInt(String(opts['maxCost'])) : undefined,
        jitterBps: opts.jitter as number | undefined,
        intervalJitterBps: opts['intervalJitter'] as number | undefined,
        minIntervalMs: opts['minInterval'] as number | undefined,
        consecutiveFailureLimit: opts['failureLimit'] as number | undefined,
      });
      printResult(opts, report);
    });

  trading
    .command('bundled-buy')
    .description('Bundled Buy Token — N wallets buy in one atomic Jito bundle')
    .requiredOption('--wallets <spec>', 'JSON array of buyer keystore paths')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>', 'pumpfun | raydium-amm-v4 | jupiter')
    .requiredOption('--amount <raw>', 'SOL per wallet (raw)')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallets = await loadKeystores(String(opts.wallets));
      const outcome = await bundledTrade(dex, {
        direction: 'buy',
        venue: opts.venue as never,
        wallets,
        mint: opts.mint as string,
        amountPerWalletRaw: BigInt(String(opts.amount)),
        slippageBps: opts.slippage as number,
        mode,
      });
      printResult(opts, outcome);
    });

  trading
    .command('bundled-sell')
    .description('Bundled Sell Token — N wallets sell in one atomic Jito bundle')
    .requiredOption('--wallets <spec>', 'JSON array of seller keystore paths')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>', 'pumpfun | raydium-amm-v4 | jupiter')
    .requiredOption('--amount <raw>', 'token amount per wallet (raw)')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallets = await loadKeystores(String(opts.wallets));
      const outcome = await bundledTrade(dex, {
        direction: 'sell',
        venue: opts.venue as never,
        wallets,
        mint: opts.mint as string,
        amountPerWalletRaw: BigInt(String(opts.amount)),
        slippageBps: opts.slippage as number,
        mode,
      });
      printResult(opts, outcome);
    });

  trading
    .command('bundled-sell-exit')
    .description('Bundled Sell Token — coordinated multi-wallet exit in atomic Jito bundles')
    .requiredOption('--wallets <spec>', 'JSON array of seller keystore paths')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>', 'pumpfun | pumpswap | raydium-amm-v4 | jupiter')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--sell-mode <mode>', 'parallel (default: each wallet sells its own bag) | collect-then-sell (gather to one wallet, single sell, one bundle)')
    .option('--concentrator <index>', 'wallet index (into --wallets) that concentrates and sells (default 0)', (v: string) => parseInt(v, 10))
    .option('--amount <raw>', 'fixed amount per wallet (default: each wallet sells its full balance)')
    .option('--tip <lamports>', 'static Jito tip per bundle (default: sized from the landed-tip feed)')
    .option('--tip-percentile <p>', 'landed-tip percentile when sizing from the feed: 25|50|75|95|99', (v: string) => parseInt(v, 10))
    .option('--chunk-delay <ms>', 'pause between sequential chunks in ms (default 1000)', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallets = await loadKeystores(String(opts.wallets));
      const concentratorIdx = (opts['concentrator'] as number | undefined) ?? 0;
      const report = await bundledSell(dex, {
        wallets,
        concentrator: wallets[concentratorIdx]!,
        mint: opts.mint as string,
        mode: (opts['sellMode'] === 'collect-then-sell' ? 'collect-then-sell' : 'parallel'),
        venue: opts.venue as never,
        slippageBps: opts.slippage as number,
        amountPerWalletRaw: opts.amount ? BigInt(String(opts.amount)) : undefined,
        tipLamports: opts.tip ? BigInt(String(opts.tip)) : undefined,
        tipPercentile: (opts['tipPercentile'] ?? 75) as 25 | 50 | 75 | 95 | 99,
        chunkDelayMs: opts['chunkDelay'] as number | undefined,
        mode_runtime: mode,
      });
      printResult(opts, report);
    });

  trading
    .command('snipe')
    .description('Jito bundle sniper — watch Pump.fun creates and buy instantly')
    .requiredOption('--buyers <spec>', 'JSON array of buyer keystore paths')
    .requiredOption('--buy-sol <lamports>')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--creator <address>', 'only snipe this creator')
    .option('--name-regex <regex>', 'filter by name')
    .option('--symbol-regex <regex>', 'filter by symbol')
    .option('--max <n>', 'stop after N snipes', (v: string) => parseInt(v, 10))
    .option('--listen-ms <ms>', 'give up after ms', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const buyers = await loadKeystores(opts.buyers as string);
      const report = await runPumpfunSniper(dex, {
        buyers,
        buyLamports: BigInt(opts.buySol as string),
        slippageBps: opts.slippage as number,
        filters: {
          creator: opts.creator as string | undefined,
          nameRegex: opts['nameRegex'] as string | undefined,
          symbolRegex: opts['symbolRegex'] as string | undefined,
        },
        maxSnipes: opts.max as number | undefined,
        listenMs: opts['listenMs'] as number | undefined,
        mode,
      });
      printResult(opts, report);
    });

  trading
    .command('auto-sell')
    .description('Token Auto Sell with configurable triggers (take-profit/stop-loss/timeout/graduation)')
    .requiredOption('--keystore <file>', 'holding wallet')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>', 'pumpfun | pumpswap | raydium-amm-v4 | jupiter | moonit')
    .requiredOption('--entry-price <sol>', 'entry price in SOL per token', (v: string) => parseFloat(v))
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .option('--take-profit <mult>', 'sell at entry × mult', (v: string) => parseFloat(v))
    .option('--stop-loss <frac>', 'sell at entry × frac', (v: string) => parseFloat(v))
    .option('--timeout <sec>', 'sell after N seconds', (v: string) => parseInt(v, 10))
    .option('--on-graduation', 'sell when the curve graduates')
    .option('--trailing-stop <bps>', 'trailing stop: bps drawdown from peak (e.g. 2000 = 20%)', (v: string) => parseInt(v, 10))
    .option('--activation <mult>', 'multiple of entry that arms the trailing stop (default 1.0)', (v: string) => parseFloat(v))
    .option('--amount <raw>', 'token amount to sell (default: full balance)')
    .option('--poll <ms>', 'poll interval', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      const report = await runAutoSell(dex, {
        wallet,
        mint: opts.mint as string,
        venue: opts.venue as never,
        entryPriceSol: opts['entryPrice'] as number,
        amountRaw: opts.amount ? BigInt(opts.amount as string) : undefined,
        slippageBps: opts.slippage as number,
        pollIntervalMs: opts.poll as number | undefined,
        mode,
        trigger: {
          takeProfitMultiplier: opts['takeProfit'] as number | undefined,
          stopLossFraction: opts['stopLoss'] as number | undefined,
          trailingStopBps: opts['trailingStop'] as number | undefined,
          trailingActivationMultiplier: opts['activation'] as number | undefined,
          timeoutSeconds: opts.timeout as number | undefined,
          onGraduation: Boolean(opts['onGraduation']),
        },
      });
      printResult(opts, report);
    });

  trading
    .command('increase-holders')
    .description('Increase Holders / Makers — distribute small buys across wallets')
    .requiredOption('--treasury <file>', 'funding wallet')
    .requiredOption('--buyers <spec>', 'JSON array of buyer keystore paths')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>')
    .requiredOption('--buy-sol <lamports>', 'SOL per wallet')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number>) => {
      const { dex, mode } = await bootstrap(opts);
      const treasury = await loadWallet(String(opts.treasury));
      const buyers = await loadKeystores(String(opts.buyers));
      const result = await increaseHolders(dex, {
        venue: opts.venue as never,
        treasury,
        buyerWallets: buyers,
        mint: opts.mint as string,
        buyLamportsPerWallet: BigInt(String(opts.buySol)),
        slippageBps: opts.slippage as number,
        mode,
      });
      printResult(opts, result);
    });

  trading
    .command('increase-txns')
    .description('Increase Token Transactions (↑Txns) — ping-pong trades across wallets')
    .requiredOption('--wallets <spec>', 'JSON array of trading keystore paths')
    .requiredOption('--mint <mint>')
    .requiredOption('--venue <venue>')
    .requiredOption('--amount <raw>', 'amount per leg')
    .requiredOption('--cycles <n>', 'ping-pong cycles', (v: string) => parseInt(v, 10))
    .requiredOption('--interval <ms>', 'interval in ms', (v: string) => parseInt(v, 10))
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallets = await loadKeystores(String(opts.wallets));
      const result = await increaseTransactions(dex, {
        venue: opts.venue as never,
        wallets,
        mint: opts.mint as string,
        amountRawPerLeg: BigInt(String(opts.amount)),
        cycles: opts.cycles as number,
        intervalMs: opts.interval as number,
        slippageBps: opts.slippage as number,
        mode,
      });
      printResult(opts, result);
    });

  trading
    .command('price')
    .description('Sample the current price of a mint (auto-sell helper)')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { mint: string }) => {
      const { dex } = await bootstrap(opts);
      const price = await samplePrice(dex, opts.mint, 'jupiter');
      printResult(opts, { mint: opts.mint, price });
    });
}
