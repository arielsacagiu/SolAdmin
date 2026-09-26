/**
 * Metaplex Token Metadata operations via the official
 * `@metaplex-foundation/mpl-token-metadata` library.
 *
 * Instructions are produced with the official factory functions and converted
 * to `@solana/web3.js` instructions, so signing/sending still flows through
 * the toolkit's simulation-first sender. Private keys never leave the
 * process — the factories only need public keys/authorities.
 * @module
 */

import { PublicKey, TransactionInstruction, type Keypair } from '@solana/web3.js';
import {
  createSignerFromKeypair,
  createUmi,
  percentAmount,
  type Program,
  type ProgramRepositoryInterface,
  type PublicKey as UmiPublicKey,
  type Umi,
} from '@metaplex-foundation/umi';
import { createWeb3JsEddsa } from '@metaplex-foundation/umi-eddsa-web3js';

import {
  TokenStandard,
  createV1,
  findMetadataPda,
  migrate,
  mplTokenMetadata,
  updateV1,
} from '@metaplex-foundation/mpl-token-metadata';
import {
  fromWeb3JsKeypair,
  fromWeb3JsPublicKey,
  toWeb3JsInstruction,
} from '@metaplex-foundation/umi-web3js-adapters';
import { PROGRAMS, pk } from './constants.js';
import { findPda, readBorshString } from './encoding.js';

/**
 * Minimal offline program repository: enough for the mpl-token-metadata
 * plugin to register its program ID and for instruction factories to resolve
 * it. No RPC required — we never send through umi.
 */
const memoryProgramRepository = (): ProgramRepositoryInterface => {
  const programs = new Map<string, Program>();
  return {
    has: (identifier: string | UmiPublicKey) => programs.has(String(identifier)),
    get: <T extends Program = Program>(identifier: string | UmiPublicKey): T => {
      const program = programs.get(String(identifier));
      if (!program) throw new Error(`program not registered: ${String(identifier)}`);
      return program as T;
    },
    getPublicKey: (identifier: string | UmiPublicKey, fallback?: unknown) =>
      programs.get(String(identifier))?.publicKey ?? (fallback as UmiPublicKey),
    all: () => [...programs.values()],
    add: (program) => {
      programs.set(program.name, program);
      programs.set(program.publicKey, program);
    },
    bind: (abstract, concrete) => {
      programs.set(abstract, programs.get(String(concrete)) as Program);
    },
    unbind: (abstract) => {
      programs.delete(abstract);
    },
    clone: () => memoryProgramRepository(),
    resolveError: () => null,
  };
};

const umi: Umi = createUmi();
// Official web3.js-backed eddsa so signers/PDAs work offline, plus a minimal
// in-memory program repository (the official one requires an RPC context;
// we only build instructions locally — signing/sending stays in web3.js).
umi.eddsa = createWeb3JsEddsa();
umi.programs = memoryProgramRepository();
umi.use(mplTokenMetadata());

/** Converts a web3.js keypair into a umi signer bound to our context. */
function umiSigner(kp: Keypair) {
  return createSignerFromKeypair(umi, fromWeb3JsKeypair(kp));
}

/**
 * Derives the Metaplex metadata PDA for a mint.
 */
export function metadataPda(mint: string): PublicKey {
  return findPda(['metadata', pk(PROGRAMS.METAPLEX_TOKEN_METADATA), pk(mint)], PROGRAMS.METAPLEX_TOKEN_METADATA);
}

/** Parsed on-chain metadata account (core fields). */
export interface ParsedMetadataAccount {
  key: number;
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  primarySaleHappened: boolean;
  isMutable: boolean;
}

/**
 * Parses the well-known Token Metadata account layout (borsh).
 * Account starts with a single `key` byte (4 = metadata) followed by the
 * borsh struct.
 */
