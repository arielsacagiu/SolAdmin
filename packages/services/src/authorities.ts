/**
 * Authority management (market management, token admin panel operations),
 * token burn, burn liquidity, and freeze/unfreeze + auto-freeze utilities.
 *
 * All destructive operations (revoke, burn) require explicit confirmation
 * flows in the CLI; this module only provides the transaction logic.
 * @module
 */

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { AuthorityAction, SendOutcome } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import type { ChainContext } from './context.js';
import { scanTokenHolders } from './holders.js';
import {
  metadataPda,
  pk,
  revokeFreezeAuthority,
  revokeMintAuthority,
  setAuthorityInstruction,
  freezeOrThawInstruction,
  tokenProgramId,
  ammV4CreatePoolInstruction,
  createAssociatedTokenAccountInstruction,
  deriveAmmV4PoolKeys,
  getAssociatedTokenAddressSync as ata,
  burnInstruction,
  pumpCollectCreatorFeeInstruction,
  updateMetadataInstructions,
  migrateMetadataInstruction,
} from '@solana-toolkit/solana-programs';

const log = moduleLogger('authorities');

// ---------------------------------------------------------------------------
// Authority management
// ---------------------------------------------------------------------------

export interface AuthorityOpOptions {
  wallet: Keypair;
  mint: string;
  actions: AuthorityAction[];
  mode?: 'simulate' | 'execute';
}

export interface AuthorityOpReport {
  outcomes: SendOutcome[];
  applied: string[];
}

/**
 * Applies authority actions to a mint: mint / freeze revoke-or-transfer,
 * metadata update authority, and (for token admins) market-level roles.
 */
export async function applyAuthorityActions(
  ctx: ChainContext,
  opts: AuthorityOpOptions,
): Promise<AuthorityOpReport> {
  const mintPk = pk(opts.mint);
  const tokenProgram = await detectProgram(ctx, opts.mint);
  const instructions: TransactionInstruction[] = [];
  const applied: string[] = [];

  for (const action of opts.actions) {
    switch (action.kind) {
      case 'mint':
        instructions.push(
          setAuthorityInstruction({
            account: mintPk,
            authorityKind: 0 as AuthorityType,
            currentAuthority: opts.wallet.publicKey,
            newAuthority: action.action === 'revoke' ? null : action.newAuthority ? pk(action.newAuthority) : null,
            tokenProgram,
          }),
        );
        applied.push(`mint:${action.action}${action.newAuthority ? `→${action.newAuthority}` : ''}`);
        break;
      case 'freeze':
        instructions.push(
          setAuthorityInstruction({
            account: mintPk,
            authorityKind: 1 as AuthorityType,
            currentAuthority: opts.wallet.publicKey,
            newAuthority: action.action === 'revoke' ? null : action.newAuthority ? pk(action.newAuthority) : null,
            tokenProgram,
          }),
        );
        applied.push(`freeze:${action.action}`);
        break;
      case 'metadata': {
        const metaPda = metadataPda(opts.mint);
        instructions.push(
          updateMetadataInstructions({
            payer: opts.wallet,
            mint: mintPk,
            newUpdateAuthority: action.action === 'revoke' ? null : action.newAuthority,
          })[0]!,
        );
        void metaPda;
        applied.push(`metadata:${action.action}`);
        break;
      }
      default:
        log.warn({ kind: action.kind }, 'authority kind not applicable to mints');
    }
  }

  const outcome = await ctx.sender.send(
    {
      description: `authority actions: ${applied.join(', ')}`,
      feePayer: opts.wallet.publicKey.toBase58(),
      instructions,
      signers: [opts.wallet],
    },
    { mode: opts.mode },
  );
  return { outcomes: [outcome], applied };
}

/**
 * Revokes ALL authorities on a mint (mint, freeze, metadata update) — the
 * recommended "safety lock" after launch. IRREVERSIBLE.
 */
export async function revokeAllAuthorities(
  ctx: ChainContext,
  params: { wallet: Keypair; mint: string; mode?: 'simulate' | 'execute' },
): Promise<AuthorityOpReport> {
  return applyAuthorityActions(ctx, {
    wallet: params.wallet,
    mint: params.mint,
    mode: params.mode,
    actions: [
      { kind: 'mint', action: 'revoke' },
      { kind: 'freeze', action: 'revoke' },
      { kind: 'metadata', action: 'revoke' },
    ],
  });
}

// ---------------------------------------------------------------------------
// Burn token + burn liquidity
// ---------------------------------------------------------------------------

/**
 * Burns a token balance from the wallet's ATA. IRREVERSIBLE — reduces supply.
 */
