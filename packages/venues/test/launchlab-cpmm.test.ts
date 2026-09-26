import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  LAUNCHLAB_PROGRAM_ID,
  LAUNCHLAB_EVENT_AUTHORITY,
  LAUNCHLAB_BUY_EXACT_OUT_DISC,
  LAUNCHLAB_SELL_EXACT_IN_DISC,
  CPMM_PROGRAM_ID,
  CPMM_AUTHORITY,
  CPMM_SWAP_BASE_INPUT_DISC,
  CPMM_SWAP_BASE_OUTPUT_DISC,
  CPMM_DEFAULT_TRADE_FEE_RATE,
  WSOL_MINT,
  buildLaunchpadBuyExactOutIx,
  buildLaunchpadSellExactInIx,
  buildCpmmSwapBaseInputIx,
  buildCpmmSwapBaseOutputIx,
  launchpadAuthority,
  launchpadPoolPda,
  launchpadReserves,
  parseCpmmPoolState,
  parseCpmmTradeFeeRate,
  parseLaunchpadPoolState,
  readU64,
} from '../src/index.js';

describe('launchlab constants (verified on-chain)', () => {
  it('program + discriminators', () => {
    expect(LAUNCHLAB_PROGRAM_ID.toBase58()).toBe('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
    expect([...LAUNCHLAB_BUY_EXACT_OUT_DISC]).toEqual([24, 211, 116, 40, 105, 3, 153, 56]);
    expect([...LAUNCHLAB_SELL_EXACT_IN_DISC]).toEqual([149, 39, 222, 155, 211, 124, 152, 26]);
  });
  it('event authority is the __event_authority PDA', () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      LAUNCHLAB_PROGRAM_ID,
    );
    expect(LAUNCHLAB_EVENT_AUTHORITY.equals(expected)).toBe(true);
  });
});

function sampleLaunchpadPool(): { data: Buffer; baseMint: PublicKey } {
  const baseMint = Keypair.generate().publicKey;
  const buf = Buffer.alloc(429);
  buf.writeBigUInt64LE(1n, 8); // epoch
  buf[16] = 250; // authBump
  buf[17] = 1; // status = Live
  buf[18] = 6; // base dec
  buf[19] = 9; // quote dec
  buf.writeBigUInt64LE(1_000_000_000n, 21); // supply
  buf.writeBigUInt64LE(100_000n, 29); // totalBaseSell
  buf.writeBigUInt64LE(800_000_000n, 37); // virtualBase
  buf.writeBigUInt64LE(30_000_000_000n, 45); // virtualQuote (30 SOL)
  buf.writeBigUInt64LE(200_000_000n, 53); // realBase
  buf.writeBigUInt64LE(5_000_000_000n, 61); // realQuote (5 SOL)
  // vesting 101..141 stays zero
  const g = Keypair.generate().publicKey;
  g.toBuffer().copy(buf, 141); // globalConfig
  Keypair.generate().publicKey.toBuffer().copy(buf, 173); // platformConfig
  baseMint.toBuffer().copy(buf, 205);
  WSOL_MINT.toBuffer().copy(buf, 237);
  Keypair.generate().publicKey.toBuffer().copy(buf, 269); // baseVault
  Keypair.generate().publicKey.toBuffer().copy(buf, 301); // quoteVault
  Keypair.generate().publicKey.toBuffer().copy(buf, 333); // creator
  buf[365] = 0; // tokenProgramFlag — both SPL
  buf[366] = 0; // ammCreatorFeeOn
  return { data: buf, baseMint };
}