export function parseMetadataAccount(data: Buffer): ParsedMetadataAccount {
  let offset = 0;
  const key = data.readUInt8(offset);
  offset += 1;
  const updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const mint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const [name, o1] = readBorshString(data, offset);
  const [symbol, o2] = readBorshString(data, o1);
  const [uri, o3] = readBorshString(data, o2);
  const sellerFeeBasisPoints = data.readUInt16LE(o3);
  const primarySaleHappened = data.readUInt8(o3 + 2) === 1;
  const isMutable = data.readUInt8(o3 + 3) === 1;
  return {
    key,
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    primarySaleHappened,
    isMutable,
  };
}

/**
 * Builds the Metaplex `Create` (createV1) instruction for a fungible token.
 * `payer` supplies the public keys only — signing happens in the sender.
 */
export function createMetadataInstructions(params: {
  payer: Keypair;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  isMutable?: boolean;
  tokenProgram?: 'spl' | 'token-2022';
}): TransactionInstruction[] {
  const authority = umiSigner(params.payer);
  const builder = createV1(umi, {
    mint: fromWeb3JsPublicKey(params.mint),
    authority,
    payer: authority,
    updateAuthority: authority.publicKey,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    sellerFeeBasisPoints: percentAmount(0, 2),
    isMutable: params.isMutable ?? true,
    tokenStandard: TokenStandard.Fungible,
  });
  return builder.getInstructions().map((ix) => toWeb3JsInstruction(ix));
}

/**
 * Builds the Metaplex `Update` (updateV1) instruction — the "Update Token
 * Metadata" module (name/symbol/URI changes, authority transfer).
 */
export function updateMetadataInstructions(params: {
  payer: Keypair;
  mint: PublicKey;
  name?: string;
  symbol?: string;
  uri?: string;
  newUpdateAuthority?: string | null;
}): TransactionInstruction[] {
  const authority = umiSigner(params.payer);
  const builder = updateV1(umi, {
    mint: fromWeb3JsPublicKey(params.mint),
    authority,
    payer: authority,
    newUpdateAuthority:
      params.newUpdateAuthority === undefined
        ? undefined
        : params.newUpdateAuthority === null
          ? null
          : fromWeb3JsPublicKey(pk(params.newUpdateAuthority)),
    data:
      params.name !== undefined || params.symbol !== undefined || params.uri !== undefined
        ? {
            name: params.name ?? '',
            symbol: params.symbol ?? '',
            uri: params.uri ?? '',
            sellerFeeBasisPoints: 0,
            creators: null,
          }
        : undefined,
  });
  return builder.getInstructions().map((ix) => toWeb3JsInstruction(ix));
}

/**
 * Builds the `Migrate` instruction converting legacy (pre Token-Standard)
 * fungible metadata accounts to the current layout — needed before
 * `updateV1` on legacy accounts such as Pump.fun coins.
 */
export function migrateMetadataInstruction(params: {
  payer: Keypair;
  mint: PublicKey;
  /** Holder token account + owner (required by the on-chain program). */
  tokenAccount?: PublicKey;
  tokenOwner?: PublicKey;
}): TransactionInstruction[] {
  const authority = umiSigner(params.payer);
  const metadata = findMetadataPda(umi, { mint: fromWeb3JsPublicKey(params.mint) });
  // Fungible migrate requires collectionMetadata/delegateRecord account slots;
  // for plain SPL tokens these are the metadata PDA itself (checked leniently
  // on-chain). The cast documents the edge; simulate before executing.
  const builder = migrate(umi, {
    metadata,
    token: fromWeb3JsPublicKey(params.tokenAccount ?? params.payer.publicKey),
    tokenOwner: fromWeb3JsPublicKey(params.tokenOwner ?? params.payer.publicKey),
    mint: fromWeb3JsPublicKey(params.mint),
    payer: authority,
    collectionMetadata: metadata,
    delegateRecord: metadata,
  } as never);
  return builder.getInstructions().map((ix) => toWeb3JsInstruction(ix));
}

/**
 * Revokes the metadata update authority by transferring it to null.
 * WARNING: after this, metadata can never be changed again.
 */
export function revokeMetadataAuthorityInstructions(params: {
  payer: Keypair;
  mint: PublicKey;
}): TransactionInstruction[] {
  return updateMetadataInstructions({ ...params, newUpdateAuthority: null });
}
