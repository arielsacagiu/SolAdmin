/**
 * On-chain contract audit: metadata, authorities, tax/fee detection, LP
 * status and mint authority review. Produces a structured `TokenAudit`
 * report with human-readable risk findings.
 * @module
 */

import type { TokenAudit } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';
import {
  PROGRAMS,
  WSOL_MINT,
  decodeBondingCurve,
  decodeMoonitCurve,
  metadataPda,
  moonitCurvePda,
  parseMetadataAccount,
  pk,
  pumpBondingCurvePda,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('audit');

/**
 * Audits a token mint: metadata, authorities, extensions, curve state and
 * liquidity. Purely read-only.
 */
export async function auditToken(ctx: ServiceContext, mint: string): Promise<TokenAudit> {
  const findings: string[] = [];
  const mintPk = pk(mint);

  // Mint account.
  const mintInfo = await ctx.rpc.connection.getParsedAccountInfo(mintPk);
  const parsedMint = (
    mintInfo.value?.data as
      | { parsed?: { info?: { decimals?: number; supply?: string; mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: { extension: string; state?: unknown }[] } } }
      | undefined
  )?.parsed?.info;
  if (!parsedMint) throw new Error(`mint ${mint} not found on-chain`);
  const tokenProgram = mintInfo.value!.owner.toBase58();

  if (parsedMint.mintAuthority) {
    findings.push(`MINT AUTHORITY IS SET (${parsedMint.mintAuthority}) — supply can be increased at any time.`);
  } else {
    findings.push('Mint authority revoked — supply is fixed.');
  }
  if (parsedMint.freezeAuthority) {
    findings.push(`FREEZE AUTHORITY IS SET (${parsedMint.freezeAuthority}) — accounts can be frozen.`);
  } else {
    findings.push('No freeze authority — accounts cannot be frozen.');
  }

  // Token-2022 extensions.
  let transferFeeBps: number | undefined;
  let transferHookProgram: string | undefined;
  for (const ext of parsedMint.extensions ?? []) {
    if (ext.extension === 'TransferFeeConfig') {
      const state = ext.state as { newerTransferFee?: { transferFeeBasisPoints?: number }; currentTransferFee?: { transferFeeBasisPoints?: number } };
      transferFeeBps = state.newerTransferFee?.transferFeeBasisPoints ?? state.currentTransferFee?.transferFeeBasisPoints;
      findings.push(`TRANSFER FEE (tax) of ${transferFeeBps} bps detected (Token-2022).`);
    }
    if (ext.extension === 'TransferHook') {
      const state = ext.state as { programId?: string };
      transferHookProgram = state.programId;
      findings.push(`TRANSFER HOOK PROGRAM detected (${transferHookProgram}) — custom tax/transfer logic applies.`);
    }
  }

  // Metadata.
  let metadata;
  const metaInfo = await ctx.rpc.accountInfo(metadataPda(mint).toBase58());
  if (metaInfo) {
    metadata = (() => {
      const m = parseMetadataAccount(Buffer.from(metaInfo.data));
      return { name: m.name, symbol: m.symbol, uri: m.uri, description: undefined };
    })();
  }

  // Pump.fun curve.
  let pumpfun: TokenAudit['pumpfun'];
  const curveInfo = await ctx.rpc.accountInfo(pumpBondingCurvePda(mint).toBase58());
  if (curveInfo) {
    const curve = decodeBondingCurve(Buffer.from(curveInfo.data));
    pumpfun = {
      bondingCurve: pumpBondingCurvePda(mint).toBase58(),
      virtualTokenReserves: curve.virtualTokenReserves.toString(),
      virtualSolReserves: curve.virtualSolReserves.toString(),
      realTokenReserves: curve.realTokenReserves.toString(),
      realSolReserves: curve.realSolReserves.toString(),
      complete: curve.complete,
    };
    findings.push(curve.complete
      ? 'Pump.fun curve GRADUATED — trading lives on PumpSwap.'
      : 'Active Pump.fun bonding curve (pre-graduation).');
  }

  // Moonit curve.
  const moonCurveInfo = await ctx.rpc.accountInfo(moonitCurvePda(mint).toBase58());
  if (moonCurveInfo) {
    const moonCurve = decodeMoonitCurve(Buffer.from(moonCurveInfo.data));
    findings.push(moonCurve.migrated
      ? 'Moonit curve migrated.'
      : `Active Moonit curve — collateral collected: ${moonCurve.collateralCollected} lamports.`);
  }

  // LP status on Raydium + PumpSwap via public APIs.
  const liquidity: TokenAudit['liquidity'] = [];
  try {
    const { fetchRaydiumPoolsByMints } = await import('@solana-toolkit/solana-programs');
    const apiBase = process.env['SOLADMIN_RAYDIUM_API_BASE'] ??
      (ctx.config.rpc.cluster === 'devnet' ? 'https://api-v3-devnet.raydium.io' : 'https://api-v3.raydium.io');
    const pools = await fetchRaydiumPoolsByMints(apiBase, mint, WSOL_MINT);
    for (const pool of pools.slice(0, 5)) {
      liquidity.push({ venue: `raydium ${pool.type}`, pool: pool.id, liquidityRaw: String(pool.liquidity) });
    }
    if (pools.length === 0 && !pumpfun) findings.push('No Raydium liquidity found for this mint.');
  } catch (err) {
    log.debug({ err }, 'raydium liquidity lookup failed');
  }
  if (pumpfun?.complete) {
    liquidity.push({ venue: 'pumpswap', pool: '(graduated pool)', liquidityRaw: 'see pumpswap accounts' });
  }

  log.info({ mint, findings: findings.length }, 'audit complete');
  return {
    mint,
    tokenProgram,
    decimals: parsedMint.decimals ?? 9,
    supplyRaw: parsedMint.supply ?? '0',
    mintAuthority: parsedMint.mintAuthority ?? null,
    freezeAuthority: parsedMint.freezeAuthority ?? null,
    metadata,
    transferFeeBps,
    transferHookProgram,
    pumpfun,
    liquidity,
    findings,
  };
}

export { PROGRAMS };
