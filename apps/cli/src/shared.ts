/**
 * Shared CLI utilities: config loading, keystore loading, mode handling and
 * output helpers shared by all commands.
 * @module
 */

import { Keypair } from '@solana/web3.js';
import type { ToolkitConfig } from '@solana-toolkit/types';
import {
  loadEnvFile,
  loadToolkitConfig,
  showSecurityBanner,
} from '@solana-toolkit/utils';
import { loadKeystoreInteractive } from '@solana-toolkit/wallet-manager';
import { createServiceContext, type ServiceContext } from '@solana-toolkit/services';
import { createDexContext, type DexContext } from '@solana-toolkit/dex';

/** Common CLI options handled by the root program. */
export interface GlobalOptions {
  config?: string;
  execute?: boolean;
  json?: boolean;
  quiet?: boolean;
}

/**
 * Loads config + env, shows the security banner, and returns everything the
 * commands need.
 */
export async function bootstrap(opts: GlobalOptions): Promise<{
  config: ToolkitConfig;
  services: ServiceContext;
  dex: DexContext;
  mode: 'simulate' | 'execute';
}> {
  loadEnvFile();
  showSecurityBanner();
  const config = loadToolkitConfig(opts.config);
  // `--execute` is required to leave simulation mode, and only works when
  // SOLADMIN_SIMULATION_MODE is explicitly set to false.
  const wantsExecute = opts.execute === true && config.safety.simulationMode === false;
  if (opts.execute === true && config.safety.simulationMode === true) {
    // eslint-disable-next-line no-console
    console.error(
      'REFUSING TO EXECUTE: SOLADMIN_SIMULATION_MODE=true (or unset) in your environment.\n' +
      'To send real transactions set SOLADMIN_SIMULATION_MODE=false in .env and re-run with --execute.',
    );
    process.exitCode = 2;
  }
  config.safety.simulationMode = !wantsExecute;
  const services = createServiceContext(config);
  const dex = createDexContext(config);
  return { config, services, dex, mode: wantsExecute ? 'execute' : 'simulate' };
}

/**
 * Loads a keystore interactively (prompts for password when encrypted).
 */
export async function loadWallet(file: string): Promise<Keypair> {
  return loadKeystoreInteractive(file);
}

/**
 * Prints JSON or a table row depending on --json.
 */
export function printResult(opts: GlobalOptions, data: unknown): void {
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(data);
  }
}
