/**
 * JSON keystore management for Solana keypairs.
 *
 * Two formats are supported:
 *   1. Encrypted envelopes (`soladmin-keystore`, scrypt + AES-256-GCM) — the
 *      recommended format. Secret keys never touch disk in plaintext.
 *   2. Plain Solana CLI-style JSON arrays — accepted for migration and local
 *      validators only; loading emits a loud security warning.
 *
 * SECURITY: passphrase entry is interactive by default. Automation can set
 * SOLADMIN_KEYSTORE_PASSWORD, but avoid it on shared machines.
 * @module
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import type { KeystoreEnvelope } from '@solana-toolkit/types';
import { moduleLogger, warnUnencryptedKeystore } from '@solana-toolkit/utils';

const log = moduleLogger('keystore');

const KDF_PARAMS = { n: 16384, r: 8, p: 1, dklen: 32 } as const;

/**
 * Reads a password interactively (hidden input) when no env override exists.
 */
export async function readPassword(prompt = 'Keystore password: '): Promise<string> {
  const env = process.env['SOLADMIN_KEYSTORE_PASSWORD'];
  if (env && env.length > 0) return env;
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isTTY;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      if (s.includes('\r') || s.includes('\n')) {
        process.stdin.setRawMode?.(wasRaw ?? false);
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(data);
      } else {
        data += s;
      }
    });
  });
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KDF_PARAMS.dklen, {
    N: KDF_PARAMS.n,
    r: KDF_PARAMS.r,
    p: KDF_PARAMS.p,
  });
}

/**
 * Creates an encrypted keystore file for a keypair.
 * @returns the path written.
 */
export function writeEncryptedKeystore(
  keypair: Keypair,
  password: string,
  file: string,
  label?: string,
): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(keypair.secretKey);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: KeystoreEnvelope = {
    format: 'soladmin-keystore',
    version: 1,
    kdf: 'scrypt',
    kdfParams: { ...KDF_PARAMS, salt: salt.toString('hex') },
    cipher: 'aes-256-gcm',
    cipherParams: { iv: iv.toString('hex'), tag: tag.toString('hex') },
    ciphertext: ciphertext.toString('hex'),
    publicKey: keypair.publicKey.toBase58(),
    label,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), 'utf8');
  fs.chmodSync(file, 0o600);
  log.info({ file, publicKey: envelope.publicKey }, 'encrypted keystore written');
  return file;
}

/**
 * Loads a keystore file (encrypted or plain JSON array) and returns the keypair.
 * @param password required for encrypted keystores; ignored for plain files.
 */
export function loadKeystore(file: string, password?: string): Keypair {
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`keystore file ${file} is not valid JSON`);
  }

  // Plain Solana CLI format: array of 64 numbers.
  if (Array.isArray(parsed)) {
    warnUnencryptedKeystore(file);
    const secret = Uint8Array.from(parsed as number[]);
    if (secret.length !== 64) throw new Error('plain keystore must contain 64 bytes');
    return Keypair.fromSecretKey(secret);
  }

  const env = parsed as KeystoreEnvelope;
  if (env.format !== 'soladmin-keystore') {
    throw new Error(`unsupported keystore format in ${file}`);
  }

  const pass = password ?? process.env['SOLADMIN_KEYSTORE_PASSWORD'];
  if (!pass) {
    throw new Error(`encrypted keystore ${file} requires a password (interactive prompt or SOLADMIN_KEYSTORE_PASSWORD)`);
  }
  const salt = Buffer.from(env.kdfParams.salt, 'hex');
  const iv = Buffer.from(env.cipherParams.iv, 'hex');
  const tag = Buffer.from(env.cipherParams.tag, 'hex');
  const key = deriveKey(pass, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'hex')),
      decipher.final(),
    ]);
    const keypair = Keypair.fromSecretKey(Uint8Array.from(plaintext));
    if (keypair.publicKey.toBase58() !== env.publicKey) {
      throw new Error('public key mismatch — keystore corrupted?');
    }
    return keypair;
  } catch {
    throw new Error(`failed to decrypt keystore ${file} — wrong password?`);
  }
}

/**
 * Loads a keystore interactively (prompts for password when needed).
 */
export async function loadKeystoreInteractive(file: string): Promise<Keypair> {
  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return loadKeystore(file);
  const env = parsed as KeystoreEnvelope;
  if (env.format === 'soladmin-keystore' && !process.env['SOLADMIN_KEYSTORE_PASSWORD']) {
    const pass = await readPassword();
    return loadKeystore(file, pass);
  }
  return loadKeystore(file);
}

/**
 * Extracts the public key without decrypting (encrypted keystores only).
 */
export function readKeystorePublicKey(file: string): string {
  const env = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as KeystoreEnvelope;
  if (env.format !== 'soladmin-keystore') throw new Error('not an encrypted keystore');
  return env.publicKey;
}

/**
 * Convenience: create a NEW encrypted keystore at `file` with a generated keypair.
 */
export function generateKeystore(file: string, password: string, label?: string): { keypair: Keypair; file: string } {
  const keypair = Keypair.generate();
  writeEncryptedKeystore(keypair, password, file, label);
  return { keypair, file };
}
