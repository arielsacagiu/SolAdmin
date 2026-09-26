/**
 * Exchange bulk withdrawal command (Binance, OKX, Bybit, Bitget, Gate.io, MEXC).
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import { printResult, type GlobalOptions } from '../shared.js';
import { bulkWithdraw, credentialsFromEnv } from '@solana-toolkit/services';
import type { WithdrawalRequest } from '@solana-toolkit/types';

export function registerExchangeCommands(program: Command): void {
  const exchange = program.command('exchange').description('Exchange bulk withdrawal via official APIs');

  exchange
    .command('withdraw')
    .description('Submit bulk withdrawals from a CEX (simulation-safe: validate-only by default)')
    .requiredOption('--exchange <name>', 'binance | okx | bybit | bitget | gate | mexc')
    .requiredOption('--requests <spec>', 'JSON file [{asset, network, destinationAddress, amount, clientOrderId?}]')
    .option('--execute', 'actually submit (withdrawal-enabled API keys with IP whitelist required)')
    .action(async (opts: GlobalOptions & { exchange: string; requests: string; execute?: boolean }) => {
      if (opts.execute === true) {
        // eslint-disable-next-line no-console
        console.error(
          'SECURITY: double confirmation required. Exchange withdrawals move real funds.\n' +
          'Re-run with SOLADMIN_SIMULATION_MODE=false AND --execute, and make sure the\n' +
          'destination address is whitelisted on the exchange.',
        );
      }
      const requests = JSON.parse(fs.readFileSync(opts.requests, 'utf8')) as WithdrawalRequest[];
      const credentials = credentialsFromEnv(opts.exchange as never);
      const outcomes = await bulkWithdraw({
        exchange: opts.exchange as never,
        requests,
        simulationMode: !opts.execute,
        credentials,
      });
      printResult(opts, outcomes);
    });
}
