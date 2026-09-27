/**
 * Token Creator (SPL + Token-2022 with tax/transfer-fee/metadata) and Clone
 * Token (exact metadata + supply replication from an existing mint).
 *
 * SAFETY: by default mint, freeze and metadata update authorities are
 * revoked at creation time so holders are protected. Keep-authority flows
 * print explicit warnings.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { CreateTokenSpec, SendOutcome, TokenCreationReport } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { ChainContext } from './context.js';
import {
  createMetadataInstructions,
  createMintInstructions,
  mintAccountSize,
  mintToInstructions,
  parseMetadataAccount,
  pk,
  revokeFreezeAuthority,
  revokeMintAuthority,
  revokeMetadataAuthorityInstructions,
  tokenProgramId,
  metadataPda,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('token-creator');

export interface CreateTokenOptions extends CreateTokenSpec {
  payer: Keypair;
  mode?: 'simulate' | 'execute';
}

/**
 * Creates a fully configured token:
 *   1. mint (SPL or Token-2022, with transfer fee / hook when requested)
 *   2. initial supply minted to the payer
 *   3. Metaplex metadata (official mpl-token-metadata createV1)
 *   4. authority revocation per options (default: revoke everything)
 */
export async function createToken(ctx: ChainContext, opts: CreateTokenOptions): Promise<TokenCreationReport> {
  const rentLamports = BigInt(
    await ctx.rpc.connection.getMinimumBalanceForRentExemption(
      mintAccountSize({ program: opts.tokenProgram, transferFee: opts.transferFee, transferHookProgramId: opts.transferHookProgramId }),
    ),
  );
  const { instructions: mintIxs, mintKeypair } = createMintInstructions({
    payer: opts.payer.publicKey,
    mintAuthority: opts.payer.publicKey,
    freezeAuthority: opts.transferFee || opts.keepFreezeAuthority ? opts.payer.publicKey : null,
    decimals: opts.decimals,
    program: opts.tokenProgram,
    transferFee: opts.transferFee,
    transferHookProgramId: opts.transferHookProgramId,
    rentLamports,
  });

  const tokenProgram = tokenProgramId(opts.tokenProgram);
  const supplyIxs = mintToInstructions({
    payer: opts.payer.publicKey,
    mint: mintKeypair.publicKey.toBase58(),
    tokenProgram,
    destinationOwner: opts.payer.publicKey,
    amountRaw: opts.initialSupplyRaw,
  });

  const metadataIxs = createMetadataInstructions({
    payer: opts.payer,
    mint: mintKeypair.publicKey,
    name: opts.metadata.name,
    symbol: opts.metadata.symbol,
    uri: opts.metadata.uri,
    isMutable: !opts.revokeMetadataAuthority,
    tokenProgram: opts.tokenProgram,
  });

  const postIxs: TransactionInstruction[] = [];
  if (!opts.keepMintAuthority) {
    postIxs.push(revokeMintAuthority(mintKeypair.publicKey.toBase58(), opts.payer.publicKey, tokenProgram));
  } else {
    log.warn('MINT AUTHORITY KEPT — you can mint more supply later. Holders are NOT protected.');
  }
  if (!opts.keepFreezeAuthority) {
    postIxs.push(revokeFreezeAuthority(mintKeypair.publicKey.toBase58(), opts.payer.publicKey, tokenProgram));
  }
  if (opts.revokeMetadataAuthority) {
    postIxs.push(...revokeMetadataAuthorityInstructions({ payer: opts.payer, mint: mintKeypair.publicKey }));
  }

  const outcome = await ctx.sender.send(
    {
      description: `create token ${opts.metadata.symbol}`,
      feePayer: opts.payer.publicKey.toBase58(),
      instructions: [...mintIxs, ...supplyIxs, ...metadataIxs, ...postIxs],
      signers: [opts.payer, mintKeypair],
    },
    { mode: opts.mode, priorityFee: { computeUnitLimit: 400_000, microLamportsPerCu: 300_000 } },
  );

  return {
    mint: mintKeypair.publicKey.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    metadataAccount: metadataPda(mintKeypair.publicKey.toBase58()).toBase58(),
    decimals: opts.decimals,
    supplyRaw: opts.initialSupplyRaw.toString(),
    mintAuthorityRevoked: !opts.keepMintAuthority,
    freezeAuthorityRevoked: !opts.keepFreezeAuthority,
    metadataAuthorityRevoked: opts.revokeMetadataAuthority === true,
    signature: outcome.signatures[0],
    simulated: outcome.simulated,
  };
}

