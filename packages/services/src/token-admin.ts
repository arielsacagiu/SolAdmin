/**
 * Token Admin Panel — one cohesive surface for every token lifecycle
 * operation, mirroring the layered design of the Solana Foundation's
 * `mosaic` token-management suite (SDK → CLI/dashboard) on top of this
 * toolkit's simulation-first sender.
 *
 * Operations:
 *   SUPPLY      mint additional supply · burn supply · burn LP
 *   ENFORCEMENT freeze / unfreeze a holder · auto-freeze all holders
 *   AUTHORITIES revoke/transfer mint · freeze · metadata-update authorities
 *   METADATA    update name/symbol/URI (+ logo upload elsewhere)
 *   TOKEN-2022  update the transfer fee ("tax") configuration · collect
 *               withheld transfer fees (harvest to mint, then withdraw to
 *               the authority's ATA) · pause / resume the mint (Pausable)
 *
 * SECURITY MODEL:
 *   - every operation is pre-flight simulated before it is sent;
 *   - authority revocations are surfaced as IRREVERSIBLE with the holder-
 *     protection rationale (revoking mint/freeze is the recommended
 *     post-launch state — see SECURITY.md);
 *   - freeze/pause are regulatory-grade powers; every call logs loudly.
 *
 * Token-2022 note: the Pausable, transfer-fee and freeze features are
 * extensions the mint must have been created with (see `token create
 * --token-2022`). Applying them to a plain SPL mint fails in simulation
 * with an extension error — which is exactly why we simulate first.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createHarvestWithheldTokensToMintInstruction,
  createPauseInstruction,
  createResumeInstruction,
  createSetTransferFeeInstruction,
  createWithdrawWithheldTokensFromMintInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { AuthorityAction, SendOutcome, TransferFeeConfigSpec } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';
import {
  burnInstruction,
  freezeOrThawInstruction,
  mintToInstructions,
  updateMetadataInstructions,
  migrateMetadataInstruction,
} from '@solana-toolkit/solana-programs';
import {
  burnToken,
  freezeAccount,
  revokeAllAuthorities,
  applyAuthorityActions,
  autoFreezeAllHolders,
  burnLpByMint,
} from './authorities.js';
export { updateTokenMetadata } from './metadata-update.js';

const log = moduleLogger('token-admin');

/** Everything the panel can do, as one descriptive union. */
export type AdminOperation =
  | { kind: 'mint-supply'; to: string; amountRaw: bigint }
  | { kind: 'burn'; amountRaw: bigint }
  | { kind: 'burn-lp'; lpMint: string; amountRaw?: bigint }
  | { kind: 'freeze'; holder: string }
  | { kind: 'unfreeze'; holder: string }
  | { kind: 'auto-freeze' }
  | { kind: 'authorities'; actions: AuthorityAction[] }
  | { kind: 'revoke-all-authorities' }
  | { kind: 'update-metadata'; name?: string; symbol?: string; uri?: string }
  | { kind: 'set-transfer-fee'; bps: number; maxFeeRaw: bigint }
  | { kind: 'collect-tax'; sources?: string[] }
  | { kind: 'pause' }
  | { kind: 'resume' };

export interface AdminPanelParams {
  /** The authority wallet (mint authority / freeze authority / etc.). */
  authority: Keypair;
  mint: string;
  operations: AdminOperation[];
  mode?: 'simulate' | 'execute';
}

export interface AdminPanelReport {
  /** One outcome per operation, in order. */
  results: { operation: AdminOperation['kind']; outcome: SendOutcome }[];
  ok: number;
  failed: number;
  simulated: boolean;
}

