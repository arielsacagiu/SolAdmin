/**
 * Token commands: create, clone, admin panel, metadata update, audit,
 * holders, website generation, burn/freeze/authorities.
 * @module
 */

import { Command } from 'commander';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  adminCollectTax,
  adminSetPaused,
  adminSetTransferFee,
  applyAuthorityActions,
  auditToken,
  autoFreezeAllHolders,
  burnLpByMint,
  burnToken,
  cloneToken,
  createToken,
  exportHoldersCsv,
  exportNftHoldersCsv,
  freezeAccount,
  generateWebsiteForMint,
  revokeAllAuthorities,
  scanNftHolders,
  scanTokenHolders,
  updateTokenMetadata,
} from '@solana-toolkit/services';
import { writeJson } from '@solana-toolkit/utils';
import { mintToInstructions } from '@solana-toolkit/solana-programs';

export function registerTokenCommands(program: Command): void {
  const token = program.command('token').description('Token creation, cloning, admin, audit and holders');

  token
    .command('create')
    .description('Token Creator — SPL or Token-2022 with tax/transfer-fee/metadata')
    .requiredOption('--keystore <file>', 'payer keystore')
    .requiredOption('--name <name>')
    .requiredOption('--symbol <symbol>')
    .requiredOption('--uri <uri>', 'metadata URI')
    .requiredOption('--decimals <n>', 'token decimals', (v: string) => parseInt(v, 10))
    .requiredOption('--supply <raw>', 'initial supply (raw base units)')
    .option('--token-2022', 'use Token-2022 program')
    .option('--tax-bps <bps>', 'Token-2022 transfer fee in bps', (v: string) => parseInt(v, 10))
    .option('--tax-max <raw>', 'max transfer fee (raw)')
    .option('--transfer-hook <program>', 'Token-2022 transfer hook program id')
    .option('--keep-mint-authority', 'WARNING: keep mint authority')
    .option('--keep-freeze-authority', 'WARNING: keep freeze authority')
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      const report = await createToken(services, {
        payer: wallet,
        mode,
        metadata: { name: opts.name as string, symbol: opts.symbol as string, uri: opts.uri as string },
        decimals: opts.decimals as number,
        initialSupplyRaw: BigInt(opts.supply as string),
        tokenProgram: opts['token-2022'] ? 'token-2022' : 'spl',
        transferFee:
          opts.taxBps !== undefined
            ? {
                bps: opts.taxBps as number,
                maxFeeRaw: BigInt((opts.taxMax as string) ?? '1000000000'),
              }
            : undefined,
        transferHookProgramId: opts.transferHook as string | undefined,
        keepMintAuthority: Boolean(opts['keepMintAuthority']),
        keepFreezeAuthority: Boolean(opts['keepFreezeAuthority']),
        revokeMetadataAuthority: !opts['keepMintAuthority'],
      });
      writeJson('output/token-create.json', report);
      printResult(opts, report);
    });

  token
    .command('clone')
    .description('Clone Token — replicate metadata, decimals and supply')
    .requiredOption('--keystore <file>', 'payer keystore')
    .requiredOption('--mint <mint>', 'source mint to clone')
    .option('--uri <uri>', 'override metadata URI')
    .option('--copy-extensions', 'copy Token-2022 fee extension')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; uri?: string; copyExtensions?: boolean }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const report = await cloneToken(services, {
        payer: wallet,
        sourceMint: opts.mint,
        uriOverride: opts.uri,
        copyExtensions: opts.copyExtensions,
        mode,
      });
      printResult(opts, report);
    });

  token
    .command('mint')
    .description('Admin panel: mint additional supply (requires kept mint authority)')
    .requiredOption('--keystore <file>', 'mint authority keystore')
    .requiredOption('--mint <mint>')
    .requiredOption('--to <owner>', 'destination owner')
    .requiredOption('--amount <raw>', 'amount in raw units')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; to: string; amount: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const { PublicKey } = await import('@solana/web3.js');
      const { tokenProgramId } = await import('@solana-toolkit/solana-programs');
      const info = await services.rpc.accountInfo(opts.mint);
      if (!info) throw new Error('mint not found');
      const program = info.owner.toBase58().includes('TokenzQ') ? tokenProgramId('token-2022') : tokenProgramId('spl');
      const ixs = mintToInstructions({
        payer: wallet.publicKey,
        mint: opts.mint,
        tokenProgram: program,
        destinationOwner: new PublicKey(opts.to),
        amountRaw: BigInt(opts.amount),
      });
      const outcome = await services.sender.send(
        {
          description: `mint ${opts.amount} of ${opts.mint}`,
          feePayer: wallet.publicKey.toBase58(),
          instructions: ixs,
          signers: [wallet],
        },
        { mode },
      );
      printResult(opts, outcome);
    });

  token
    .command('set-fee')
    .description('Token-2022 admin: update the transfer fee (tax) configuration')
    .requiredOption('--keystore <file>', 'transfer fee authority keystore')
    .requiredOption('--mint <mint>')
    .requiredOption('--bps <n>', 'fee in basis points (max 10000)', (v: string) => parseInt(v, 10))
    .requiredOption('--max-fee <raw>', 'maximum fee in raw base units')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; bps: number; maxFee: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await adminSetTransferFee(services, {
        authority: wallet,
        mint: opts.mint,
        bps: opts.bps,
        maxFeeRaw: BigInt(opts.maxFee),
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('collect-tax')
    .description('Token-2022 admin: collect withheld transfer fees (tax) to your wallet')
    .requiredOption('--keystore <file>', 'withdraw withheld authority (usually mint owner) keystore')
    .requiredOption('--mint <mint>')
    .option('--sources <json>', 'JSON array of token accounts to harvest from (default: harvest all accounts to the mint)')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; sources?: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const sources = opts.sources ? (JSON.parse(opts.sources) as string[]) : undefined;
      const outcome = await adminCollectTax(services, {
        authority: wallet,
        mint: opts.mint,
        sources,
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('pause')
    .description('Token-2022 Pausable extension: pause ALL transfers (censorship-grade control — use with care)')
    .requiredOption('--keystore <file>', 'pause authority keystore')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await adminSetPaused(services, {
        authority: wallet,
        mint: opts.mint,
        paused: true,
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('resume')
    .description('Token-2022 Pausable extension: resume transfers after a pause')
    .requiredOption('--keystore <file>', 'pause authority keystore')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await adminSetPaused(services, {
        authority: wallet,
        mint: opts.mint,
        paused: false,
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('burn')
    .description('Burn token supply from your own wallet (IRREVERSIBLE)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint <mint>')
    .requiredOption('--amount <raw>')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; amount: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await burnToken(services, {
        wallet,
        mint: opts.mint,
        amountRaw: BigInt(opts.amount),
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('burn-liquidity')
    .description('Burn LP tokens of a pool (permanently locks liquidity — IRREVERSIBLE)')
    .requiredOption('--keystore <file>')
    .requiredOption('--lp-mint <lpMint>', 'LP token mint')
    .option('--amount <raw>', 'amount (defaults to full balance)')
    .action(async (opts: GlobalOptions & { keystore: string; lpMint: string; amount?: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await burnLpByMint(services, {
        wallet,
        lpMint: opts.lpMint,
        amountRaw: opts.amount ? BigInt(opts.amount) : undefined,
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('freeze')
    .description('Freeze / unfreeze a holder account (requires freeze authority)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint <mint>')
    .requiredOption('--holder <address>')
    .option('--unfreeze', 'thaw instead of freeze')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; holder: string; unfreeze?: boolean }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const outcome = await freezeAccount(services, {
        authority: wallet,
        mint: opts.mint,
        holder: opts.holder,
        freeze: !opts.unfreeze,
        mode,
      });
      printResult(opts, outcome);
    });

  token
    .command('auto-freeze')
    .description('Auto-Freeze: freeze ALL holder accounts of a mint (use with extreme care)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const report = await autoFreezeAllHolders(services, {
        authority: wallet,
        mint: opts.mint,
        mode,
      });
      printResult(opts, report);
    });

  token
    .command('authorities')
    .description('Authority management (mint / freeze / metadata — revoke or transfer)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint <mint>')
    .option('--revoke-all', 'revoke mint + freeze + metadata authorities (IRREVERSIBLE)')
    .option('--revoke-mint', 'revoke mint authority')
    .option('--revoke-freeze', 'revoke freeze authority')
    .option('--revoke-metadata', 'revoke metadata update authority')
    .option('--transfer-mint <address>', 'transfer mint authority')
    .option('--transfer-freeze <address>', 'transfer freeze authority')
    .option('--transfer-metadata <address>', 'transfer metadata authority')
    .action(async (opts: GlobalOptions & Record<string, string | boolean | undefined>) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      if (opts.revokeAll) {
        const report = await revokeAllAuthorities(services, { wallet, mint: opts.mint as string, mode });
        printResult(opts, report);
        return;
      }
      const actions = [];
      if (opts.revokeMint) actions.push({ kind: 'mint' as const, action: 'revoke' as const });
      if (opts.revokeFreeze) actions.push({ kind: 'freeze' as const, action: 'revoke' as const });
      if (opts.revokeMetadata) actions.push({ kind: 'metadata' as const, action: 'revoke' as const });
      if (opts.transferMint) actions.push({ kind: 'mint' as const, action: 'transfer' as const, newAuthority: opts.transferMint as string });
      if (opts.transferFreeze) actions.push({ kind: 'freeze' as const, action: 'transfer' as const, newAuthority: opts.transferFreeze as string });
      if (opts.transferMetadata) actions.push({ kind: 'metadata' as const, action: 'transfer' as const, newAuthority: opts.transferMetadata as string });
      if (actions.length === 0) throw new Error('no authority action specified');
      const report = await applyAuthorityActions(services, {
        wallet,
        mint: opts.mint as string,
        actions,
        mode,
      });
      printResult(opts, report);
    });

  token
    .command('metadata-update')
    .description('Update token metadata (name / symbol / URI, with logo upload)')
    .requiredOption('--keystore <file>', 'metadata update authority')
    .requiredOption('--mint <mint>')
    .option('--name <name>')
    .option('--symbol <symbol>')
    .option('--uri <uri>')
    .option('--logo <file>', 'logo file to upload (requires --upload-url)')
    .option('--upload-url <url>', 'storage endpoint for the logo')
    .action(async (opts: GlobalOptions & { keystore: string; mint: string; name?: string; symbol?: string; uri?: string; logo?: string; uploadUrl?: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const report = await updateTokenMetadata(services, {
        wallet,
        mint: opts.mint,
        name: opts.name,
        symbol: opts.symbol,
        uri: opts.uri,
        logoFilePath: opts.logo,
        uploadUrl: opts.uploadUrl,
        mode,
      });
      printResult(opts, report);
    });

  token
    .command('audit')
    .description('On-chain contract audit (metadata, authorities, tax, LP status)')
    .requiredOption('--mint <mint>')
    .action(async (opts: GlobalOptions & { mint: string }) => {
      const { services } = await bootstrap(opts);
      const audit = await auditToken(services, opts.mint);
      writeJson(`output/audit-${opts.mint}.json`, audit);
      printResult(opts, audit);
    });

  token
    .command('holders')
    .description('Scan token holders (paginated, CSV export)')
    .requiredOption('--mint <mint>')
    .option('--csv <file>', 'export CSV path', 'output/holders.csv')
    .option('--page-size <n>', 'accounts per page', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & { mint: string; csv: string; pageSize?: number }) => {
      const { services } = await bootstrap(opts);
      const rows = await scanTokenHolders(services, opts.mint, { pageSize: opts.pageSize });
      exportHoldersCsv(opts.csv, rows);
      printResult(opts, { holders: rows.length, csv: opts.csv, top10: rows.slice(0, 10) });
    });

  token
    .command('nft-holders')
    .description('Scan NFT holders for a list of mints')
    .requiredOption('--mints <spec>', 'JSON array of mint addresses')
    .option('--csv <file>', 'export CSV path', 'output/nft-holders.csv')
    .action(async (opts: GlobalOptions & { mints: string; csv: string }) => {
      const { services } = await bootstrap(opts);
      const mints = JSON.parse(opts.mints) as string[];
      const rows = await scanNftHolders(services, mints);
      exportNftHoldersCsv(opts.csv, rows);
      printResult(opts, { holders: rows.length, csv: opts.csv });
    });

  token
    .command('website')
    .description('Create Token View — generate a static website for a token')
    .requiredOption('--mint <mint>')
    .requiredOption('--out <dir>', 'output directory')
    .option('--twitter <url>')
    .option('--telegram <url>')
    .option('--website <url>')
    .action(async (opts: GlobalOptions & { mint: string; out: string; twitter?: string; telegram?: string; website?: string }) => {
      const { services } = await bootstrap(opts);
      const result = await generateWebsiteForMint(services, opts.mint, opts.out, {
        twitter: opts.twitter,
        telegram: opts.telegram,
        website: opts.website,
      });
      printResult(opts, { outDir: result.outDir, index: `${opts.out}/index.html` });
    });
}