export interface CloneTokenOptions {
  payer: Keypair;
  sourceMint: string;
  /** Override the metadata URI (default: copy the source). */
  uriOverride?: string;
  mode?: 'simulate' | 'execute';
  /** Copy transfer fee/tax config (Token-2022). */
  copyExtensions?: boolean;
}

/**
 * Clone Token: reads an existing mint's metadata, decimals and supply, then
 * creates an identical new token (metadata, decimals, supply; optionally
 * transfer-fee extension).
 */
export async function cloneToken(ctx: ChainContext, opts: CloneTokenOptions): Promise<TokenCreationReport> {
  const sourceInfo = await ctx.rpc.connection.getParsedAccountInfo(pk(opts.sourceMint));
  const parsed = (sourceInfo.value?.data as { parsed?: { info?: { decimals?: number; supply?: string; freezeAuthority?: string; mintAuthority?: string } } }).parsed?.info;
  if (!parsed) throw new Error(`source mint ${opts.sourceMint} not found`);
  const decimals = parsed.decimals ?? 9;
  const supply = BigInt(parsed.supply ?? 0);

  // Metadata.
  const metaInfo = await ctx.rpc.accountInfo(metadataPda(opts.sourceMint).toBase58());
  const sourceTokenProgram = sourceInfo.value!.owner;
  let name = 'Cloned Token';
  let symbol = 'CLONE';
  let uri = opts.uriOverride ?? '';
  if (metaInfo) {
    const meta = parseMetadataAccount(Buffer.from(metaInfo.data));
    name = meta.name;
    symbol = meta.symbol;
    uri = opts.uriOverride ?? meta.uri;
  }

  // Transfer fee extension (Token-2022 only).
  let transferFee: { bps: number; maxFeeRaw: bigint } | undefined;
  if (opts.copyExtensions && sourceTokenProgram.toBase58() === 'TokenzQdBNbLqP5VEhMoASNFJRrDh1uudaQUkuoZ4D') {
    const ext = await ctx.rpc.connection.getParsedAccountInfo(pk(opts.sourceMint));
    const feeInfo = (ext.value?.data as { parsed?: { info?: { extensions?: { extension: string; state?: { transferFeeConfig?: { newerTransferFee?: { transferFeeBasisPoints: number; maximumFee: string } } } }[] } } }).parsed?.info?.extensions
      ?.find((e) => e.extension === 'TransferFeeConfig');
    const fee = feeInfo?.state?.transferFeeConfig?.newerTransferFee;
    if (fee) {
      transferFee = { bps: fee.transferFeeBasisPoints, maxFeeRaw: BigInt(fee.maximumFee) };
    }
  }

  const report = await createToken(ctx, {
    metadata: { name, symbol, uri, description: `clone of ${opts.sourceMint}` },
    decimals,
    initialSupplyRaw: supply,
    tokenProgram: sourceTokenProgram.toBase58() === 'TokenzQdBNbLqP5VEhMoASNFJRrDh1uudaQUkuoZ4D' ? 'token-2022' : 'spl',
    transferFee: transferFee ? { bps: transferFee.bps, maxFeeRaw: transferFee.maxFeeRaw } : undefined,
    keepMintAuthority: false,
    keepFreezeAuthority: false,
    revokeMetadataAuthority: true,
    payer: opts.payer,
    mode: opts.mode,
  });
  log.info({ from: opts.sourceMint, clone: report.mint }, 'token cloned');
  return report;
}

export { SendOutcome };
