/**
 * Security warnings and guards. Every command path flows through these helpers
 * so users always see the same, unmissable guidance.
 * @module
 */

import { logger } from './logger.js';

export const SECURITY_BANNER = `
================================================================================
  SECURITY NOTICE — SolAdmin operates REAL funds on Solana when executed.
  * Private keys live ONLY in password-encrypted JSON keystores. Never paste
    secret keys into code, env files, chats, or command-line arguments.
  * SIMULATION MODE IS ON BY DEFAULT. Transactions are simulated and never
    sent until you pass --execute AND set SOLADMIN_SIMULATION_MODE=false.
  * Verify mint/owner authorities of any token you interact with; revoke your
    own mint/freeze/metadata authorities after launch to protect holders.
  * Automation can lose money (slippage, MEV, failed bundles). Start on
    devnet, then small mainnet amounts.
================================================================================
`;

/**
 * Prints the standard security banner once per process.
 */
let bannerShown = false;
export function showSecurityBanner(): void {
  if (bannerShown || process.env['NODE_ENV'] === 'test') return;
  bannerShown = true;
  // eslint-disable-next-line no-console
  console.error(SECURITY_BANNER);
}

/**
 * Warns loudly about a mainnet action that will move real funds.
 * @returns true when the caller should continue.
 */
export function warnIfMainnetExecution(cluster: string, mode: 'simulate' | 'execute'): boolean {
  if (mode === 'simulate') return true;
  const log = logger();
  log.warn({ cluster }, 'EXECUTION MODE ENABLED — real funds will move');
  if (cluster === 'mainnet') {
    log.warn('You are targeting MAINNET. Double-check amounts, slippage, and tip settings.');
  }
  return true;
}

/**
 * Warns that a keystore file is unencrypted on disk.
 */
export function warnUnencryptedKeystore(path: string): void {
  logger().warn(
    { path },
    'Unencrypted keystore detected. Prefer password-encrypted keystores (wallet keystore create).',
  );
}

/**
 * Confirmation prompt used by irreversible flows (authority revocation,
 * burn, consolidation). Resolves true only when the user types the expected
 * confirmation string.
 */
export async function confirmDangerousPrompt(prompt: string, expect: string = 'CONFIRM'): Promise<boolean> {
  process.stdout.write(`${prompt}\nType ${expect} to continue: `);
  const answer = await new Promise<string>((resolve) => {
    const { stdin } = process;
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.once('data', (d: string) => {
      stdin.pause();
      resolve(d.trim());
    });
  });
  return answer === expect;
}

/**
 * Redacts a string so it can be logged safely (keeps first/last chars).
 */
export function redact(value: string, keep = 4): string {
  if (value.length <= keep * 2) return '***';
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
