/**
 * Borsh/Anchor encoding primitives.
 *
 * All raw instruction encoding in this package flows through these helpers so
 * layouts stay reviewable in one place.
 * @module
 */

import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Anchor instruction discriminator: sha256("global:<snake_name>")[0..8].
 */
export function anchorDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

/** Little-endian u8. */
export function u8(value: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(value, 0);
  return b;
}

/** Little-endian u16. */
export function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

/** Little-endian i64/u64 from bigint. */
export function u64(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value), 0);
  return b;
}

/** Little-endian i64 (signed). */
export function i64(value: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(value), 0);
  return b;
}

/** Little-endian f32. */
export function f32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value, 0);
  return b;
}

/** Borsh string: u32 length + UTF-8 bytes. */
export function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 0xffffffff) throw new Error('string too long');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/** Borsh pubkey. */
export function pubKey(value: string | PublicKey): Buffer {
  const pk = typeof value === 'string' ? new PublicKey(value) : value;
  return Buffer.from(pk.toBytes());
}

/** Borsh Option<T> (none = 0, some = 1 + value). */
export function borshOption<T extends Buffer>(value: T | null | undefined): Buffer {
  if (value === null || value === undefined) return u8(0);
  return Buffer.concat([u8(1), value]);
}

/**
 * Anchor `OptionBool` custom struct used by Pump.fun (struct { bool } — a
 * single byte, no Option tag).
 */
export function pumpOptionBool(value: boolean | undefined): Buffer {
  return u8(value === undefined ? 0 : value ? 1 : 0);
}

/**
 * Reads a borsh string at `offset` in account data.
 * Returns [value, nextOffset].
 */
export function readBorshString(data: Buffer, offset: number): [string, number] {
  const len = data.readUInt32LE(offset);
  const value = data.subarray(offset + 4, offset + 4 + len).toString('utf8');
  return [value, offset + 4 + len];
}

/** Reads a u64 at `offset` as bigint. */
export function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

/** Reads a pubkey at `offset` as base58 string. */
export function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/**
 * Finds a program address (PDA) from string seeds.
 */
export function findPda(
  seeds: (string | Buffer | Uint8Array | PublicKey)[],
  programId: string | PublicKey,
): PublicKey {
  const seedBuffers = seeds.map((s) =>
    typeof s === 'string'
      ? Buffer.from(s, 'utf8')
      : s instanceof PublicKey
        ? Buffer.from(s.toBytes())
        : Buffer.from(s),
  );
  const pid = typeof programId === 'string' ? new PublicKey(programId) : programId;
  const [pda] = PublicKey.findProgramAddressSync(seedBuffers, pid);
  return pda;
}
