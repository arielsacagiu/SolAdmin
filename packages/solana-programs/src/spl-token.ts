/**
 * SPL Token and Token-2022 operations: mint creation with extensions,
 * transfers, burns, mint-to, authority management, freeze/thaw, and WSOL
 * wrapping. Built on the official `@solana/spl-token` library.
 * @module
 */

import {
  AuthorityType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createFreezeAccountInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createSyncNativeInstruction,
  createThawAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
  type Account,
  type Mint,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import type { TokenProgramKind, TransferFeeConfigSpec } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';
import { WSOL_MINT, pk } from './constants.js';

const log = moduleLogger('spl-token');

export function tokenProgramId(kind: TokenProgramKind): PublicKey {
  return kind === 'token-2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Returns the on-chain account size for a mint of the given configuration.
 * SPL mints are 82 bytes; Token-2022 adds extension space (transfer fee: 55,
 * transfer hook: 34; metadata pointer handled by the metadata module).
 */
export function mintAccountSize(params: {
  program: TokenProgramKind;
  transferFee?: TransferFeeConfigSpec | undefined;
  transferHookProgramId?: string | undefined;
}): number {
  let size = params.program === 'token-2022' ? 82 : 82;
  if (params.program === 'token-2022' && params.transferFee) size += 55;
  if (params.program === 'token-2022' && params.transferHookProgramId) size += 34;
  return size;
}

/**
 * Creates a mint (SPL or Token-2022), optionally with a transfer-fee
 * extension (Token-2022 "tax") and a transfer hook (custom tax program).
 *
 * `rentLamports` must be the rent-exempt minimum for `mintAccountSize(...)`
 * bytes — fetch it via `getMinimumBalanceForRentExemption` before calling.
 * Returns the instructions and the mint keypair (must be signed by caller).
 */
export function createMintInstructions(params: {
  payer: PublicKey;
  mintAuthority: PublicKey;
  freezeAuthority?: PublicKey | null;
  decimals: number;
  program: TokenProgramKind;
  transferFee?: TransferFeeConfigSpec;
  transferHookProgramId?: string;
  /** Rent-exempt lamports for the mint account (required). */
  rentLamports: bigint;
}): { instructions: TransactionInstruction[]; mintKeypair: Keypair } {
  const mintKeypair = Keypair.generate();
  const programId = tokenProgramId(params.program);
  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: Number(params.rentLamports),
      space: mintAccountSize(params),
      programId,
    }),
  ];

  if (params.program === 'token-2022' && params.transferFee) {
    if (params.transferFee.bps > 10_000) throw new Error('transfer fee bps must be <= 10000');
    instructions.push(
      createInitializeTransferFeeConfigInstruction(
        mintKeypair.publicKey,
        params.transferFee.transferFeeAuthority
          ? pk(params.transferFee.transferFeeAuthority)
          : params.mintAuthority,
        params.mintAuthority,
        params.transferFee.bps,
        params.transferFee.maxFeeRaw,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  if (params.program === 'token-2022' && params.transferHookProgramId) {
    instructions.push(
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey,
        params.mintAuthority,
        pk(params.transferHookProgramId),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  instructions.push(
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      params.decimals,
      params.mintAuthority,
      params.freezeAuthority ?? null,
      programId,
    ),
  );

  log.debug({ mint: mintKeypair.publicKey.toBase58(), program: params.program }, 'mint instructions built');
  return { instructions, mintKeypair };
}

/** Instructions to create (if needed) the owner's ATA and mint `amount` to it. */
export function mintToInstructions(params: {
  payer: PublicKey;
  mint: string;
  tokenProgram: PublicKey;
  destinationOwner: PublicKey;
  amountRaw: bigint;
}): TransactionInstruction[] {
  const ata = getAssociatedTokenAddressSync(pk(params.mint), params.destinationOwner, true, params.tokenProgram);
  return [
    createAssociatedTokenAccountInstruction(params.payer, ata, params.destinationOwner, pk(params.mint), params.tokenProgram),
    createMintToInstruction(pk(params.mint), ata, params.payer, params.amountRaw, [], params.tokenProgram),
  ];
}

/**
 * Transfer between canonical ATAs of two owners, creating the destination ATA
 * when missing (payer covers rent).
 */
export function transferInstructions(params: {
  payer: PublicKey;
  sourceOwner: PublicKey;
  destinationOwner: PublicKey;
  mint: string;
  tokenProgram: PublicKey;
  amountRaw: bigint;
}): TransactionInstruction[] {
  const [source, destination] = [
    getAssociatedTokenAddressSync(pk(params.mint), params.sourceOwner, true, params.tokenProgram),
    getAssociatedTokenAddressSync(pk(params.mint), params.destinationOwner, true, params.tokenProgram),
  ];
  return [
    createAssociatedTokenAccountInstruction(params.payer, destination, params.destinationOwner, pk(params.mint), params.tokenProgram),
    createTransferInstruction(source, destination, params.sourceOwner, params.amountRaw, [], params.tokenProgram),
  ];
}

/** Direct transfer between explicit token accounts (multisend hot path). */
export function transferBetweenAccounts(params: {
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  tokenProgram: PublicKey;
  amountRaw: bigint;
}): TransactionInstruction {
  return createTransferInstruction(
    params.source,
    params.destination,
    params.owner,
    params.amountRaw,
    [],
    params.tokenProgram,
  );
}

/** Burn instruction from an explicit token account. */
export function burnInstruction(params: {
  account: PublicKey;
  mint: PublicKey;
  owner: PublicKey;
  tokenProgram: PublicKey;
  amountRaw: bigint;
}): TransactionInstruction {
  return createBurnInstruction(
    params.account,
    params.mint,
    params.owner,
    params.amountRaw,
    [],
    params.tokenProgram,
  );
}

/**
 * Authority management: revoke or transfer mint/freeze authorities.
 * `newAuthority: null` revokes (irreversible — protects holders).
 */
export function setAuthorityInstruction(params: {
  account: PublicKey;
  authorityKind: AuthorityType;
  currentAuthority: PublicKey;
  newAuthority: PublicKey | null;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return createSetAuthorityInstruction(
    params.account,
    params.currentAuthority,
    params.authorityKind,
    params.newAuthority,
    [],
    params.tokenProgram,
  );
}

/** Convenience: revoke mint authority. IRREVERSIBLE. */
export function revokeMintAuthority(mint: string, currentAuthority: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return setAuthorityInstruction({
    account: pk(mint),
    authorityKind: 0 satisfies AuthorityType, // MintTokens
    currentAuthority,
    newAuthority: null,
    tokenProgram,
  });
}

/** Convenience: revoke freeze authority. IRREVERSIBLE. */
export function revokeFreezeAuthority(mint: string, currentAuthority: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return setAuthorityInstruction({
    account: pk(mint),
    authorityKind: 1 satisfies AuthorityType, // FreezeAccount
    currentAuthority,
    newAuthority: null,
    tokenProgram,
  });
}

/** Freeze (or thaw) a token account. Requires the mint's freeze authority. */
export function freezeOrThawInstruction(params: {
  account: PublicKey;
  mint: PublicKey;
  freezeAuthority: PublicKey;
  freeze: boolean;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  return params.freeze
    ? createFreezeAccountInstruction(params.account, params.mint, params.freezeAuthority, [], params.tokenProgram)
    : createThawAccountInstruction(params.account, params.mint, params.freezeAuthority, [], params.tokenProgram);
}

// ---------------------------------------------------------------------------
// WSOL helpers
// ---------------------------------------------------------------------------

/**
 * Wraps SOL: create (if needed) + fund + sync the wrapped SOL account.
 */
export function wrapSolInstructions(params: {
  payer: PublicKey;
  amountLamports: bigint;
  tokenProgram?: PublicKey;
}): { instructions: TransactionInstruction[]; wsolAccount: PublicKey } {
  const program = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, params.payer, false, program);
  return {
    instructions: [
      createAssociatedTokenAccountInstruction(params.payer, wsol, params.payer, NATIVE_MINT, program),
      SystemProgram.transfer({ fromPubkey: params.payer, toPubkey: wsol, lamports: params.amountLamports }),
      createSyncNativeInstruction(wsol, program),
    ],
    wsolAccount: wsol,
  };
}

/**
 * Unwraps SOL: close the WSOL account, returning balance + rent to the owner.
 */
export function unwrapSolInstructions(params: {
  owner: PublicKey;
  destination?: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction[] {
  const program = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, params.owner, false, program);
  return [createCloseAccountInstruction(wsol, params.destination ?? params.owner, params.owner, [], program)];
}

export {
  AuthorityType,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
};
export type { Account, Mint };
export { WSOL_MINT };
