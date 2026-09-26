import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import {
  generateKeystore,
  generateVanityWallets,
  loadKeystore,
  writeEncryptedKeystore,
} from '../src/index.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soladmin-test-'));
}

describe('encrypted keystore', () => {
  it('round-trips a keypair through an encrypted envelope', () => {
    const dir = tmpdir();
    const kp = Keypair.generate();
    const file = path.join(dir, 'test.keystore.json');
    writeEncryptedKeystore(kp, 'correct horse battery staple', file, 'test');
    const loaded = loadKeystore(file, 'correct horse battery staple');
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(Buffer.from(loaded.secretKey).toString('hex')).toBe(Buffer.from(kp.secretKey).toString('hex'));
  });

  it('refuses the wrong password', () => {
    const dir = tmpdir();
    const { keypair, file } = generateKeystore(path.join(dir, 'k.keystore.json'), 'pw1');
    expect(() => loadKeystore(file, 'pw2')).toThrow(/decrypt/i);
    expect(keypair.publicKey.toBase58()).toBe(loadKeystore(file, 'pw1').publicKey.toBase58());
  });

  it('loads plain JSON array keystores with a warning path', () => {
    const dir = tmpdir();
    const kp = Keypair.generate();
    const file = path.join(dir, 'plain.json');
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    const loaded = loadKeystore(file);
    expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
});

describe('vanity generator', () => {
  it('finds case-insensitive prefixes', () => {
    const results = generateVanityWallets({ startsWith: 'so', count: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.publicKey.toLowerCase().startsWith('so')).toBe(true);
    expect(results[0]!.attempts).toBeGreaterThan(0n);
  });

  it('rejects invalid base58 criteria', () => {
    expect(() => generateVanityWallets({ startsWith: '0lI' })).toThrow(/base58/);
  });
});
