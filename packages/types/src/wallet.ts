/**
 * Wallet, keystore, and balance-related types.
 * @module
 */

/** A wallet entry as persisted in a batch wallet file (PUBLIC info; secrets stay in keystores). */
export interface WalletRecord {
  label: string;
  publicKey: string;
}

/** Encrypted keystore envelope. Private keys are AES-256-GCM encrypted with an scrypt-derived key. */
export interface KeystoreEnvelope {
  /** Envelope format tag. */
  format: 'soladmin-keystore';
  /** Envelope version. */
  version: 1;
  /** Key derivation function. */
  kdf: 'scrypt';
  /** scrypt parameters. */
  kdfParams: {
    n: number;
    r: number;
    p: number;
    dklen: number;
    salt: string; // hex
  };
  /** Cipher. */
  cipher: 'aes-256-gcm';
  cipherParams: {
    iv: string; // hex
    tag: string; // hex
  };
  /** Encrypted secret key bytes (hex). */
  ciphertext: string;
  /** Public key of the embedded keypair (safe to read without password). */
  publicKey: string;
  /** Free-form label. */
  label?: string;
  /** Creation timestamp (ISO). */
  createdAt: string;
}

/** One wallet row of a batch balance check. */
export interface BalanceRow {
  label: string;
  publicKey: string;
  /** SOL balance in lamports. */
  lamports: bigint;
  /** Native SOL balance in SOL. */
  sol: number;
  /** Token balances keyed by mint (raw base units). */
  tokens: Record<string, bigint>;
}

/** Vanity address generator criteria. */
export interface VanityCriteria {
  /** Address must start with this prefix (case-insensitive). */
  startsWith?: string;
  /** Address must end with this suffix (case-insensitive). */
  endsWith?: string;
  /** Require exact case matching (slower, more specific). */
  caseSensitive?: boolean;
  /** Stop after this many matches (default 1). */
  count?: number;
}

/** Vanity generation result. */
export interface VanityResult {
  label: string;
  publicKey: string;
  secretKeyHex: string;
  attempts: bigint;
  elapsedMs: number;
}

/** Stealth transfer — small randomized splits to reduce graph linking. */
export interface StealthTransferLeg {
  /** Intermediate (fresh or shared-pool) wallet that relays the funds. */
  relayPublicKey: string;
  relayKeystore?: string;
  /** Amount in raw lamports. */
  lamports: bigint;
  /** Artificial delay before this leg fires, in ms. */
  delayMs: number;
}

/** Stealth transfer plan. */
export interface StealthTransferPlan {
  legs: StealthTransferLeg[];
  destination: string;
  totalLamports: bigint;
  estimatedFees: bigint;
}
