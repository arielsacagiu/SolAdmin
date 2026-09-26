/**
 * OpenBook market creation.
 *
 * Two flavors:
 *  - OpenBook V1 (Serum v3, `srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX`) —
 *    the classic instruction used with Raydium AMM v4 pools. Layout verified
 *    against raydium-sdk-V2 `initializeMarket` (marketV2 module).
 *  - OpenBook V2 (`opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`) — the modern
 *    Anchor program. Layout verified against the official
 *    openbook-dex/openbook-v2 client (createMarketIx).
 *
 * Rent-exempt lamports are left as placeholders (0) and patched by
 * `withRentLamports` before sending, so this module stays RPC-free.
 * @module
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PROGRAMS, pk } from './constants.js';
import { anchorDiscriminator, borshOption, borshString, f32, i64, u8 } from './encoding.js';
import { serumMarketAuthority } from './raydium.js';

export const OPENBOOK_V1_PROGRAM_ID = PROGRAMS.OPENBOOK_V1;
export const OPENBOOK_V2_PROGRAM_ID = PROGRAMS.OPENBOOK_V2;

/**
 * Patches every `SystemProgram.createAccount` instruction's lamports with the
 * rent-exempt minimum for its space. `rentExemptLamports(space)` is provided
 * by the service layer (from `getMinimumBalanceForRentExemption`).
 */
export function withRentLamports(
  instructions: TransactionInstruction[],
  rentExemptLamports: (space: number) => number,
): TransactionInstruction[] {
  return instructions.map((ix) => {
    if (!ix.programId.equals(SystemProgram.programId)) return ix;
    const data = Buffer.from(ix.data);
    // createAccount wire layout: u32 tag(0) + u64 lamports + u64 space + 32B programId = 52 bytes.
    if (data.length === 52 && data.readUInt32LE(0) === 0) {
      const space = Number(data.readBigUInt64LE(12));
      data.writeBigUInt64LE(BigInt(rentExemptLamports(space)), 4);
      return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
    }
    return ix;
  });
}

// ---------------------------------------------------------------------------
// OpenBook V1 (Serum v3)
// ---------------------------------------------------------------------------

export interface SerumMarketSetup {
  market: Keypair;
  requestQueue: Keypair;
  eventQueue: Keypair;
  bids: Keypair;
  asks: Keypair;
  baseVault: Keypair;
  quoteVault: Keypair;
  vaultOwner: PublicKey;
  vaultSignerNonce: bigint;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseLotSize: bigint;
  quoteLotSize: bigint;
  feeRateBps: number;
  quoteDustThreshold: bigint;
}

/**
 * Prepares keypairs and derives the vault owner for a new OpenBook V1 market.
 */
export function prepareSerumMarket(params: {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  lotSize?: number;
  tickSize?: number;
  programId?: string;
}): SerumMarketSetup {
  const programId = pk(params.programId ?? OPENBOOK_V1_PROGRAM_ID);
  const market = Keypair.generate();
  const requestQueue = Keypair.generate();
  const eventQueue = Keypair.generate();
  const bids = Keypair.generate();
  const asks = Keypair.generate();
  const baseVault = Keypair.generate();
  const quoteVault = Keypair.generate();

  // Vault owner = program address of (market, nonce).
  let nonce = 0n;
  let vaultOwner: PublicKey | null = null;
  while (nonce <= 25555n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(nonce, 0);
    try {
      vaultOwner = PublicKey.createProgramAddressSync([market.publicKey.toBuffer(), buf], programId);
      break;
    } catch {
      nonce++;
    }
  }
  if (!vaultOwner) throw new Error('failed to find vault owner nonce');

  const lotSize = params.lotSize ?? 1;
  const tickSize = params.tickSize ?? 0.01;
  const baseLotSize = BigInt(Math.round(10 ** params.baseDecimals * lotSize));
  const quoteLotSize = BigInt(Math.round(lotSize * 10 ** params.quoteDecimals * tickSize));
  if (baseLotSize === 0n || quoteLotSize === 0n) throw new Error('lot size / tick size too small');

  return {
    market,
    requestQueue,
    eventQueue,
    bids,
    asks,
    baseVault,
    quoteVault,
    vaultOwner,
    vaultSignerNonce: nonce,
    baseMint: params.baseMint,
    quoteMint: params.quoteMint,
    baseLotSize,
    quoteLotSize,
    feeRateBps: 0,
    quoteDustThreshold: 100n,
  };
}