export async function burnToken(
  ctx: ChainContext,
  params: { wallet: Keypair; mint: string; amountRaw: bigint; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const tokenProgram = await detectProgram(ctx, params.mint);
  const ata = getAssociatedTokenAddressSync(pk(params.mint), params.wallet.publicKey, true, tokenProgram);
  return ctx.sender.send(
    {
      description: `burn ${params.amountRaw.toString()} of ${params.mint}`,
      feePayer: params.wallet.publicKey.toBase58(),
      instructions: [
        burnInstruction({
          account: ata,
          mint: pk(params.mint),
          owner: params.wallet.publicKey,
          tokenProgram,
          amountRaw: params.amountRaw,
        }),
      ],
      signers: [params.wallet],
    },
    { mode: params.mode },
  );
}

/**
 * Burns LP tokens of a given LP mint (any venue) — the generic
 * "burn liquidity" primitive. IRREVERSIBLE when the LP mint authority is the
 * pool: burned LP can never be re-minted, permanently locking liquidity.
 */
export async function burnLpByMint(
  ctx: ChainContext,
  params: { wallet: Keypair; lpMint: string; amountRaw?: bigint; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  const tokenProgram = await detectProgram(ctx, params.lpMint);
  const ata = getAssociatedTokenAddressSync(pk(params.lpMint), params.wallet.publicKey, true, tokenProgram);
  let amount = params.amountRaw;
  if (!amount) {
    const bal = await ctx.rpc.connection.getTokenAccountBalance(ata);
    amount = BigInt(bal.value.amount);
  }
  return burnToken(ctx, {
    wallet: params.wallet,
    mint: params.lpMint,
    amountRaw: amount,
    mode: params.mode,
  });
}

// ---------------------------------------------------------------------------
// Freeze / unfreeze / auto-freeze
// ---------------------------------------------------------------------------

/**
 * Freezes or thaws a holder's token account (requires the mint freeze
 * authority — see the security warnings around freezing).
 *
 * `tokenAccount` optionally names the exact token account to freeze. When
 * omitted, the holder's ATA is derived — correct for the common case but
 * blind to non-associated accounts (legacy/custodial token accounts), which
 * holder scans DO see. Callers that scanned accounts (autoFreezeAllHolders)
 * should always pass the scanned account.
 */
export async function freezeAccount(
  ctx: ChainContext,
  params: {
    authority: Keypair;
    mint: string;
    holder: string;
    /** Exact token account to freeze; defaults to the holder's derived ATA. */
    tokenAccount?: string;
    freeze: boolean;
    mode?: 'simulate' | 'execute';
  },
): Promise<SendOutcome> {
  const tokenProgram = await detectProgram(ctx, params.mint);
  const account = params.tokenAccount
    ? pk(params.tokenAccount)
    : getAssociatedTokenAddressSync(pk(params.mint), pk(params.holder), true, tokenProgram);
  return ctx.sender.send(
    {
      description: `${params.freeze ? 'freeze' : 'unfreeze'} ${params.holder}`,
      feePayer: params.authority.publicKey.toBase58(),
      instructions: [
        freezeOrThawInstruction({
          account,
          mint: pk(params.mint),
          freezeAuthority: params.authority.publicKey,
          freeze: params.freeze,
          tokenProgram,
        }),
      ],
      signers: [params.authority],
    },
    { mode: params.mode },
  );
}

/**
 * Auto-Freeze utility: freezes every holder token account of a mint
 * (mass-freeze mode). Use with extreme care — this is a regulatory/enforcement
 * tool, and freezing without cause harms holders.
 */
export async function autoFreezeAllHolders(
  ctx: ChainContext,
  params: { authority: Keypair; mint: string; mode?: 'simulate' | 'execute' },
): Promise<{ frozen: string[]; failures: string[]; outcomes: SendOutcome[] }> {
  // Use paginated full holder scanning (getProgramAccounts) instead of
  // getTokenLargestAccounts, which only returns the top 20 holders.
  const holders = await scanTokenHolders(ctx, params.mint, { pageSize: 10_000, maxAccounts: 100_000 });
  const frozen: string[] = [];
  const failures: string[] = [];
  const outcomes: SendOutcome[] = [];
  for (const holder of holders) {
    // Skip entries where the owner could not be resolved (owner equals the
    // token account address, meaning we have no wallet address to freeze).
    if (holder.owner === holder.publicKey || !holder.owner) continue;
    try {
      const outcome = await freezeAccount(ctx, {
        authority: params.authority,
        mint: params.mint,
        holder: holder.owner,
        // Freeze the exact token account the scan found — NOT a re-derived
        // ATA. Long-tail holders may use non-associated token accounts,
        // which the scan sees but ATA derivation would miss.
        tokenAccount: holder.publicKey,
        freeze: true,
        mode: params.mode,
      });
      frozen.push(holder.owner);
      outcomes.push(outcome);
    } catch (err) {
      failures.push(String(err));
    }
  }
  return { frozen, failures, outcomes };
}

async function detectProgram(ctx: ChainContext, mint: string): Promise<PublicKey> {
  const info = await ctx.rpc.accountInfo(mint);
  if (!info) throw new Error(`mint ${mint} not found`);
  return info.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Claim creator fees from Pump.fun creator vaults for a list of wallets.
 */
export async function claimPumpfunCreatorFees(
  ctx: ChainContext,
  params: { wallets: Keypair[]; mode?: 'simulate' | 'execute' },
): Promise<{ outcomes: SendOutcome[]; failures: string[] }> {
  const outcomes: SendOutcome[] = [];
  const failures: string[] = [];
  for (const wallet of params.wallets) {
    try {
      outcomes.push(
        await ctx.sender.send(
          {
            description: `collect pump.fun creator fees ${wallet.publicKey.toBase58().slice(0, 6)}`,
            feePayer: wallet.publicKey.toBase58(),
            instructions: [pumpCollectCreatorFeeInstruction({ creator: wallet.publicKey })],
            signers: [wallet],
          },
          { mode: params.mode },
        ),
      );
    } catch (err) {
      failures.push(String(err));
    }
  }
  return { outcomes, failures };
}

/** Migrates legacy metadata accounts to the current Token Metadata layout. */
export async function migrateMetadata(
  ctx: ChainContext,
  params: { wallet: Keypair; mint: string; mode?: 'simulate' | 'execute' },
): Promise<SendOutcome> {
  return ctx.sender.send(
    {
      description: `migrate metadata ${params.mint}`,
      feePayer: params.wallet.publicKey.toBase58(),
      instructions: migrateMetadataInstruction({ payer: params.wallet, mint: pk(params.mint) }),
      signers: [params.wallet],
    },
    { mode: params.mode },
  );
}

export { AuthorityType, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, tokenProgramId, createCloseAccountInstruction, createBurnInstruction };
