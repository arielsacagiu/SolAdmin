import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_GLOBAL,
  PUMPFUN_EVENT_AUTHORITY,
  PUMPFUN_FEE_CONFIG,
  PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR,
  PUMPFUN_DEFAULT_FEE_RECIPIENT,
  PUMPFUN_BUY_DISC,
  PUMPFUN_SELL_DISC,
  anchorIxDiscriminator,
  ata,
  buildPumpfunBuyIx,
  buildPumpfunSellIx,
  parseBondingCurve,
  pumpfunBondingCurvePda,
  pumpfunCreatorVaultPda,
  pumpfunSolForTokenSell,
  pumpfunSolForTokens,
  pumpfunTokensForSol,
  pumpfunUserVolumeAccumulatorPda,
  readU64,
  type BondingCurveState,
} from '../src/index.js';

const curve: BondingCurveState = {
  virtualTokenReserves: 1_000_000_000_000_000n, // ~1e9 tokens (6dp)
  virtualSolReserves: 30_000_000_000n, // 30 SOL
  realTokenReserves: 700_000_000_000_000n,
  realSolReserves: 5_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: Keypair.generate().publicKey,
};

describe('pump.fun discriminators (verified on-chain)', () => {
  it('buy', () => {
    expect([...anchorIxDiscriminator('buy')]).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
    expect([...PUMPFUN_BUY_DISC]).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
  });
  it('sell', () => {
    expect([...anchorIxDiscriminator('sell')]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
    expect([...PUMPFUN_SELL_DISC]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
  });
});

describe('pump.fun program constants', () => {
  it('program / fee program / global PDA match known on-chain values', () => {
    expect(PUMPFUN_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(PUMPFUN_FEE_PROGRAM_ID.toBase58()).toBe('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
    expect(PUMPFUN_GLOBAL.toBase58()).toBe('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
    expect(PUMPFUN_EVENT_AUTHORITY.toBase58()).toBe('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  });
});

describe('pump.fun PDAs', () => {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  it('bonding-curve PDA derives under the pump program', () => {
    const pda = pumpfunBondingCurvePda(mint);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMPFUN_PROGRAM_ID,
    );
    expect(pda.equals(expected)).toBe(true);
  });
  it('creator-vault PDA uses ["creator-vault", creator]', () => {
    const pda = pumpfunCreatorVaultPda(user);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('creator-vault'), user.toBuffer()],
      PUMPFUN_PROGRAM_ID,
    );
    expect(pda.equals(expected)).toBe(true);
  });
  it('user volume accumulator uses ["user_volume_accumulator", user]', () => {
    const pda = pumpfunUserVolumeAccumulatorPda(user);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_volume_accumulator'), user.toBuffer()],
      PUMPFUN_PROGRAM_ID,
    );
    expect(pda.equals(expected)).toBe(true);
  });
});

describe('pump.fun quote math', () => {
  it('tokens for SOL applies the 1.25% fee before the curve', () => {
    const out = pumpfunTokensForSol(curve, 1_000_000_000n); // 1 SOL
    expect(out).toBeGreaterThan(0n);
    // Less than the zero-fee output.
    const zeroFee = (curve.virtualTokenReserves * 1_000_000_000n) / (curve.virtualSolReserves + 1_000_000_000n);
    expect(out).toBeLessThan(zeroFee);
    // Roughly fee * curve price sanity: ~3.3e13 tokens per SOL at these reserves.
    expect(out).toBeGreaterThan(30_000_000_000_000n);
    expect(out).toBeLessThan(35_000_000_000_000n);
  });

  it('sol-for-tokens is the inverse (buy exact out costs >= exact-in output)', () => {
    const tokensOut = pumpfunTokensForSol(curve, 500_000_000n);
    const solNeeded = pumpfunSolForTokens(curve, tokensOut);
    expect(solNeeded).toBeGreaterThanOrEqual(490_000_000n);
    expect(solNeeded).toBeLessThanOrEqual(510_000_000n);
  });

  it('round trip costs roughly 2× the fee on a small trade', () => {
    // 0.05 SOL into 30 SOL virtual reserves — ~0.17% price impact per leg.
    const inSol = 50_000_000n;
    const tokens = pumpfunTokensForSol(curve, inSol);
    const back = pumpfunSolForTokenSell(curve, tokens);
    expect(back).toBeLessThan(inSol);
    // Loss ≈ 2×1.25% fees + 2×impact ≈ 2.8%.
    const lossBps = Number(((inSol - back) * 10_000n) / inSol);
    expect(lossBps).toBeGreaterThan(220);
    expect(lossBps).toBeLessThan(340);
  });

  it('round trip cost grows with trade size (price impact)', () => {
    const small = 50_000_000n;
    const big = 1_000_000_000n;
    const lossBps = (inSol: bigint) => {
      const tokens = pumpfunTokensForSol(curve, inSol);
      const back = pumpfunSolForTokenSell(curve, tokens);
      return Number(((inSol - back) * 10_000n) / inSol);
    };
    expect(lossBps(big)).toBeGreaterThan(lossBps(small));
  });

  it('degenerate inputs return 0', () => {
    expect(pumpfunTokensForSol(curve, 0n)).toBe(0n);
    expect(pumpfunSolForTokens(curve, 0n)).toBe(0n);
    expect(pumpfunSolForTokens(curve, curve.virtualTokenReserves + 1n)).toBe(0n);
    expect(pumpfunSolForTokenSell(curve, 0n)).toBe(0n);
  });
});

describe('pump.fun instruction layout', () => {
  const user = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const bondingCurve = pumpfunBondingCurvePda(mint);
  const accounts = {
    feeRecipient: PUMPFUN_DEFAULT_FEE_RECIPIENT,
    mint,
    bondingCurve,
    associatedBondingCurve: ata(bondingCurve, mint, TOKEN_PROGRAM_ID),
    associatedUser: ata(user, mint, TOKEN_PROGRAM_ID),
    user,
    tokenProgram: TOKEN_PROGRAM_ID,
    creatorVault: pumpfunCreatorVaultPda(curve.creator),
  };

  it('buy uses the 16-account post-fee-program layout', () => {
    const ix = buildPumpfunBuyIx(accounts, 123_456n, 7_777n);
    expect(ix.programId.equals(PUMPFUN_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(16);
    expect(ix.keys[0]!.pubkey.equals(PUMPFUN_GLOBAL)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(accounts.feeRecipient)).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(bondingCurve)).toBe(true);
    expect(ix.keys[6]!.pubkey.equals(user)).toBe(true);
    expect(ix.keys[6]!.isSigner).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[8]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true); // token_program precedes creator_vault on buy
    expect(ix.keys[9]!.pubkey.equals(accounts.creatorVault)).toBe(true);
    expect(ix.keys[10]!.pubkey.equals(PUMPFUN_EVENT_AUTHORITY)).toBe(true);
    expect(ix.keys[11]!.pubkey.equals(PUMPFUN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[12]!.pubkey.equals(PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR)).toBe(true);
    expect(ix.keys[13]!.pubkey.equals(pumpfunUserVolumeAccumulatorPda(user))).toBe(true);
    expect(ix.keys[14]!.pubkey.equals(PUMPFUN_FEE_CONFIG)).toBe(true);
    expect(ix.keys[15]!.pubkey.equals(PUMPFUN_FEE_PROGRAM_ID)).toBe(true);
    // data: disc + u64 tokensOut + u64 maxSolCost
    expect(ix.data.length).toBe(24);
    expect(readU64(ix.data, 8)).toBe(123_456n);
    expect(readU64(ix.data, 16)).toBe(7_777n);
  });

  it('sell uses the 14-account layout with creator_vault BEFORE token_program', () => {
    const ix = buildPumpfunSellIx(accounts, 999n, 1n);
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[8]!.pubkey.equals(accounts.creatorVault)).toBe(true); // creator_vault at 8
    expect(ix.keys[9]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true); // token_program at 9
    expect(ix.keys[12]!.pubkey.equals(PUMPFUN_FEE_CONFIG)).toBe(true);
    expect(ix.data.length).toBe(24);
    expect(readU64(ix.data, 8)).toBe(999n);
    expect(readU64(ix.data, 16)).toBe(1n);
  });
});

describe('bonding curve codec', () => {
  it('round-trips a serialized 81-byte account', () => {
    const creator = Keypair.generate().publicKey;
    const buf = Buffer.alloc(81);
    buf.writeBigUInt64LE(1_111n, 8); // vToken
    buf.writeBigUInt64LE(2_222n, 16); // vSol
    buf.writeBigUInt64LE(3_333n, 24); // realToken
    buf.writeBigUInt64LE(4_444n, 32); // realSol
    buf.writeBigUInt64LE(5_555n, 40); // supply
    buf[48] = 0;
    creator.toBuffer().copy(buf, 49);
    const s = parseBondingCurve(buf);
    expect(s.virtualTokenReserves).toBe(1_111n);
    expect(s.virtualSolReserves).toBe(2_222n);
    expect(s.realTokenReserves).toBe(3_333n);
    expect(s.realSolReserves).toBe(4_444n);
    expect(s.tokenTotalSupply).toBe(5_555n);
    expect(s.complete).toBe(false);
    expect(s.creator.equals(creator)).toBe(true);
    buf[48] = 1;
    expect(parseBondingCurve(buf).complete).toBe(true);
  });

  it('rejects short data', () => {
    expect(() => parseBondingCurve(Buffer.alloc(40))).toThrow(/too short/);
  });
});