describe('launchlab pool codec', () => {
  it('parses PoolState at verified offsets', () => {
    const { data, baseMint } = sampleLaunchpadPool();
    const p = parseLaunchpadPoolState(data);
    expect(p.status).toBe(1);
    expect(p.baseDecimals).toBe(6);
    expect(p.virtualBase).toBe(800_000_000n);
    expect(p.virtualQuote).toBe(30_000_000_000n);
    expect(p.realBase).toBe(200_000_000n);
    expect(p.realQuote).toBe(5_000_000_000n);
    expect(p.baseMint.equals(baseMint)).toBe(true);
    expect(p.quoteMint.equals(WSOL_MINT)).toBe(true);
    expect(p.tokenProgramFlag).toBe(0);
  });

  it('effective reserves = vBase - realBase / vQuote + realQuote', () => {
    const { data } = sampleLaunchpadPool();
    const p = parseLaunchpadPoolState(data);
    const r = launchpadReserves(p);
    expect(r.base).toBe(600_000_000n);
    expect(r.quote).toBe(35_000_000_000n);
  });

  it('pool PDA uses ["pool", base_mint, quote_mint]', () => {
    const base = Keypair.generate().publicKey;
    const pda = launchpadPoolPda(base, WSOL_MINT);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), base.toBuffer(), WSOL_MINT.toBuffer()],
      LAUNCHLAB_PROGRAM_ID,
    );
    expect(pda.equals(expected)).toBe(true);
  });

  it('vault authority PDA uses ["vault_and_lp_mint_auth_seed", pool, bump]', () => {
    const pool = Keypair.generate().publicKey;
    // Find a real off-curve bump first — a fixed bump may land on-curve.
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_seed'), pool.toBuffer()],
      LAUNCHLAB_PROGRAM_ID,
    );
    const auth = launchpadAuthority(pool, bump);
    expect(auth.equals(expected)).toBe(true);
  });
});

