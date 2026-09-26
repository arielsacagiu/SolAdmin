import { describe, expect, it } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { buildSignedTransaction, prepareUnsigned } from '../src/builder.js';
import { computeBudgetInstructions, jitoTipInstruction } from '../src/compute-budget.js';
import { JITO_TIP_ACCOUNTS_FALLBACK } from '@solana-toolkit/rpc-client';

// Valid 32-byte base58 blockhash for message compilation in tests.
const blockhash = {
  blockhash: 'EETub36tYt4Qh6t4tDfV7ysnjfeGjVjPfFQHqKsetMNK',
  lastValidBlockHeight: 1000,
};

describe('compute budget', () => {
  it('produces setComputeUnitLimit and setComputeUnitPrice', () => {
    const ixs = computeBudgetInstructions({ microLamportsPerCu: 150_000 }, undefined);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.data.length).toBe(5); // u32 tag + units
    expect(ixs[1]!.data.length).toBe(9); // u32 tag + u64 price
  });

  it('sizes CU limit above simulated consumption', () => {
    const ixs = computeBudgetInstructions({ microLamportsPerCu: 1 }, 100_000);
    expect(ixs[0]!.data.readUInt32LE(1)).toBeGreaterThanOrEqual(100_000);
  });

  it('builds a Jito tip transfer to a known tip account', () => {
    const payer = Keypair.generate().publicKey;
    const ix = jitoTipInstruction(payer, 1000n);
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    const to = ix.keys.find((k) => !k.pubkey.equals(payer) && !k.pubkey.equals(SystemProgram.programId))!;
    expect(JITO_TIP_ACCOUNTS_FALLBACK).toContain(to.pubkey.toBase58());
  });
});

describe('buildSignedTransaction', () => {
  it('signs and serializes a versioned transaction with tip appended last', () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const transfer = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1000,
    });
    const signed = buildSignedTransaction({
      description: 'test transfer',
      feePayer: payer.publicKey,
      instructions: [transfer],
      priorityFee: { microLamportsPerCu: 1000 },
      jitoTipLamports: 500n,
      signers: [payer],
      blockhash,
    });
    expect(signed.base64.length).toBeGreaterThan(100);

    const vtx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(signed.base64, 'base64')));
    // 2 budget instructions + transfer + tip
    const compiled = vtx.message.compiledInstructions;
    expect(compiled).toHaveLength(4);
    const last = compiled[compiled.length - 1]!;
    const lastProgram = vtx.message.staticAccountKeys[last.programIdIndex]!;
    expect(lastProgram.equals(SystemProgram.programId)).toBe(true);
  });

  it('prepareUnsigned returns message metadata without signing', () => {
    const payer = Keypair.generate();
    const prepared = prepareUnsigned({
      description: 'unsigned',
      feePayer: payer.publicKey,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
      priorityFee: {},
      blockhash,
    });
    expect(prepared.instructionCount).toBe(3); // 2 budget + transfer
    expect(prepared.feePayer).toBe(payer.publicKey.toBase58());
  });

  it('compute unit limit instruction tag matches web3.js layout', () => {
    const ours = computeBudgetInstructions({ computeUnitLimit: 1234 }, undefined)[0]!;
    const theirs = ComputeBudgetProgram.setComputeUnitLimit({ units: 1234 });
    expect(Buffer.compare(Buffer.from(ours.data), Buffer.from(theirs.data))).toBe(0);
  });
});