/** Classic Serum v3 account sizes used when creating a market. */
export const SERUM_MARKET_SPACE = 388;
export const SERUM_QUEUE_SPACE = 512 + 12;
export const SERUM_BOOK_SPACE = 512 + 12;

/**
 * Builds the full instruction set to create an OpenBook V1 market:
 * system-account creations for market/queues/book, token vault creation +
 * init, then `initializeMarket`. Rent lamports are patched later via
 * `withRentLamports`.
 */
export function openbookV1CreateMarketInstructions(params: {
  payer: PublicKey;
  setup: SerumMarketSetup;
  programId?: string;
}): { instructions: TransactionInstruction[]; signers: Keypair[] } {
  const programId = pk(params.programId ?? OPENBOOK_V1_PROGRAM_ID);
  const s = params.setup;
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });
  const rent = pk('SysvarRent111111111111111111111111111111111');

  const createOwned = (kp: Keypair, space: number) =>
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: kp.publicKey,
      lamports: 0,
      space,
      programId,
    });
  const createVault = (kp: Keypair) =>
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: kp.publicKey,
      lamports: 0,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    });

  // initializeMarket data (raydium-sdk-V2 layout):
  // u8 version=0, u32 instruction=0, u64 baseLotSize, u64 quoteLotSize,
  // u16 feeRateBps, u64 vaultSignerNonce, u64 quoteDustThreshold.
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(s.feeRateBps, 0);
  const data = Buffer.concat([
    u8(0),
    u8(0), u8(0), u8(0), u8(0),
    i64(s.baseLotSize),
    i64(s.quoteLotSize),
    feeBuf,
    i64(s.vaultSignerNonce),
    i64(s.quoteDustThreshold),
  ]);

  const instructions: TransactionInstruction[] = [
    createOwned(s.market, SERUM_MARKET_SPACE),
    createOwned(s.requestQueue, SERUM_QUEUE_SPACE),
    createOwned(s.eventQueue, SERUM_QUEUE_SPACE),
    createOwned(s.bids, SERUM_BOOK_SPACE),
    createOwned(s.asks, SERUM_BOOK_SPACE),
    createVault(s.baseVault),
    createVault(s.quoteVault),
    createInitializeAccountInstruction(s.baseVault.publicKey, s.baseMint, s.vaultOwner, TOKEN_PROGRAM_ID),
    createInitializeAccountInstruction(s.quoteVault.publicKey, s.quoteMint, s.vaultOwner, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId,
      keys: [
        m(s.market.publicKey, true),
        m(s.requestQueue.publicKey, true),
        m(s.eventQueue.publicKey, true),
        m(s.bids.publicKey, true),
        m(s.asks.publicKey, true),
        m(s.baseVault.publicKey, true),
        m(s.quoteVault.publicKey, true),
        m(s.baseMint),
        m(s.quoteMint),
        m(rent),
      ],
      data,
    }),
  ];

  return {
    instructions,
    signers: [s.market, s.requestQueue, s.eventQueue, s.bids, s.asks, s.baseVault, s.quoteVault],
  };
}

// ---------------------------------------------------------------------------
// OpenBook V2 (anchor program)
// ---------------------------------------------------------------------------

export interface OpenbookV2MarketSetup {
  market: Keypair;
  bids: Keypair;
  asks: Keypair;
  eventHeap: Keypair;
  marketAuthority: PublicKey;
  marketBaseVault: PublicKey;
  marketQuoteVault: PublicKey;
  eventAuthority: PublicKey;
}

/**
 * Prepares accounts for an OpenBook V2 market (verified against the official
 * client: market is a signer keypair; authority is PDA ["Market", market]).
 */
export function prepareOpenbookV2Market(mint: { baseMint: PublicKey; quoteMint: PublicKey }): OpenbookV2MarketSetup {
  const market = Keypair.generate();
  const bids = Keypair.generate();
  const asks = Keypair.generate();
  const eventHeap = Keypair.generate();
  const programId = pk(OPENBOOK_V2_PROGRAM_ID);
  const [marketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('Market'), market.publicKey.toBuffer()],
    programId,
  );
  const marketBaseVault = getAssociatedTokenAddressSync(mint.baseMint, marketAuthority, true, TOKEN_PROGRAM_ID);
  const marketQuoteVault = getAssociatedTokenAddressSync(mint.quoteMint, marketAuthority, true, TOKEN_PROGRAM_ID);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], programId);
  return { market, bids, asks, eventHeap, marketAuthority, marketBaseVault, marketQuoteVault, eventAuthority };
}