/** Detects the mint's owning token program (SPL vs Token-2022). */
export async function detectTokenProgram(ctx: ServiceContext, mint: string): Promise<PublicKey> {
  const info = await ctx.rpc.accountInfo(mint);
  if (!info) throw new Error(`mint ${mint} not found`);
  return info.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Builds the instructions for one admin operation (pure except for
 * metadata migrations that need the update-authority keypair).
 */
export async function buildAdminInstructions(
  ctx: ServiceContext,
  params: AdminPanelParams,
  op: AdminOperation,
): Promise<TransactionInstruction[]> {
  const mintPk = new PublicKey(params.mint);
  const tokenProgram = await detectTokenProgram(ctx, params.mint);
  const authority = params.authority;

  switch (op.kind) {
    case 'mint-supply':
      if (tokenProgram.equals(TOKEN_PROGRAM_ID) === false && tokenProgram.equals(TOKEN_2022_PROGRAM_ID) === false) {
        throw new Error('unsupported token program');
      }
      return mintToInstructions({
        payer: authority.publicKey,
        mint: params.mint,
        tokenProgram,
        destinationOwner: new PublicKey(op.to),
        amountRaw: op.amountRaw,
      });

    case 'burn': {
      const ata = getAssociatedTokenAddressSync(mintPk, authority.publicKey, true, tokenProgram);
      return [
        burnInstruction({
          account: ata,
          mint: mintPk,
          owner: authority.publicKey,
          tokenProgram,
          amountRaw: op.amountRaw,
        }),
      ];
    }

    case 'freeze':
    case 'unfreeze': {
      const holderAta = getAssociatedTokenAddressSync(mintPk, new PublicKey(op.holder), true, tokenProgram);
      return [
        freezeOrThawInstruction({
          account: holderAta,
          mint: mintPk,
          freezeAuthority: authority.publicKey,
          freeze: op.kind === 'freeze',
          tokenProgram,
        }),
      ];
    }

    case 'authorities': {
      // applyAuthorityActions sends its own transaction; the panel runs it
      // as a dedicated sub-flow and reports its outcome.
      const result = await applyAuthorityActions(ctx, {
        wallet: authority,
        mint: params.mint,
        actions: op.actions,
        mode: params.mode,
      });
      // Sentinel: no inline instructions; caller reports from the sub-flow.
      log.info({ applied: result.applied }, 'authority sub-flow complete');
      return [];
    }

    case 'set-transfer-fee': {
      if (op.bps > 10_000) throw new Error('transfer fee bps must be <= 10000');
      if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new Error('set-transfer-fee requires a Token-2022 mint with the TransferFeeConfig extension');
      }
      return [
        createSetTransferFeeInstruction(
          mintPk,
          authority.publicKey,
          [],
          op.bps,
          op.maxFeeRaw,
          TOKEN_2022_PROGRAM_ID,
        ),
      ];
    }

    case 'collect-tax': {
      if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new Error('collect-tax requires a Token-2022 mint with the TransferFeeConfig extension');
      }
      const destination = getAssociatedTokenAddressSync(mintPk, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
      if (op.sources && op.sources.length > 0) {
        const sourceAtas = op.sources.map((owner) =>
          getAssociatedTokenAddressSync(mintPk, new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID),
        );
        // Harvest first (permissionless sweep of per-account withheld fees
        // into the mint's withheld aggregate), then withdraw from accounts.
        return [
          createHarvestWithheldTokensToMintInstruction(mintPk, sourceAtas, TOKEN_2022_PROGRAM_ID),
          createWithdrawWithheldTokensFromAccountsInstruction(
            mintPk,
            destination,
            authority.publicKey,
            [],
            sourceAtas,
            TOKEN_2022_PROGRAM_ID,
          ),
        ];
      }
      // Withheld fees accumulate on the mint itself; withdraw them all.
      return [
        createWithdrawWithheldTokensFromMintInstruction(
          mintPk,
          destination,
          authority.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ];
    }

    case 'pause':
    case 'resume': {
      if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new Error(`${op.kind} requires a Token-2022 mint with the Pausable extension`);
      }
      const ix =
        op.kind === 'pause'
          ? createPauseInstruction(mintPk, authority.publicKey, [], TOKEN_2022_PROGRAM_ID)
          : createResumeInstruction(mintPk, authority.publicKey, [], TOKEN_2022_PROGRAM_ID);
      if (op.kind === 'pause') {
        log.warn('PAUSING A MINT disables ALL token interactions for every holder');
      }
      return [ix];
    }

    case 'update-metadata': {
      return updateMetadataInstructions({
        payer: authority,
        mint: mintPk,
        name: op.name,
        symbol: op.symbol,
        uri: op.uri,
      });
    }

    default:
      throw new Error(`operation ${op['kind' as keyof AdminOperation]} is handled as a sub-flow, not inline`);
  }
}

/**
 * Runs a batch of admin operations, each through the simulation-first
 * sender. Sub-flow operations (auto-freeze, revoke-all, burn-lp, metadata
 * logo upload) delegate to their dedicated service functions and their
 * outcomes are folded into the report.
 */
