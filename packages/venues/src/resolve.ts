/**
 * Venue resolution — maps a mint + requested venue kind to a ready-to-use
 * adapter + context. 'auto' probes venues cheapest-first:
 * pump.fun (PDA read) → PumpSwap (memcmp scan) → LaunchLab (PDA + scan) →
 * Raydium CPMM (memcmp scan) → Jupiter (route probe).
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import { moduleLogger } from '@solana-toolkit/utils';
import { CpmmVenue } from './cpmm.js';
import { JupiterVenue, type JupiterVenueOptions } from './jupiter.js';
import { LaunchLabVenue, type LaunchLabVenueOptions } from './launchlab.js';
import { PumpSwapVenue } from './pumpswap.js';
import { PumpfunVenue } from './pumpfun.js';
import type { VenueAdapter, VenueContext, VenueKind } from './types.js';

const log = moduleLogger('venue.resolve');

export interface ResolveVenueOptions {
  /** Explicit pool override for CPMM pools (skips the program scan). */
  cpmmPoolAddress?: string;
  launchlab?: LaunchLabVenueOptions;
  jupiter?: JupiterVenueOptions;
  /** Ordered venues 'auto' should try. Defaults to all direct venues + jupiter. */
  autoOrder?: Exclude<VenueKind, 'auto'>[];
  /** Per-venue probe timeout for 'auto' mode, ms. Default 20_000. */
  probeTimeoutMs?: number;
}

export interface ResolvedVenue {
  adapter: VenueAdapter<VenueContext>;
  ctx: VenueContext;
}

/** Creates the adapter for an explicit (non-'auto') venue kind. */
export function createVenueAdapter(
  kind: Exclude<VenueKind, 'auto'>,
  rpc: SolanaRpcClient,
  opts: ResolveVenueOptions = {},
): VenueAdapter<VenueContext> {
  switch (kind) {
    case 'pumpfun':
      return new PumpfunVenue(rpc) as VenueAdapter<VenueContext>;
    case 'pumpswap':
      return new PumpSwapVenue(rpc) as VenueAdapter<VenueContext>;
    case 'launchlab':
      return new LaunchLabVenue(rpc, opts.launchlab) as VenueAdapter<VenueContext>;
    case 'cpmm':
      return new CpmmVenue(rpc, { poolAddress: opts.cpmmPoolAddress }) as VenueAdapter<VenueContext>;
    case 'jupiter':
      return new JupiterVenue(rpc, opts.jupiter) as VenueAdapter<VenueContext>;
  }
}

/**
 * Resolves `mint` to a venue + context. With kind 'auto' each venue is probed
 * in `autoOrder` until one resolves — failures are logged at debug and skipped.
 */
export async function resolveVenue(
  rpc: SolanaRpcClient,
  mint: PublicKey,
  kind: VenueKind = 'auto',
  opts: ResolveVenueOptions = {},
): Promise<ResolvedVenue> {
  if (kind !== 'auto') {
    const adapter = createVenueAdapter(kind, rpc, opts);
    const ctx = await adapter.resolve(mint);
    log.info({ venue: ctx.kind, pool: ctx.poolAddress, mint: ctx.mint }, 'venue resolved');
    return { adapter, ctx };
  }

  const order = opts.autoOrder ?? ['pumpfun', 'pumpswap', 'launchlab', 'cpmm', 'jupiter'];
  const timeoutMs = opts.probeTimeoutMs ?? 20_000;
  const errors: string[] = [];
  for (const k of order) {
    try {
      const adapter = createVenueAdapter(k, rpc, opts);
      // getProgramAccounts scans can hang on public RPC — bound each probe.
      const ctx = await Promise.race([
        adapter.resolve(mint),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      log.info({ venue: ctx.kind, pool: ctx.poolAddress, mint: ctx.mint }, 'auto venue resolved');
      return { adapter, ctx };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${k}: ${msg}`);
      log.debug({ venue: k, err: msg }, 'venue probe failed');
    }
  }
  throw new Error(`no venue found for mint ${mint.toBase58()} — tried [${order.join(', ')}]\n${errors.join('\n')}`);
}