describe('launchlab instructions', () => {
  const user = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const baseMint = Keypair.generate().publicKey;
  const [, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_and_lp_mint_auth_seed'), pool.toBuffer()],
    LAUNCHLAB_PROGRAM_ID,
  );
  const accounts = {
    pool,
    authority: launchpadAuthority(pool, poolBump),
    globalConfig: Keypair.generate().publicKey,
    platformConfig: Keypair.generate().publicKey,
    userBaseAta: Keypair.generate().publicKey,
    userQuoteAta: Keypair.generate().publicKey,
    baseVault: Keypair.generate().publicKey,
    quoteVault: Keypair.generate().publicKey,
    baseMint,
    quoteMint: WSOL_MINT,
    baseTokenProgram: TOKEN_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  };

  it('buy_exact_out: 15 accounts, (amount_out, max_in, share_fee_rate)', () => {
    const ix = buildLaunchpadBuyExactOutIx(accounts, user, 700n, 800n, 0n);
    expect(ix.programId.equals(LAUNCHLAB_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(15);
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[4]!.pubkey.equals(pool)).toBe(true);
    expect(ix.keys[14]!.pubkey.equals(LAUNCHLAB_PROGRAM_ID)).toBe(true);
    // data: disc8 + u64 + u64 + u64 = 32
    expect(ix.data.length).toBe(32);
    expect(readU64(ix.data, 8)).toBe(700n);
    expect(readU64(ix.data, 16)).toBe(800n);
    expect(readU64(ix.data, 24)).toBe(0n);
  });

  it('sell_exact_in: same accounts, (amount_in, min_out, share_fee_rate)', () => {
    const ix = buildLaunchpadSellExactInIx(accounts, user, 700n, 500n, 100n);
    expect(ix.keys).toHaveLength(15);
    expect(ix.data.length).toBe(32);
    expect(readU64(ix.data, 24)).toBe(100n);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CPMM
// ─────────────────────────────────────────────────────────────────────────

describe('cpmm constants (verified on-chain)', () => {
  it('program + authority PDA + discriminators', () => {
    expect(CPMM_PROGRAM_ID.toBase58()).toBe('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    expect(CPMM_AUTHORITY.toBase58()).toBe('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
    expect([...CPMM_SWAP_BASE_INPUT_DISC]).toEqual([143, 190, 90, 218, 196, 30, 51, 222]);
    expect([...CPMM_SWAP_BASE_OUTPUT_DISC]).toEqual([55, 217, 98, 86, 163, 74, 180, 173]);
  });
  it('authority PDA derives from ["vault_and_lp_mint_auth_seed"]', () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_seed')],
      CPMM_PROGRAM_ID,
    );
    expect(CPMM_AUTHORITY.equals(expected)).toBe(true);
  });
});

function sampleCpmmPool(): { data: Buffer; t0: PublicKey; t1: PublicKey } {
  const t0 = Keypair.generate().publicKey;
  const t1 = WSOL_MINT;
  const buf = Buffer.alloc(637);
  Keypair.generate().publicKey.toBuffer().copy(buf, 8); // amm_config
  Keypair.generate().publicKey.toBuffer().copy(buf, 40); // pool_creator
  Keypair.generate().publicKey.toBuffer().copy(buf, 72); // token0_vault
  Keypair.generate().publicKey.toBuffer().copy(buf, 104); // token1_vault
  Keypair.generate().publicKey.toBuffer().copy(buf, 136); // lp_mint
  t0.toBuffer().copy(buf, 168);
  t1.toBuffer().copy(buf, 200);
  TOKEN_PROGRAM_ID.toBuffer().copy(buf, 232);
  TOKEN_PROGRAM_ID.toBuffer().copy(buf, 264);
  Keypair.generate().publicKey.toBuffer().copy(buf, 296); // observation
  buf[328] = 255; // auth_bump
  buf[329] = 0b111; // status: deposit+withdraw+swap all enabled
  buf[330] = 9; // lp_dec
  buf[331] = 6; // mint0_dec
  buf[332] = 9; // mint1_dec
  buf.writeBigUInt64LE(1_000n, 333); // lp_supply
  buf.writeBigUInt64LE(10n, 341); // protocol_fees0
  buf.writeBigUInt64LE(20n, 349); // protocol_fees1
  buf.writeBigUInt64LE(30n, 357); // fund_fees0
  buf.writeBigUInt64LE(40n, 365); // fund_fees1
  buf[389] = 0; // creator_fee_on
  buf[390] = 0; // enable_creator_fee
  buf.writeBigUInt64LE(5n, 397); // creator_fees0
  buf.writeBigUInt64LE(6n, 405); // creator_fees1
  return { data: buf, t0, t1 };
}

describe('cpmm pool codec', () => {
  it('parses the 637-byte layout at verified offsets', () => {
    const { data, t0, t1 } = sampleCpmmPool();
    const p = parseCpmmPoolState(data);
    expect(p.token0Mint.equals(t0)).toBe(true);
    expect(p.token1Mint.equals(t1)).toBe(true);
    expect(p.authBump).toBe(255);
    expect(p.status).toBe(0b111);
    expect(p.mint0Decimals).toBe(6);
    expect(p.protocolFeesToken0).toBe(10n);
    expect(p.creatorFeesToken1).toBe(6n);
  });

  it('parses trade fee rate from AmmConfig (offset 27) w/ fallback', () => {
    const cfg = Buffer.alloc(160);
    cfg.writeBigUInt64LE(2_500n, 27);
    expect(parseCpmmTradeFeeRate(cfg)).toBe(2_500n);
    const bad = Buffer.alloc(160);
    bad.writeBigUInt64LE(2_000_000n, 27); // > denominator → fallback
    expect(parseCpmmTradeFeeRate(bad)).toBe(CPMM_DEFAULT_TRADE_FEE_RATE);
    expect(parseCpmmTradeFeeRate(Buffer.alloc(10))).toBe(CPMM_DEFAULT_TRADE_FEE_RATE);
  });
});

describe('cpmm instructions', () => {
  const user = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const accounts = {
    pool,
    ammConfig: Keypair.generate().publicKey,
    userInAta: Keypair.generate().publicKey,
    userOutAta: Keypair.generate().publicKey,
    inVault: Keypair.generate().publicKey,
    outVault: Keypair.generate().publicKey,
    inTokenProgram: TOKEN_PROGRAM_ID,
    outTokenProgram: TOKEN_PROGRAM_ID,
    inMint: Keypair.generate().publicKey,
    outMint: Keypair.generate().publicKey,
    observation: Keypair.generate().publicKey,
  };

  it('swap_base_input: 13 accounts, (amount_in, min_amount_out)', () => {
    const ix = buildCpmmSwapBaseInputIx(accounts, user, 100n, 90n);
    expect(ix.programId.equals(CPMM_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(CPMM_AUTHORITY)).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(pool)).toBe(true);
    expect(ix.keys[12]!.pubkey.equals(accounts.observation)).toBe(true);
    expect(ix.data.length).toBe(24);
    expect(readU64(ix.data, 8)).toBe(100n);
    expect(readU64(ix.data, 16)).toBe(90n);
  });

  it('swap_base_output: (max_amount_in, amount_out)', () => {
    const ix = buildCpmmSwapBaseOutputIx(accounts, user, 100n, 95n);
    expect(ix.keys).toHaveLength(13);
    expect(readU64(ix.data, 8)).toBe(100n); // max_in first
    expect(readU64(ix.data, 16)).toBe(95n); // amount_out second
  });
});