export async function runAdminPanel(
  ctx: ServiceContext,
  params: AdminPanelParams,
): Promise<AdminPanelReport> {
  const mode = params.mode ?? (ctx.sender.effectiveMode() as 'simulate' | 'execute');
  const report: AdminPanelReport = { results: [], ok: 0, failed: 0, simulated: mode === 'simulate' };

  for (const op of params.operations) {
    try {
      // Sub-flow operations with their own transaction semantics.
      switch (op.kind) {
        case 'auto-freeze': {
          const result = await autoFreezeAllHolders(ctx, {
            authority: params.authority,
            mint: params.mint,
            mode,
          });
          report.results.push({ operation: op.kind, outcome: result.outcomes[0] ?? emptyOutcome(mode) });
          report.ok++;
          continue;
        }
        case 'revoke-all-authorities': {
          const result = await revokeAllAuthorities(ctx, {
            wallet: params.authority,
            mint: params.mint,
            mode,
          });
          report.results.push({ operation: op.kind, outcome: result.outcomes[0] ?? emptyOutcome(mode) });
          report.ok++;
          continue;
        }
        case 'burn-lp': {
          const outcome = await burnLpByMint(ctx, {
            wallet: params.authority,
            lpMint: op.lpMint,
            amountRaw: op.amountRaw,
            mode,
          });
          report.results.push({ operation: op.kind, outcome });
          report.ok++;
          continue;
        }
        case 'burn': {
          const outcome = await burnToken(ctx, {
            wallet: params.authority,
            mint: params.mint,
            amountRaw: op.amountRaw,
            mode,
          });
          report.results.push({ operation: op.kind, outcome });
          report.ok++;
          continue;
        }
        default:
          break;
      }

      const instructions = await buildAdminInstructions(ctx, params, op);
      if (instructions.length === 0) {
        // Handled inside buildAdminInstructions (authority sub-flow).
        report.ok++;
        report.results.push({ operation: op.kind, outcome: emptyOutcome(mode) });
        continue;
      }
      const outcome = await ctx.sender.send(
        {
          description: `admin panel: ${op.kind} ${params.mint}`,
          feePayer: params.authority.publicKey.toBase58(),
          instructions,
          signers: [params.authority],
        },
        { mode, priorityFee: { computeUnitLimit: 300_000, microLamportsPerCu: 300_000 } },
      );
      report.results.push({ operation: op.kind, outcome });
      report.ok++;
    } catch (err) {
      report.failed++;
      log.error({ err, operation: op.kind }, 'admin operation failed');
      report.results.push({
        operation: op.kind,
        outcome: {
          signature: '',
          signatures: [],
          simulated: mode === 'simulate',
          elapsedMs: 0,
          warnings: [String(err)],
        },
      });
    }
  }

  log.info({ ok: report.ok, failed: report.failed }, 'admin panel batch complete');
  return report;
}

function emptyOutcome(mode: 'simulate' | 'execute'): SendOutcome {
  return {
    signature: '(sub-flow)',
    signatures: [],
    simulated: mode === 'simulate',
    elapsedMs: 0,
    warnings: [],
  };
}

/** Convenience wrappers (single-purpose, CLI-friendly). */

/** Mints additional supply to a destination owner. */
export async function adminMintSupply(
  ctx: ServiceContext,
  params: { authority: Keypair; mint: string; to: string; amountRaw: bigint; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const report = await runAdminPanel(ctx, {
    authority: params.authority,
    mint: params.mint,
    operations: [{ kind: 'mint-supply', to: params.to, amountRaw: params.amountRaw }],
    mode: params.mode,
  });
  return report.results[0]!.outcome;
}

/** Updates the Token-2022 transfer fee ("tax") configuration. */
export async function adminSetTransferFee(
  ctx: ServiceContext,
  params: { authority: Keypair; mint: string; bps: number; maxFeeRaw: bigint; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const report = await runAdminPanel(ctx, {
    authority: params.authority,
    mint: params.mint,
    operations: [{ kind: 'set-transfer-fee', bps: params.bps, maxFeeRaw: params.maxFeeRaw }],
    mode: params.mode,
  });
  return report.results[0]!.outcome;
}

/** Collects withheld transfer fees (the mint's accumulated tax). */
export async function adminCollectTax(
  ctx: ServiceContext,
  params: { authority: Keypair; mint: string; sources?: string[]; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const report = await runAdminPanel(ctx, {
    authority: params.authority,
    mint: params.mint,
    operations: [{ kind: 'collect-tax', sources: params.sources }],
    mode: params.mode,
  });
  return report.results[0]!.outcome;
}

/** Pauses / resumes the mint (Token-2022 Pausable extension). */
export async function adminSetPaused(
  ctx: ServiceContext,
  params: { authority: Keypair; mint: string; paused: boolean; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const report = await runAdminPanel(ctx, {
    authority: params.authority,
    mint: params.mint,
    operations: [params.paused ? { kind: 'pause' as const } : { kind: 'resume' as const }],
    mode: params.mode,
  });
  return report.results[0]!.outcome;
}

export { freezeAccount, migrateMetadataInstruction, TransferFeeConfigSpec };
