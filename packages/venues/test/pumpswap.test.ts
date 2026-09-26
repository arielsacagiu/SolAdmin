import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PUMPSWAP_PROGRAM_ID,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_EVENT_AUTHORITY,
  PUMPSWAP_FEE_PROGRAM,
  PUMPSWAP_POOL_DISCRIMINATOR,
  WSOL_MINT,
  ata,
  buildPumpSwapBuyIx,
  buildPumpSwapSellIx,
  constantProductIn,
  constantProductOut,
  parsePumpSwapPool,
  pumpswapCreatorVaultAuthority,
  pumpswapUserVolumeAccumulator,
  readU64,
} from '../src/index.js';

describe('pumpswap discriminators (verified on-chain)', () => {
  it('pool account discriminator', () => {
    expect(PUMPSWAP_POOL_DISCRIMINATOR.toString('hex')).toBe('f19a6d0411b16dbc');
  });
});

describe('pumpswap PDAs', () => {
  it('creator_vault authority: ["creator_vault", coin_creator] under pAMM', () => {
    const creator = Keypair.generate().publicKey;
    const auth = pumpswapCreatorVaultAuthority(creator);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator_vault'), creator.toBuffer()],
      PUMPSWAP_PROGRAM_ID,
    );
    expect(auth.equals(expected)).toBe(true);
  });
  it('user_volume_accumulator: under the shared fee program', () => {
    const user = Keypair.generate().publicKey;
    const pda = pumpswapUserVolumeAccumulator(user);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_volume_accumulator'), user.toBuffer()],
      PUMPSWAP_FEE_PROGRAM,
    );
    expect(pda.equals(expected)).toBe(true);
  });
});

function samplePool(): { data: Buffer; mints: { base: PublicKey; quote: PublicKey } } {
  const base = Keypair.generate().publicKey;
  const quote = WSOL_MINT;
  const buf = Buffer.alloc(301);
  PUMPSWAP_POOL_DISCRIMINATOR.copy(buf, 0);
  buf[8] = 254; // bump
  buf.writeUInt16LE(7, 9); // index
  const creator = Keypair.generate().publicKey;
  creator.toBuffer().copy(buf, 11);
  base.toBuffer().copy(buf, 43);
  quote.toBuffer().copy(buf, 75);
  Keypair.generate().publicKey.toBuffer().copy(buf, 107); // lp_mint
  Keypair.generate().publicKey.toBuffer().copy(buf, 139); // base vault
  Keypair.generate().publicKey.toBuffer().copy(buf, 171); // quote vault
  buf.writeBigUInt64LE(1_000_000n, 203); // lp supply
  creator.toBuffer().copy(buf, 211); // coin_creator
  buf[243] = 0; // is_mayhem
  return { data: buf, mints: { base, quote } };
}

describe('pumpswap pool codec', () => {
  it('parses the 301-byte layout at verified offsets', () => {
    const { data, mints } = samplePool();
    const p = parsePumpSwapPool(data);
    expect(p.bump).toBe(254);
    expect(p.index).toBe(7);
    expect(p.baseMint.equals(mints.base)).toBe(true);
    expect(p.quoteMint.equals(WSOL_MINT)).toBe(true);
    expect(p.lpSupply).toBe(1_000_000n);
    expect(p.isMayhemMode).toBe(false);
  });
});

describe('pumpswap instruction layout', () => {
  const user = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const coinCreator = Keypair.generate().publicKey;
  const vaultAuthority = pumpswapCreatorVaultAuthority(coinCreator);
  const a = {
    pool,
    user,
    baseMint: Keypair.generate().publicKey,
    quoteMint: WSOL_MINT,
    userBaseAta: ata(user, Keypair.generate().publicKey, TOKEN_PROGRAM_ID),
    userQuoteAta: ata(user, WSOL_MINT, TOKEN_PROGRAM_ID),
    poolBaseAta: Keypair.generate().publicKey,
    poolQuoteAta: Keypair.generate().publicKey,
    coinCreatorVaultAta: ata(vaultAuthority, WSOL_MINT, TOKEN_PROGRAM_ID),
    coinCreatorVaultAuthority: vaultAuthority,
    userVolumeAccumulator: pumpswapUserVolumeAccumulator(user),
  };

  it('buy uses the 23-account layout + OptionBool arg', () => {
    const ix = buildPumpSwapBuyIx(a, 500n, 600n);
    expect(ix.programId.equals(PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(23);
    expect(ix.keys[0]!.pubkey.equals(pool)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(user)).toBe(true);
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(PUMPSWAP_GLOBAL_CONFIG)).toBe(true);
    expect(ix.keys[15]!.pubkey.equals(PUMPSWAP_EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[16]!.pubkey.equals(PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(ix.keys[17]!.pubkey.equals(a.coinCreatorVaultAta)).toBe(true);
    expect(ix.keys[18]!.pubkey.equals(a.coinCreatorVaultAuthority)).toBe(true);
    // data: disc8 + u64 baseAmountOut + u64 maxQuoteIn + u8 track_volume
    expect(ix.data.length).toBe(25);
    expect(readU64(ix.data, 8)).toBe(500n);
    expect(readU64(ix.data, 16)).toBe(600n);
    expect(ix.data[24]).toBe(1);
    const noTrack = buildPumpSwapBuyIx(a, 500n, 600n, false);
    expect(noTrack.data[24]).toBe(0);
  });

  it('sell uses the same 23 accounts with (base_in, min_quote_out)', () => {
    const ix = buildPumpSwapSellIx(a, 500n, 400n);
    expect(ix.keys).toHaveLength(23);
    expect(ix.data.length).toBe(24);
    expect(readU64(ix.data, 8)).toBe(500n);
    expect(readU64(ix.data, 16)).toBe(400n);
  });
});

describe('constant-product math', () => {
  const rIn = 50_000_000_000n; // 50 SOL quote
  const rOut = 1_000_000_000_000_000n; // 1e9 tokens

  it('exact-in output is smaller with a fee', () => {
    const noFee = constantProductOut(1_000_000_000n, rIn, rOut, 0n);
    const withFee = constantProductOut(1_000_000_000n, rIn, rOut, 25n);
    expect(withFee).toBeLessThan(noFee);
    expect(withFee).toBeGreaterThan((noFee * 9_900n) / 10_000n);
  });

  it('constantProductIn inverts constantProductOut within rounding', () => {
    const amountIn = 2_000_000_000n;
    const feeBps = 25n;
    const out = constantProductOut(amountIn, rIn, rOut, feeBps);
    const needed = constantProductIn(out, rIn, rOut, feeBps);
    expect(needed).toBeGreaterThanOrEqual(amountIn);
    expect(needed - amountIn).toBeLessThan(amountIn / 100n); // <1% rounding slack
  });

  it('buying out more than reserves returns 0', () => {
    expect(constantProductIn(rOut + 1n, rIn, rOut, 25n)).toBe(0n);
  });
});
