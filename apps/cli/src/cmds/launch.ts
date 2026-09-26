/**
 * Launch commands: Pump.fun launch+buy (≤28 buyers), Moonit launch+buy (≤6),
 * Raydium AMM v4 launch, OpenBook market creation, pool seeding, and
 * creator-fee claims.
 * @module
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { bootstrap, loadWallet, printResult, type GlobalOptions } from '../shared.js';
import {
  getAmmV4PoolState,
  listPoolsForMint,
  moonitLaunchBuy,
  pumpfunLaunchBuy,
  raydiumAmmV4Launch,
  type MoonitLaunchParams,
} from '@solana-toolkit/dex';
import { claimPumpfunCreatorFees } from '@solana-toolkit/services';
import { createCpmmPool, createClmmPool, seedAmmV4Pool } from '@solana-toolkit/dex';
import {
  openbookV1CreateMarketInstructions,
  openbookV2CreateMarketInstructions,
  prepareOpenbookV2Market,
  prepareSerumMarket,
  withRentLamports,
} from '@solana-toolkit/solana-programs';

async function loadBuyerKeystores(spec: string): Promise<import('@solana/web3.js').Keypair[]> {
  const files = JSON.parse(fs.readFileSync(spec, 'utf8')) as string[];
  const wallets = [];
  for (const f of files) wallets.push(await loadWallet(f));
  return wallets;
}

export function registerLaunchCommands(program: Command): void {
  const launch = program.command('launch').description('Launchpad bundles and market/pool creation');

  launch
    .command('pumpfun')
    .description('Pump.fun Launch + Buy (up to 28 simultaneous buyer wallets)')
    .requiredOption('--keystore <file>', 'treasury keystore (creator)')
    .requiredOption('--name <name>')
    .requiredOption('--symbol <symbol>')
    .requiredOption('--uri <uri>')
    .requiredOption('--buyers <spec>', 'JSON array of buyer keystore paths')
    .requiredOption('--buy-sol <lamports>', 'SOL per buyer (raw lamports)')
    .requiredOption('--slippage <bps>', 'slippage bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & { keystore: string; name: string; symbol: string; uri: string; buyers: string; buySol: string; slippage: number }) => {
      const { dex, mode } = await bootstrap(opts);
      const treasury = await loadWallet(opts.keystore);
      const buyers = await loadBuyerKeystores(opts.buyers);
      const result = await pumpfunLaunchBuy(dex, {
        treasury,
        name: opts.name,
        symbol: opts.symbol,
        uri: opts.uri,
        buyers,
        buyLamportsPerBuyer: BigInt(opts.buySol),
        slippageBps: opts.slippage,
        mode,
      });
      printResult(opts, result);
    });

  launch
    .command('moonit')
    .description('Moonit Launch + Buy (up to 6 simultaneous buyer wallets)')
    .requiredOption('--keystore <file>', 'treasury keystore (creator)')
    .requiredOption('--name <name>')
    .requiredOption('--symbol <symbol>')
    .requiredOption('--description <text>')
    .requiredOption('--logo <file>', 'logo image path (uploaded via Moonit API)')
    .requiredOption('--decimals <n>', 'token decimals', (v: string) => parseInt(v, 10))
    .requiredOption('--supply <raw>', 'total supply (raw)')
    .requiredOption('--collateral <lamports>', 'initial collateral collected (raw)')
    .option('--flat', 'use the flat curve (default classic)')
    .requiredOption('--buyers <spec>', 'JSON array of buyer keystore paths (max 6)')
    .requiredOption('--buy-sol <lamports>', 'SOL per buyer (raw lamports)')
    .requiredOption('--slippage <bps>', 'slippage in bps', (v: string) => parseInt(v, 10))
    .action(async (opts: GlobalOptions & Record<string, string | number | boolean | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const treasury = await loadWallet(opts.keystore as string);
      const buyers = await loadBuyerKeystores(opts.buyers as string);
      const launchParams: MoonitLaunchParams = {
        name: opts.name as string,
        symbol: opts.symbol as string,
        description: opts.description as string,
        imageFilePath: opts.logo as string,
        decimals: opts.decimals as number,
        totalSupplyRaw: BigInt(opts.supply as string),
        collateralCollectedLamports: BigInt(opts.collateral as string),
        curveType: opts.flat ? 'flat' : 'classic',
      };
      const result = await moonitLaunchBuy(dex, {
        treasury,
        launch: launchParams,
        buyers,
        buyLamportsPerBuyer: BigInt(opts.buySol as string),
        slippageBps: opts.slippage as number,
        mode,
      });
      printResult(opts, result);
    });

  launch
    .command('raydium-amm-v4')
    .description('Raydium launch: OpenBook V1 market + AMM v4 pool seeding')
    .requiredOption('--keystore <file>', 'treasury')
    .requiredOption('--base-mint <mint>')
    .requiredOption('--quote-mint <mint>', 'usually WSOL')
    .requiredOption('--base-decimals <n>', 'base mint decimals', (v: string) => parseInt(v, 10))
    .requiredOption('--quote-decimals <n>', 'quote mint decimals', (v: string) => parseInt(v, 10))
    .requiredOption('--base-amount <raw>')
    .requiredOption('--quote-amount <raw>')
    .option('--lot-size <n>', 'base lot size', (v: string) => parseFloat(v))
    .option('--tick-size <n>', 'quote tick size', (v: string) => parseFloat(v))
    .action(async (opts: GlobalOptions & Record<string, string | number | undefined>) => {
      const { dex, mode } = await bootstrap(opts);
      const treasury = await loadWallet(opts.keystore as string);
      const result = await raydiumAmmV4Launch(dex, {
        treasury,
        baseMint: new PublicKey(opts.baseMint as string),
        quoteMint: new PublicKey(opts.quoteMint as string),
        baseDecimals: opts.baseDecimals as number,
        quoteDecimals: opts.quoteDecimals as number,
        baseAmountRaw: BigInt(opts.baseAmount as string),
        quoteAmountRaw: BigInt(opts.quoteAmount as string),
        lotSize: opts.lotSize as number | undefined,
        tickSize: opts.tickSize as number | undefined,
        mode,
      });
      printResult(opts, result);
    });

  launch
    .command('openbook-market')
    .description('Create an OpenBook market (V1 or V2)')
    .requiredOption('--keystore <file>', 'payer')
    .requiredOption('--version <v>', '1 or 2')
    .requiredOption('--base-mint <mint>')
    .requiredOption('--quote-mint <mint>')
    .requiredOption('--base-decimals <n>', 'base mint decimals', (v: string) => parseInt(v, 10))
    .requiredOption('--quote-decimals <n>', 'quote mint decimals', (v: string) => parseInt(v, 10))
    .option('--name <name>', 'market name (V2)')
    .action(async (opts: GlobalOptions & Record<string, string | number | undefined>) => {
      const { services, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore as string);
      const baseMint = new PublicKey(opts.baseMint as string);
      const quoteMint = new PublicKey(opts.quoteMint as string);

      let instructions;
      let signers: import('@solana/web3.js').Keypair[];
      if (opts.version === '2') {
        const setup = prepareOpenbookV2Market({ baseMint, quoteMint });
        const built = openbookV2CreateMarketInstructions({
          payer: wallet.publicKey,
          setup,
          baseMint,
          quoteMint,
          name: (opts.name as string) ?? 'SOL-POOL',
          quoteLotSize: 1000n,
          baseLotSize: 1n,
          makerFee: 0n,
          takerFee: 100n,
          timeExpiry: 0n,
        });
        instructions = built.instructions;
        signers = [...built.signers, wallet];
      } else {
        const setup = prepareSerumMarket({
          baseMint,
          quoteMint,
          baseDecimals: opts.baseDecimals as number,
          quoteDecimals: opts.quoteDecimals as number,
        });
        const built = openbookV1CreateMarketInstructions({ payer: wallet.publicKey, setup });
        instructions = built.instructions;
        signers = [...built.signers, wallet];
      }

      // Patch rent-exempt lamports via RPC.
      const rentUnit = await services.rpc.connection.getMinimumBalanceForRentExemption(1);
      const patched = withRentLamports(instructions, (space) => Math.ceil((rentUnit * space) / 1) + 0);

      const outcome = await services.sender.send(
        {
          description: `openbook v${opts.version} market creation`,
          feePayer: wallet.publicKey.toBase58(),
          instructions: patched,
          signers,
        },
        { mode, priorityFee: { computeUnitLimit: 1_400_000, microLamportsPerCu: 400_000 } },
      );
      printResult(opts, outcome);
    });

  launch
    .command('raydium-seed')
    .description('Seed an AMM v4 pool on an existing OpenBook market')
    .requiredOption('--keystore <file>')
    .requiredOption('--market <marketId>')
    .requiredOption('--base-mint <mint>')
    .requiredOption('--quote-mint <mint>')
    .requiredOption('--base-amount <raw>')
    .requiredOption('--quote-amount <raw>')
    .action(async (opts: GlobalOptions & Record<string, string>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const result = await seedAmmV4Pool(dex, {
        payer: wallet,
        marketId: new PublicKey(opts.market),
        baseMint: new PublicKey(opts.baseMint),
        quoteMint: new PublicKey(opts.quoteMint),
        baseAmountRaw: BigInt(opts.baseAmount),
        quoteAmountRaw: BigInt(opts.quoteAmount),
        mode,
      });
      printResult(opts, result);
    });

  launch
    .command('raydium-cpmm')
    .description('Create a Raydium CPMM pool (via official raydium-sdk-v2)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint-a <mint>')
    .requiredOption('--mint-b <mint>')
    .requiredOption('--amount-a <raw>')
    .requiredOption('--amount-b <raw>')
    .action(async (opts: GlobalOptions & Record<string, string>) => {
      const { dex, mode } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const result = await createCpmmPool(dex, {
        payer: wallet,
        mintA: new PublicKey(opts.mintA),
        mintB: new PublicKey(opts.mintB),
        amountA: BigInt(opts.amountA),
        amountB: BigInt(opts.amountB),
      });
      printResult(opts, { ...result, mode });
    });

  launch
    .command('raydium-clmm')
    .description('Create a Raydium CLMM pool (via official raydium-sdk-v2)')
    .requiredOption('--keystore <file>')
    .requiredOption('--mint-a <mint>')
    .requiredOption('--mint-b <mint>')
    .requiredOption('--amount-a <raw>')
    .requiredOption('--amount-b <raw>')
    .action(async (opts: GlobalOptions & Record<string, string>) => {
      const { dex } = await bootstrap(opts);
      const wallet = await loadWallet(opts.keystore);
      const result = await createClmmPool(dex, {
        payer: wallet,
        mintA: new PublicKey(opts.mintA),
        mintB: new PublicKey(opts.mintB),
        amountA: BigInt(opts.amountA),
        amountB: BigInt(opts.amountB),
      });
      printResult(opts, result);
    });

  launch
    .command('claim-creator-fees')
    .description('Claim creator fees from Pump.fun creator vaults (multi-wallet)')
    .requiredOption('--keystores <spec>', 'JSON array of creator keystore paths')
    .action(async (opts: GlobalOptions & { keystores: string }) => {
      const { services, mode } = await bootstrap(opts);
      const wallets = await loadBuyerKeystores(opts.keystores);
      const report = await claimPumpfunCreatorFees(services, { wallets, mode });
      printResult(opts, report);
    });

  launch
    .command('pool-state')
    .description('Read live AMM v4 pool state: vault reserves, LP supply, price, k (read-only)')
    .requiredOption('--pool <poolId>', 'AMM v4 pool id (AMM account)')
    .requiredOption('--base-mint <mint>')
    .requiredOption('--quote-mint <mint>')
    .requiredOption('--market <marketId>', 'OpenBook/Serum market id (pool derivation)')
    .action(async (opts: GlobalOptions & { pool: string; baseMint: string; quoteMint: string; market: string }) => {
      const { dex } = await bootstrap(opts);
      const state = await getAmmV4PoolState(dex, opts.pool, {
        baseMint: opts.baseMint,
        quoteMint: opts.quoteMint,
        marketId: opts.market,
      });
      printResult(opts, state);
    });

  launch
    .command('pool-list')
    .description('List pools for a mint (Raydium API + live AMM v4 vault depth) (read-only)')
    .requiredOption('--mint <mint>')
    .option('--limit <n>', 'top pools to show', (v: string) => parseInt(v, 10))
    .option('--quote-mint <mint>', 'quote mint (default WSOL)')
    .action(async (opts: GlobalOptions & { mint: string; limit?: number; quoteMint?: string }) => {
      const { dex } = await bootstrap(opts);
      const pools = await listPoolsForMint(dex, opts.mint, {
        limit: opts.limit,
        quoteMint: opts.quoteMint,
      });
      printResult(opts, pools);
    });

  void path;
}
