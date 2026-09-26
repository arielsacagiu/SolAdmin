#!/usr/bin/env node
/**
 * `soladmin` — program assembly and entry point.
 *
 * Every command group lives in `./cmds/*`; all of them default to
 * simulation mode unless `--execute` is passed AND the environment allows it.
 * @module
 */

import { Command, Option } from 'commander';
import { registerWalletCommands } from './cmds/wallet.js';
import { registerSendCommands } from './cmds/send.js';
import { registerTokenCommands } from './cmds/token.js';
import { registerSwapCommands } from './cmds/swap.js';
import { registerLaunchCommands } from './cmds/launch.js';
import { registerTradingCommands } from './cmds/trading.js';
import { registerExchangeCommands } from './cmds/exchange.js';
import { registerChainCommands } from './cmds/chain.js';
import { registerLifecycleCommand } from './cmds/lifecycle.js';
import { registerVolbotCommands } from './cmds/volbot.js';

const program = new Command();

program
  .name('soladmin')
  .description(
    'Self-contained Solana toolkit: token/NFT tooling, launchpads, DEX automation, Jito bundles.\n' +
    'SIMULATION MODE IS ON BY DEFAULT. Add --execute (with SOLADMIN_SIMULATION_MODE=false) to send transactions.',
  )
  .version('1.0.0')
  .addOption(new Option('--config <file>', 'toolkit config file (YAML or JSON)').env('SOLADMIN_CONFIG_FILE'))
  .addOption(new Option('--execute', 'execute for real (requires SOLADMIN_SIMULATION_MODE=false)'))
  .addOption(new Option('--json', 'machine-readable JSON output'))
  .addOption(new Option('--quiet', 'suppress banners and logs'));

registerWalletCommands(program);
registerSendCommands(program);
registerTokenCommands(program);
registerSwapCommands(program);
registerLaunchCommands(program);
registerTradingCommands(program);
registerExchangeCommands(program);
registerChainCommands(program);
registerLifecycleCommand(program);
registerVolbotCommands(program);

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
