/**
 * Send/collect commands: token multisend, NFT multisend, multiple-to-multiple
 * transfer, batch collection, transfer-all, stealth transfer, claim SOL.
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  collectTokens,
  consolidateAllAssets,
} from '@solana-toolkit/services';
import { nftMultiSend, multiToMultiTransfer, tokenMultiSend } from '@solana-toolkit/services';
import { executeStealthTransfer } from '@solana-toolkit/services';
import { writeJson } from '@solana-toolkit/utils';

interface RecipientSpec {
  recipients: { address: string; amountRaw: string }[];
}

function parseRecipients(spec: string): RecipientSpec['recipients'] {
  // Accepts: file.json with [{address, amountRaw}] or inline "addr:amount,addr:amount"
  if (spec.endsWith('.json') && fs.existsSync(spec)) {
    const parsed = JSON.parse(fs.readFileSync(spec, 'utf8')) as RecipientSpec['recipients'];
    return parsed.map((r) => ({ address: r.address, amountRaw: r.amountRaw }));
  }
  return spec.split(',').map((entry) => {
    const [address, amount] = entry.trim().split(':');
    if (!address || !amount) throw new Error(`bad recipient spec: ${entry}`);
    return { address: address!, amountRaw: amount! };
  });
}

export function registerSendCommands(program: Command): void {
  const send = program.command('send').description('MultiSender, batch collection, consolidation and stealth transfers');

  send
    .command('token-multisend')
    .description('Token MultiSender — one token to many recipients')
    .requiredOption('--keystore <file>', 'sender keystore')
    .requiredOption('--mint <mint>', 'token mint')
    .requiredOption('--recipients <spec>', 'inline "addr:amountRaw,..." or a JSON file')
    .option('--per-tx <n>', 'recipients per transaction', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; recipients: string; perTx?: number }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const report = await tokenMultiSend(services, {
        token: wallet,
        mint: opts.mint,
        recipients: parseRecipients(opts.recipients).map((r) => ({ address: r.address, amountRaw: BigInt(r.amountRaw) })),
        perTx: opts.perTx,
        mode,
      });
      writeJson('output/token-multisend.json', report);
      printResult(opts, report);
    });

  send
    .command('nft-multisend')
    .description('NFT MultiSender — many NFTs to many recipients')
    .requiredOption('--keystore <file>', 'holder keystore')
    .requiredOption('--sends <spec>', 'JSON file [{mint, to}]')
    .action(async (opts: GlobalOptions & { keystore: string; sends: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const sends = JSON.parse(fs.readFileSync(opts.sends, 'utf8')) as { mint: string; to: string }[];
      const report = await nftMultiSend(services, { holder: wallet, sends, mode });
      printResult(opts, report);
    });

  send
    .command('multi-to-multi')
    .description('Multiple-to-Multiple transfer — paired sources and destinations')
    .requiredOption('--pairs <spec>', 'JSON file [{keystore, to, amountRaw, mint}]')
    .action(async (opts: GlobalOptions & { pairs: string }) => {
      const { services, mode } = await bootstrap(opts);
      const pairs = JSON.parse(fs.readFileSync(opts.pairs, 'utf8')) as {
        keystore: string;
        to: string;
        amountRaw: string;
        mint: string;
      }[];
      const loaded = [];
      for (const p of pairs) {
        loaded.push({
          from: await loadWallet(p.keystore),
          to: p.to,
          amountRaw: BigInt(p.amountRaw),
        });
      }
      const mint = pairs[0]!.mint;
      const report = await multiToMultiTransfer(services, { pairs: loaded, mint, mode });
      printResult(opts, report);
    });

  send
    .command('collect')
    .description('Token Batch Collection — sweep a token from many wallets into one')
    .requiredOption('--sources <spec>', 'JSON array of keystore paths')
    .requiredOption('--destination <address>', 'destination address')
    .requiredOption('--mint <mint>', 'token mint')
    .option('--close', 'close empty source token accounts')
    .action(async (opts: GlobalOptions & { sources: string; destination: string; mint: string; close?: boolean }) => {
      const { services, mode } = await bootstrap(opts);
      const sources = (JSON.parse(fs.readFileSync(opts.sources, 'utf8')) as string[]).map(loadWallet);
      const report = await collectTokens(services, {
        sources: await Promise.all(sources),
        destination: opts.destination,
        mint: opts.mint,
        closeAccounts: opts.close,
        mode,
      });
      printResult(opts, report);
    });

  send
    .command('transfer-all')
    .description('Transfer All Assets — full multi-wallet consolidation (SOL [+ tokens swapped])')
    .requiredOption('--wallets <spec>', 'JSON array of keystore paths')
    .requiredOption('--destination <address>', 'treasury address')
    .option('--swap-tokens', 'swap all tokens to SOL first')
    .option('--leave <lamports>', 'SOL to keep per wallet (raw)', '0')
    .action(async (opts: GlobalOptions & { wallets: string; destination: string; swapTokens?: boolean; leave: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallets = (JSON.parse(fs.readFileSync(opts.wallets, 'utf8')) as string[]).map(loadWallet);
      const report = await consolidateAllAssets(services, {
        wallets: await Promise.all(wallets),
        destination: opts.destination,
        swapTokensToSol: opts.swapTokens,
        leaveLamportsPerWallet: BigInt(opts.leave),
        mode,
      });
      printResult(opts, report);
    });

  send
    .command('stealth')
    .description('Stealth transfer — split via relay wallets with delays (heuristic only)')
    .requiredOption('--keystore <file>', 'source keystore')
    .requiredOption('--destination <address>', 'destination')
    .requiredOption('--relays <spec>', 'JSON array of relay keystore paths')
    .requiredOption('--amount <lamports>', 'total lamports')
    .option('--legs <n>', 'number of legs', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & { keystore: string; destination: string; relays: string; amount: string; legs?: number }) => {
      const { services, mode } = await bootstrap(opts);
      const source = await loadWallet(opts.keystore);
      const relays = (JSON.parse(fs.readFileSync(opts.relays, 'utf8')) as string[]).map(loadWallet);
      const { plan, outcomes } = await executeStealthTransfer(services, {
        source,
        destination: opts.destination,
        totalLamports: BigInt(opts.amount),
        relays: await Promise.all(relays),
        legs: opts.legs,
        mode,
      });
      printResult(opts, { plan, outcomes: outcomes.length });
    });

  send
    .command('claim-sol')
    .description('Claim SOL from many wallets into one destination')
    .requiredOption('--wallets <spec>', 'JSON array of keystore paths')
    .requiredOption('--destination <address>', 'destination')
    .option('--leave <lamports>', 'SOL to keep per wallet (raw)', '0')
    .action(async (opts: GlobalOptions & { wallets: string; destination: string; leave: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallets = (JSON.parse(fs.readFileSync(opts.wallets, 'utf8')) as string[]).map(loadWallet);
      const report = await consolidateAllAssets(services, {
        wallets: await Promise.all(wallets),
        destination: opts.destination,
        leaveLamportsPerWallet: BigInt(opts.leave),
        mode,
      });
      printResult(opts, report);
    });
}
