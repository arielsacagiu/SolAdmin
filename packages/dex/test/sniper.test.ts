import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  parseCreateEvent,
  instructionsFromVersionedTransaction,
} from '../src/index.js';
import {
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
} from '@solana/web3.js';

describe('pump.fun create event parser', () => {
  it('parses a valid CreateEvent payload', () => {
    const disc = Buffer.from([144, 174, 88, 225, 202, 66, 189, 183]);
    const name = Buffer.alloc(32); name.write('TestCoin', 0, 'utf8');
    const symbol = Buffer.alloc(10); symbol.write('TST', 0, 'utf8');
    const uri = Buffer.alloc(200); uri.write('https://example.com/m.json', 0, 'utf8');
    const mint = Keypair.generate().publicKey.toBytes();
    const curve = Keypair.generate().publicKey.toBytes();
    const user = Keypair.generate().publicKey.toBytes();
    const payload = Buffer.concat([disc, name, symbol, uri, Buffer.from(mint), Buffer.from(curve), Buffer.from(user)]);
    const target = parseCreateEvent([`Program log: ${payload.toString('base64')}`]);
    expect(target).not.toBeNull();
    expect(target!.name).toBe('TestCoin');
    expect(target!.symbol).toBe('TST');
    expect(target!.uri).toBe('https://example.com/m.json');
    expect(target!.mint).toBe(new PublicKey(mint).toBase58());
  });

  it('ignores non-event logs', () => {
    expect(parseCreateEvent(['Program log: irrelevant'])).toBeNull();
    expect(parseCreateEvent(['Program 6EF8 consumed'])).toBeNull();
  });
});

describe('instructionsFromVersionedTransaction', () => {
  it('reconstructs instructions with correct metas', () => {
    const payer = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 123 });
    const budget = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: '1111111111111111111111111111111111111111111111111111111111111011',
      instructions: [budget, transfer],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const ixs = instructionsFromVersionedTransaction(vtx);
    expect(ixs).toHaveLength(2);
    expect(ixs[1]!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ixs[1]!.keys[0]!.pubkey.equals(payer.publicKey)).toBe(true);
    expect(ixs[1]!.keys[0]!.isSigner).toBe(true);
    expect(ixs[1]!.keys[0]!.isWritable).toBe(true);
    expect(ixs[1]!.keys[1]!.pubkey.equals(to)).toBe(true);
    expect(ixs[1]!.keys[1]!.isWritable).toBe(true);
    // Data survives the round trip.
    expect(Buffer.compare(Buffer.from(ixs[1]!.data), Buffer.from(transfer.data))).toBe(0);
  });
});
