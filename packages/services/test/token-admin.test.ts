import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { buildAdminInstructions, detectTokenProgram } from '../src/token-admin.js';
import type { ServiceContext } from '../src/context.js';

/** Minimal read-only context: the mint account's owner drives program selection. */
function ctxWithMintOwner(owner: PublicKey): ServiceContext {
  return {
    rpc: { accountInfo: async () => ({ owner }) },
  } as unknown as ServiceContext;
}

const MINT = Keypair.generate().publicKey;

describe('detectTokenProgram', () => {
  it('classifies a Token-2022 mint by account owner', async () => {
    expect((await detectTokenProgram(ctxWithMintOwner(TOKEN_2022_PROGRAM_ID), MINT.toBase58())).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it('falls back to classic SPL Token for any other owner', async () => {
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    expect((await detectTokenProgram(ctxWithMintOwner(TOKEN_PROGRAM_ID), MINT.toBase58())).equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('throws for an unknown mint', async () => {
    const ctx = { rpc: { accountInfo: async () => null } } as unknown as ServiceContext;
    await expect(detectTokenProgram(ctx, MINT.toBase58())).rejects.toThrow(/not found/);
  });
});

describe('buildAdminInstructions: set-transfer-fee', () => {
  it('produces the Token-2022 SetTransferFee layout (disc 5, bps, max fee)', async () => {
    const authority = Keypair.generate();
    const ctx = ctxWithMintOwner(TOKEN_2022_PROGRAM_ID);
    const ixs = await buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, {
      kind: 'set-transfer-fee',
      bps: 250,
      maxFeeRaw: 1_000_000n,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(MINT)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(authority.publicKey)).toBe(true);
    // Data layout per spl-token-2022: u8 TransferFeeExtension disc (=26) +
    // u8 SetTransferFee sub-op (=5) + u16 LE bps + u64 LE max fee.
    const data = ix.data;
    expect(data).toHaveLength(12);
    expect(data[0]).toBe(26);
    expect(data[1]).toBe(5);
    expect(new DataView(data.buffer, data.byteOffset).getUint16(2, true)).toBe(250);
    expect(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true)).toBe(1_000_000n);
  });

  it('rejects set-transfer-fee on a classic SPL mint', async () => {
    const authority = Keypair.generate();
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const ctx = ctxWithMintOwner(TOKEN_PROGRAM_ID);
    await expect(
      buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, {
        kind: 'set-transfer-fee',
        bps: 100,
        maxFeeRaw: 1n,
      }),
    ).rejects.toThrow(/Token-2022/);
  });

  it('rejects fees above 10000 bps', async () => {
    const authority = Keypair.generate();
    const ctx = ctxWithMintOwner(TOKEN_2022_PROGRAM_ID);
    await expect(
      buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, {
        kind: 'set-transfer-fee',
        bps: 10_001,
        maxFeeRaw: 1n,
      }),
    ).rejects.toThrow(/10000/);
  });
});

describe('buildAdminInstructions: pause/resume', () => {
  it('targets the Pausable extension on Token-2022 mints', async () => {
    const authority = Keypair.generate();
    const ctx = ctxWithMintOwner(TOKEN_2022_PROGRAM_ID);
    const [pause] = await buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, { kind: 'pause' });
    const [resume] = await buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, { kind: 'resume' });
    expect(pause!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(resume!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // Both anchor on TokenInstruction.PausableExtension (=44); the sub-op
    // byte selects Pause (1) vs Resume (2).
    expect(pause!.data[0]).toBe(44);
    expect(resume!.data[0]).toBe(44);
    expect(pause!.data[1]).not.toBe(resume!.data[1]);
    expect(pause!.data[1]).toBe(1);
    expect(resume!.data[1]).toBe(2);
  });

  it('rejects pause on a classic SPL mint', async () => {
    const authority = Keypair.generate();
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const ctx = ctxWithMintOwner(TOKEN_PROGRAM_ID);
    await expect(
      buildAdminInstructions(ctx, { authority, mint: MINT.toBase58() }, { kind: 'pause' }),
    ).rejects.toThrow(/Token-2022/);
  });
});