/** OpenBook V2 book-side and event-heap account sizes (official client). */
export const OPENBOOK_V2_BOOKSIDE_SPACE = 90944 + 8;
export const OPENBOOK_V2_EVENT_HEAP_SPACE = 91280 + 8;

/**
 * Builds OpenBook V2 `createMarket` instructions: three program-owned account
 * creations + the anchor `createMarket` instruction.
 */
export function openbookV2CreateMarketInstructions(params: {
  payer: PublicKey;
  setup: OpenbookV2MarketSetup;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  name: string;
  quoteLotSize: bigint;
  baseLotSize: bigint;
  makerFee: bigint;
  takerFee: bigint;
  timeExpiry: bigint;
  oracleA?: PublicKey | null;
  oracleB?: PublicKey | null;
  collectFeeAdmin?: PublicKey;
  openOrdersAdmin?: PublicKey | null;
  consumeEventsAdmin?: PublicKey | null;
  closeMarketAdmin?: PublicKey | null;
  confFilter?: number;
  maxStalenessSlots?: number;
}): { instructions: TransactionInstruction[]; signers: Keypair[] } {
  const programId = pk(OPENBOOK_V2_PROGRAM_ID);
  const s = params.setup;
  const m = (pubkey: PublicKey, writable = false, signer = false) => ({ pubkey, isWritable: writable, isSigner: signer });

  const mk = (kp: Keypair, space: number) =>
    SystemProgram.createAccount({
      fromPubkey: params.payer,
      newAccountPubkey: kp.publicKey,
      lamports: 0,
      space,
      programId,
    });

  // Anchor args: name string, oracleConfig{confFilter f32, maxStalenessSlots
  // Option<u32>}, quoteLotSize i64, baseLotSize i64, makerFee i64,
  // takerFee i64, timeExpiry i64.
  const staleness = Buffer.alloc(4);
  staleness.writeUInt32LE(params.maxStalenessSlots ?? 100, 0);
  const data = Buffer.concat([
    anchorDiscriminator('createMarket'),
    borshString(params.name),
    f32(params.confFilter ?? 0.1),
    borshOption(staleness),
    i64(params.quoteLotSize),
    i64(params.baseLotSize),
    i64(params.makerFee),
    i64(params.takerFee),
    i64(params.timeExpiry),
  ]);

  const createMarket = new TransactionInstruction({
    programId,
    keys: [
      m(s.market.publicKey, false, true), // market (signer)
      m(s.marketAuthority), // market_authority
      m(s.bids.publicKey, true), // bids
      m(s.asks.publicKey, true), // asks
      m(s.eventHeap.publicKey, true), // event_heap
      m(params.payer, true, true), // payer
      m(s.marketBaseVault, true), // market_base_vault
      m(s.marketQuoteVault, true), // market_quote_vault
      m(params.baseMint), // base_mint
      m(params.quoteMint), // quote_mint
      m(SystemProgram.programId), // system_program
      m(TOKEN_PROGRAM_ID), // token_program
      m(ASSOCIATED_TOKEN_PROGRAM_ID), // associated_token_program
      m(params.oracleA ?? SystemProgram.programId), // oracle_a
      m(params.oracleB ?? SystemProgram.programId), // oracle_b
      m(params.collectFeeAdmin ?? params.payer), // collect_fee_admin
      m(params.openOrdersAdmin ?? params.payer), // open_orders_admin
      m(params.consumeEventsAdmin ?? params.payer), // consume_events_admin
      m(params.closeMarketAdmin ?? params.payer), // close_market_admin
      m(s.eventAuthority), // event_authority
      m(programId), // program
    ],
    data,
  });

  return {
    instructions: [
      mk(s.bids, OPENBOOK_V2_BOOKSIDE_SPACE),
      mk(s.asks, OPENBOOK_V2_BOOKSIDE_SPACE),
      mk(s.eventHeap, OPENBOOK_V2_EVENT_HEAP_SPACE),
      createMarket,
    ],
    signers: [s.market, s.bids, s.asks, s.eventHeap],
  };
}

export { serumMarketAuthority };
