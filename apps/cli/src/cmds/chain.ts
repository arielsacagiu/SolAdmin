/**
 * Chain tools commands: WSOL converter, airdrop, history, RPC probe.
 * @module
 */

import { Command } from 'commander';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  accountExplorerLinks,
  explorerLinks,
  probeRpcEndpoint,
  reconstructHistory,
  requestAirdrop,
  wsolConvert,
} from '@solana-toolkit/services';

export function registerChainCommands(program: Command): void {
  const chain = program.command('chain').description('General chain tools (WSOL, airdrop, history, RPC probe)');

  chain
    .command('wsol')
    .description('WSOL converter — wrap or unwrap SOL')
    .requiredOption('--keystore <file>')
    .requiredOption('--direction <dir>', 'wrap | unwrap')
    .option('--lamports <n>', 'lamports to wrap (required for wrap)')
    .action(async (opts: GlobalOptions & { keystore: string; direction: string; lamports?: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await wsolConvert(services, {
        wallet,
        direction: opts.direction === 'wrap' ? 'wrap' : 'unwrap',
        lamports: opts.lamports ? BigInt(opts.lamports) : undefined,
        mode,
      });
      printResult(opts, outcome);
    });

  chain
    .command('airdrop')
    .description('Request a devnet/localnet airdrop')
    .requiredOption('--keystore <file>')
    .option('--lamports <n>', 'lamports (default 1 SOL)', '1000000000')
    .action(async (opts: GlobalOptions & { keystore: string; lamports: string }) => {
      const { services } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const sig = await requestAirdrop(services, wallet.publicKey, Number(opts.lamports));
      printResult(opts, { signature: sig, ...explorerLinks(sig) });
    });

  chain
    .command('history')
    .description('Reconstruct transaction history for an address')
    .requiredOption('--address <pubkey>')
    .option('--limit <n>', 'max signatures', '100')
    .action(async (opts: GlobalOptions & { address: string; limit: string }) => {
      const { services } = await bootstrap(opts);
      const entries = await reconstructHistory(services, opts.address, parseInt(opts.limit));
      printResult(opts, { entries: entries.length, file: 'output/transaction-history.jsonl' });
    });

  chain
    .command('probe-rpc')
    .description('Probe the configured RPC endpoint and print its features')
    .action(async (opts: GlobalOptions) => {
      const { services } = await bootstrap(opts);
      const probe = await probeRpcEndpoint(services);
      printResult(opts, probe);
    });

  chain
    .command('links')
    .description('Explorer links for a signature or account')
    .requiredOption('--value <sigOrAddress>')
    .action(async (opts: GlobalOptions & { value: string }) => {
      const links = explorerLinks(opts.value);
      printResult(opts, { ...links, account: accountExplorerLinks(opts.value) });
    });
}
