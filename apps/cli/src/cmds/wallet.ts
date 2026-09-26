/**
 * Wallet commands: keystore management, batch generation, vanity addresses,
 * batch balance checks.
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  generateBatchWallets,
  generateKeystore,
  generateVanityWallets,
  loadBatchWallets,
  readPassword,
  writeEncryptedKeystore,
} from '@solana-toolkit/wallet-manager';
import { checkBalances } from '@solana-toolkit/wallet-manager';
import { writeCsv, writeJson } from '@solana-toolkit/utils';

export function registerWalletCommands(program: Command): void {
  const wallet = program.command('wallet').description('Wallet generation, keystores and balance checks');

  wallet
    .command('keystore-create')
    .description('Create a new password-encrypted JSON keystore')
    .requiredOption('--out <file>', 'output keystore file')
    .option('--label <label>', 'wallet label')
    .action(async (opts: GlobalOptions & { out: string; label?: string }) => {
      const password = await readPassword('Choose keystore password: ');
      const confirm = await readPassword('Confirm password: ');
      if (password !== confirm) throw new Error('passwords do not match');
      const { keypair } = generateKeystore(opts.out, password, opts.label);
      printResult(opts, { created: opts.out, publicKey: keypair.publicKey.toBase58() });
    });

  wallet
    .command('keystore-import')
    .description('Import an existing secret key into an encrypted keystore')
    .requiredOption('--secret <hexOrArrayJson>', '64-byte secret key (hex or JSON array)')
    .requiredOption('--out <file>', 'output keystore file')
    .option('--label <label>', 'wallet label')
    .action(async (opts: GlobalOptions & { secret: string; out: string; label?: string }) => {
      const { Keypair } = await import('@solana/web3.js');
      const secret = opts.secret.trim().startsWith('[')
        ? Uint8Array.from(JSON.parse(opts.secret) as number[])
        : Uint8Array.from(Buffer.from(opts.secret.trim(), 'hex'));
      const keypair = Keypair.fromSecretKey(secret);
      const password = await readPassword('Choose keystore password: ');
      writeEncryptedKeystore(keypair, password, opts.out, opts.label);
      printResult(opts, { imported: opts.out, publicKey: keypair.publicKey.toBase58() });
    });

  wallet
    .command('keystore-info')
    .description('Show the public key stored in a keystore (no password needed)')
    .requiredOption('--keystore <file>', 'keystore file')
    .action(async (opts: GlobalOptions & { keystore: string }) => {
      const { readKeystorePublicKey, loadKeystore } = await import('@solana-toolkit/wallet-manager');
      let publicKey: string;
      try {
        publicKey = readKeystorePublicKey(opts.keystore);
      } catch {
        const kp = loadKeystore(opts.keystore);
        publicKey = kp.publicKey.toBase58();
      }
      printResult(opts, { keystore: opts.keystore, publicKey });
    });

  wallet
    .command('generate')
    .description('Batch wallet generator — encrypted keystores + public batch.json')
    .requiredOption('--count <n>', 'number of wallets', (v: string) => parseInt(v, 10))
    .requiredOption('--out <dir>', 'output directory')
    .option('--prefix <prefix>', 'wallet label prefix', 'wallet')
    .action(async (opts: GlobalOptions & { count: number; out: string; prefix: string }) => {
      const password = await readPassword('Choose keystore password for the batch: ');
      const confirm = await readPassword('Confirm password: ');
      if (password !== confirm) throw new Error('passwords do not match');
      const result = generateBatchWallets({
        outDir: opts.out,
        count: opts.count,
        labelPrefix: opts.prefix,
        password,
      });
      printResult(opts, {
        generated: result.wallets.length,
        batchFile: result.batchFile,
        outDir: result.outDir,
      });
    });

  wallet
    .command('vanity')
    .description('Vanity address generator (prefix/suffix matching)')
    .option('--starts-with <prefix>', 'required prefix (base58)')
    .option('--ends-with <suffix>', 'required suffix (base58)')
    .option('--count <n>', 'number of matches', (v: string) => parseInt(v, 10))
    .option('--case-sensitive', 'exact case matching (much slower)')
    .option('--save <dir>', 'save matches as encrypted keystores')
    .action(async (opts: GlobalOptions & { startsWith?: string; endsWith?: string; count?: number; caseSensitive?: boolean; save?: string }) => {
      if (!opts.startsWith && !opts.endsWith) throw new Error('provide --starts-with or --ends-with');
      let password: string | undefined;
      if (opts.save) password = await readPassword('Keystore password for vanity wallets: ');
      const results = generateVanityWallets(
        {
          startsWith: opts.startsWith,
          endsWith: opts.endsWith,
          count: opts.count ?? 1,
          caseSensitive: opts.caseSensitive,
        },
        opts.save,
        password,
      );
      printResult(opts, results.map((r) => ({ publicKey: r.publicKey, attempts: r.attempts.toString(), elapsedMs: r.elapsedMs })));
    });

  wallet
    .command('balance')
    .description('Batch balance checker (SOL + optional tokens) with CSV export')
    .requiredOption('--wallets <file>', 'batch.json file or keystore path')
    .option('--tokens <mints>', 'comma-separated mint list')
    .option('--csv <file>', 'export to CSV')
    .action(async (opts: GlobalOptions & { wallets: string; tokens?: string; csv?: string }) => {
      const { services } = await bootstrap(opts);
      let records: { label: string; publicKey: string }[];
      if (opts.wallets.endsWith('batch.json') && fs.existsSync(opts.wallets)) {
        records = loadBatchWallets(opts.wallets);
      } else {
        const kp = await loadWallet(opts.wallets);
        records = [{ label: 'wallet', publicKey: kp.publicKey.toBase58() }];
      }
      const mints = opts.tokens ? opts.tokens.split(',').map((m) => m.trim()) : [];
      const rows = await checkBalances(services.rpc, records, mints);
      if (opts.csv) {
        writeCsv(
          opts.csv,
          ['label', 'public_key', 'lamports', 'sol', 'tokens'],
          rows.map((r) => [r.label, r.publicKey, r.lamports, r.sol, JSON.stringify(r.tokens, (_, v) => (typeof v === 'bigint' ? v.toString() : v))]),
        );
      } else {
        writeJson('output/balances.json', rows);
      }
      printResult(opts, { wallets: rows.length, csv: opts.csv ?? 'output/balances.json', rows });
    });
}
