import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  anchorDiscriminator,
  decodeBondingCurve,
  pumpBondingCurvePda,
  pumpBuyInstruction,
  pumpCreatorVaultPda,
  pumpCreateInstruction,
  pumpSellInstruction,
  quoteBuyLamportsIn,
  quoteSellLamportsOut,
  randomFeeRecipient,
  PUMPFUN_FEE_RECIPIENTS,
} from '../src/index.js';

describe('anchor discriminators', () => {
  it('matches the verified Pump.fun buy discriminator', () => {
    expect([...anchorDiscriminator('buy')]).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
  });
  it('matches the verified Pump.fun sell discriminator', () => {
    expect([...anchorDiscriminator('sell')]).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
  });
  it('matches the verified Pump.fun create discriminator', () => {
    expect([...anchorDiscriminator('create')]).toEqual([24, 30, 200, 40, 5, 28, 7, 119]);
  });
  it('matches the verified Pump.fun collect_creator_fee discriminator', () => {
    expect([...anchorDiscriminator('collect_creator_fee')]).toEqual([20, 22, 86, 123, 198, 28, 219, 132]);
  });
});

describe('pump.fun builders', () => {
  const user = Keypair.generate();
  const mint = Keypair.generate();
  const curveCreator = Keypair.generate().publicKey.toBase58();

  it('builds create with the documented 14-account layout', () => {
    const ix = pumpCreateInstruction({
      user: user.publicKey,
      mint: mint.publicKey,
      name: 'Test',
      symbol: 'TST',
      uri: 'https://example.com/m.json',
      creator: user.publicKey,
    });
    expect(ix.programId.toBase58()).toBe(PUMP_PROGRAM_ID);
    expect(ix.keys).toHaveLength(14);
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(
      anchorDiscriminator('create').toString('hex'),
    );
    expect(ix.keys[0]!.pubkey.equals(mint.publicKey)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
  });

  it('builds buy with the documented 16-account layout', () => {
    const ix = pumpBuyInstruction({
      user: user.publicKey,
      mint: mint.publicKey,
      curveCreator,
      amount: 1000n,
      maxSolCost: 2000n,
    });
    expect(ix.keys).toHaveLength(16);
    // bonding curve PDA at index 3
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(pumpBondingCurvePda(mint.publicKey.toBase58()).toBase58());
    // creator vault PDA at index 9
    expect(ix.keys[9]!.pubkey.toBase58()).toBe(pumpCreatorVaultPda(curveCreator).toBase58());
    // fee recipient at index 1 comes from the official list
    expect(PUMPFUN_FEE_RECIPIENTS).toContain(ix.keys[1]!.pubkey.toBase58());
  });

  it('builds sell with the documented 14-account layout', () => {
    const ix = pumpSellInstruction({
      user: user.publicKey,
      mint: mint.publicKey,
      curveCreator,
      amount: 100n,
      minSolOutput: 1n,
    });
    expect(ix.keys).toHaveLength(14);
    expect(ix.keys[8]!.pubkey.toBase58()).toBe(pumpCreatorVaultPda(curveCreator).toBase58());
  });

  it('fee recipients come from the official list', () => {
    expect(PUMPFUN_FEE_RECIPIENTS).toContain(randomFeeRecipient().toBase58());
  });
});

describe('bonding curve math', () => {
  const curve = {
    discriminator: '00',
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 1_000_000_000_000_000n,
    realSolReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    creator: Keypair.generate().publicKey.toBase58(),
  };

  it('computes the constant-product buy cost', () => {
    const lamports = quoteBuyLamportsIn(curve, 1_000_000_000_000n);
    expect(lamports).toBeGreaterThan(0n);
    const back = quoteSellLamportsOut(curve, 1_000_000_000_000n);
    expect(back).toBeGreaterThan(0n);
    expect(back).toBeLessThan(lamports);
  });

  it('rejects buys larger than curve reserves', () => {
    expect(() => quoteBuyLamportsIn(curve, curve.realTokenReserves + 1n)).toThrow();
  });
});

describe('bonding curve account decode', () => {
  it('decodes the verified layout', () => {
    const creator = Keypair.generate().publicKey;
    const buf = Buffer.alloc(8 + 5 * 8 + 1 + 32);
    let o = 8;
    buf.writeBigUInt64LE(1073000000000000n, o); o += 8;
    buf.writeBigUInt64LE(30000000000n, o); o += 8;
    buf.writeBigUInt64LE(1000000000000000n, o); o += 8;
    buf.writeBigUInt64LE(0n, o); o += 8;
    buf.writeBigUInt64LE(1000000000000000n, o); o += 8;
    buf.writeUInt8(0, o); o += 1;
    Buffer.from(creator.toBytes()).copy(buf, o);
    const decoded = decodeBondingCurve(buf);
    expect(decoded.virtualTokenReserves).toBe(1073000000000000n);
    expect(decoded.creator).toBe(creator.toBase58());
    expect(decoded.complete).toBe(false);
  });
});
