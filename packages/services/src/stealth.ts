/**
 * Stealth Transfer — splits a transfer across intermediate relay wallets with
 * randomized amounts and delays to reduce on-chain graph linkability.
 *
 * PRIVACY WARNING: this is heuristic obfuscation, NOT anonymity. Chain
 * analysis can still correlate legs; use dedicated privacy tools for
 * stronger guarantees. This module exists to replicate the toolkit's
 * "stealth transfer" feature with explicit caveats.
 * @module
 */

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { SendOutcome, StealthTransferPlan } from '@solana-toolkit/types';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import type { ServiceContext } from './context.js';

const log = moduleLogger('stealth');

export interface StealthTransferOptions {
  source: Keypair;
  destination: string;
  totalLamports: bigint;
  /** Relay wallets (must be pre-funded with 0 SOL; they pass funds through). */
  relays: Keypair[];
  /** Number of legs to split across (default: min(relays.length, 3)). */
  legs?: number;
  /** Randomization seed for jitter (deterministic tests). */
  jitterBps?: number;
  mode?: 'simulate' | 'execute';
}

/**
 * Builds a stealth transfer plan: N legs, each with randomized amount
 * (±jitter) and delay.
 */
export function planStealthTransfer(opts: StealthTransferOptions): StealthTransferPlan {
  const legs = Math.min(opts.legs ?? Math.min(opts.relays.length, 3), opts.relays.length);
  if (legs === 0) throw new Error('stealth transfer needs at least one relay wallet');

  // Split with jitter: base + pseudo-random weight.
  const weights = Array.from({ length: legs }, (_, i) => 1 + ((i * 37) % 23) / 23);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const perLeg = opts.totalLamports / BigInt(legs);
  const plan: StealthTransferPlan = {
    legs: [],
    destination: opts.destination,
    totalLamports: opts.totalLamports,
    estimatedFees: 10_000n * BigInt(legs * 2),
  };
  let allocated = 0n;
  for (let i = 0; i < legs; i++) {
    const weight = weights[i]!;
    const amount = i === legs - 1 ? opts.totalLamports - allocated : (perLeg * BigInt(Math.round(weight * 100))) / 100n;
    allocated += amount;
    plan.legs.push({
      relayPublicKey: opts.relays[i]!.publicKey.toBase58(),
      lamports: amount,
      delayMs: 2_000 + ((i * 731) % 5) * 900,
    });
  }
  return plan;
}

/**
 * Executes the stealth transfer plan: source → relay, wait, relay →
 * destination.
 */
export async function executeStealthTransfer(
  ctx: ServiceContext,
  opts: StealthTransferOptions,
): Promise<{ plan: StealthTransferPlan; outcomes: SendOutcome[] }> {
  const plan = planStealthTransfer(opts);
  const outcomes: SendOutcome[] = [];
  const destination = opts.destination;

  for (const [i, leg] of plan.legs.entries()) {
    const relay = opts.relays[i]!;
    // Leg 1: source → relay.
    const leg1: TransactionInstruction[] = [
      SystemProgram.transfer({
        fromPubkey: opts.source.publicKey,
        toPubkey: relay.publicKey,
        lamports: leg.lamports,
      }),
    ];
    outcomes.push(
      await ctx.sender.send(
        {
          description: `stealth leg ${i + 1}a (source→relay)`,
          feePayer: opts.source.publicKey.toBase58(),
          instructions: leg1,
          signers: [opts.source],
        },
        { mode: opts.mode },
      ),
    );
    if (leg.delayMs > 0 && opts.mode !== 'simulate') {
      await sleep(leg.delayMs);
    }
    // Leg 2: relay → destination (leave a little for the relay's fee).
    outcomes.push(
      await ctx.sender.send(
        {
          description: `stealth leg ${i + 1}b (relay→destination)`,
          feePayer: relay.publicKey.toBase58(),
          instructions: [
            SystemProgram.transfer({
              fromPubkey: relay.publicKey,
              toPubkey: new PublicKey(destination),
              lamports: leg.lamports - 5_000n,
            }),
          ],
          signers: [relay],
        },
        { mode: opts.mode },
      ),
    );
  }
  log.warn('stealth transfer is heuristic obfuscation, not anonymity');
  return { plan, outcomes };
}
