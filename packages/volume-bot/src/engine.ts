/**
 * Anti-MEV volume bot engine.
 *
 * Each round trip is an ATOMIC buy→sell: both legs land in a single
 * transaction (intra-tx mode) so there is no inter-transaction window for a
 * sandwich — the classic anti-MEV shape. Bundle mode packs several wallets'
 * round-trip transactions into one Jito bundle so they land in the same slot.
 *
 * Everything flows through TransactionSender, which enforces simulation-first
 * dispatch and pre-flight simulation on every transaction.
 *
 * INTEGRITY: this tool generates *synthetic* on-chain volume. Do NOT use it to
 * misrepresent activity — artificial volume / wash trading can violate laws,
 * exchange rules and venue policies. It exists for localnet testing, program
 * fuzzing, staging environments, and transparent liquidity-research.
 * @module
 */

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { SendOutcome, SendOptions } from '@solana-toolkit/types';
import type { SolanaRpcClient } from '@solana-toolkit/rpc-client';
import type { JitoBundleClient } from '@solana-toolkit/rpc-client';
import { TransactionSender, type TransactionRequest } from '@solana-toolkit/transaction-builder';
import { moduleLogger, sleep } from '@solana-toolkit/utils';
import {
  resolveVenue,
  type RoundTripQuote,
  type VenueAdapter,
  type VenueContext,
} from '@solana-toolkit/venues';
import { BudgetExhausted, BudgetTracker } from './budget.js';
import type { VolumeBotConfig } from './config.js';
import { fundWalletPool, type PoolWallet } from './wallets.js';

const log = moduleLogger('volume-bot.engine');

/** Per-round audit record appended to the JSONL report. */
export interface VolumeBotRoundRecord {
  round: number;
  wallet: string;
  venue: string;
  sizeLamports: string;
  tokensTraded: string;
  expectedCostLamports: string;
  signatures: string[];
  simulated: boolean;
  ok: boolean;
  error?: string;
  measuredDeltaLamports?: string;
  bundleId?: string;
  at: string;
}

export interface VolumeBotRunReport {
  mint: string;
  venue: string;
  pool: string;
  mode: 'simulate' | 'execute';
  roundsAttempted: number;
  roundTripsSucceeded: number;
  roundTripsFailed: number;
  grossVolumeLamports: bigint;
  expectedNetCostLamports: bigint;
  realizedNetCostLamports: bigint | null;
  outcomes: SendOutcome[];
  records: VolumeBotRoundRecord[];
}

export interface VolumeBotDeps {
  rpc: SolanaRpcClient;
  sender: TransactionSender;
  jito: JitoBundleClient;
  config: VolumeBotConfig;
  /** Effective runtime mode — 'execute' only when the caller passed --execute AND simulation is off. */
  mode: 'simulate' | 'execute';
  /** Pool of trading wallets. */
  pool: PoolWallet[];
  /** Optional funder wallet (funds the pool, pays bundle tips). */
  funder?: Keypair;
  /** Directory for the JSONL run report. Default ./output */
  outputDir?: string;
  /** Abort predicate checked each round (SIGINT plumbing lives in the CLI). */
  shouldStop?: () => boolean;
}

function randomSize(min: bigint, max: bigint): bigint {
  if (max <= min) return min;
  return min + BigInt(randomInt(Number(max - min) + 1));
}

export class VolumeBot {
  private readonly budget: BudgetTracker;
  private adapter!: VenueAdapter<VenueContext>;
  private ctx!: VenueContext;
  private reportStream: fs.WriteStream | null = null;

  constructor(private readonly deps: VolumeBotDeps) {
    this.budget = new BudgetTracker(deps.config.budget);
  }

  /** Resolves the venue and validates wallet balances before the first round. */
  async prepare(): Promise<void> {
    const cfg = this.deps.config;
    const resolved = await resolveVenue(this.deps.rpc, new PublicKey(cfg.mint), cfg.venue, {
      cpmmPoolAddress: cfg.cpmmPoolAddress,
      launchlab: { shareFeeRate: cfg.launchlabShareFeeRate },
    });
    this.adapter = resolved.adapter;
    this.ctx = resolved.ctx;
    log.info(
      { venue: this.ctx.kind, pool: this.ctx.poolAddress, mint: cfg.mint, wallets: this.deps.pool.length, mode: this.deps.mode },
      'volume bot prepared',
    );

    if (this.deps.funder && this.deps.mode === 'execute') {
      await fundWalletPool(
        this.deps.rpc,
        this.deps.sender,
        this.deps.funder,
        this.deps.pool,
        cfg.tradeLamports.max,
        { mode: 'execute' },
      );
    }
  }

  /** Runs the configured schedule. Safe to call once. */
  async run(): Promise<VolumeBotRunReport> {
    const cfg = this.deps.config;
    const report: VolumeBotRunReport = {
      mint: cfg.mint,
      venue: '',
      pool: '',
      mode: this.deps.mode,
      roundsAttempted: 0,
      roundTripsSucceeded: 0,
      roundTripsFailed: 0,
      grossVolumeLamports: 0n,
      expectedNetCostLamports: 0n,
      realizedNetCostLamports: null,
      outcomes: [],
      records: [],
    };
    this.openReport();

    const perRound = Math.min(cfg.schedule.walletsPerRound, this.deps.pool.length);
    let walletCursor = 0;
    const realized: { value: bigint } | null = this.deps.mode === 'execute' ? { value: 0n } : null;

    try {
      for (let round = 0; round < cfg.schedule.rounds; round++) {
        if (this.deps.shouldStop?.()) {
          log.info({ round }, 'stop requested — winding down');
          break;
        }
        const batch: PoolWallet[] = [];
        for (let i = 0; i < perRound; i++) {
          batch.push(this.deps.pool[walletCursor % this.deps.pool.length]!);
          walletCursor++;
        }
        report.roundsAttempted++;

        // Fresh reserves for every round — pool state moves between rounds.
        this.ctx = await this.adapter.refresh(this.ctx);

        const legs = batch.map((w) => ({
          wallet: w,
          size: randomSize(cfg.tradeLamports.min, cfg.tradeLamports.max),
        }));

        try {
          if (cfg.execution === 'bundle') {
            const outcome = await this.executeBundle(round, legs, realized);
            report.outcomes.push(outcome);
          } else {
            for (const leg of legs) {
              const outcome = await this.executeIntraTx(round, leg.wallet, leg.size, realized);
              report.outcomes.push(outcome);
            }
          }
        } catch (err) {
          if (err instanceof BudgetExhausted) {
            log.warn({ reason: err.reason }, 'budget cap hit — stopping');
            break;
          }
          report.roundTripsFailed += legs.length;
          for (const leg of legs) this.budget.recordFailure(leg.wallet.keypair.publicKey.toBase58());
          log.error({ err, round }, 'round failed');
        }

        const snap = this.budget.snapshot();
        report.grossVolumeLamports = snap.totalVolumeLamports;
        report.expectedNetCostLamports = snap.totalNetCostLamports;
        report.roundTripsSucceeded = snap.wallets.reduce((a, w) => a + w.roundTrips, 0);
        report.roundTripsFailed = snap.wallets.reduce((a, w) => a + w.failures, 0);
        report.realizedNetCostLamports = realized ? realized.value : null;

        if (round < cfg.schedule.rounds - 1) {
          const jitter = cfg.schedule.jitterMs ? randomInt(cfg.schedule.jitterMs + 1) : 0;
          await sleep(cfg.schedule.intervalMs + jitter);
        }
      }
    } finally {
      this.closeReport();
      report.venue = this.ctx?.kind ?? 'unresolved';
      report.pool = this.ctx?.poolAddress ?? '';
    }
    return report;
  }

  /** Builds the atomic round-trip TransactionRequest for one wallet. */
  private async buildRoundTripRequest(
    wallet: PoolWallet,
    size: bigint,
  ): Promise<{ req: TransactionRequest; quote: RoundTripQuote }> {
    const cfg = this.deps.config;
    const quote = await this.adapter.quoteRoundTrip(this.ctx, size, cfg.slippageBps);

    this.budget.checkRoundTrip(wallet.keypair.publicKey.toBase58(), quote.maxSolIn, quote.expectedCostLamports);

    const user = wallet.keypair.publicKey;
    const buy = await this.adapter.buyIxs(this.ctx, user, quote);
    const sell = await this.adapter.sellIxs(this.ctx, user, quote);
    const cleanup = this.adapter.cleanupIxs?.(this.ctx, user) ?? [];

    const lookupTables = [...(buy.lookupTables ?? []), ...(sell.lookupTables ?? [])];
    const req: TransactionRequest = {
      description: `volbot-rt ${user.toBase58().slice(0, 8)} ${quote.venue}`,
      feePayer: user.toBase58(),
      instructions: [...buy.instructions, ...sell.instructions, ...cleanup],
      signers: [wallet.keypair],
      lookupTables: lookupTables.length ? dedupeLuts(lookupTables) : undefined,
      priorityFee: cfg.priorityFee,
    };
    return { req, quote };
  }

  /** intra-tx: each wallet's buy+sell is one atomic transaction. */
  private async executeIntraTx(
    round: number,
    wallet: PoolWallet,
    size: bigint,
    realized: { value: bigint } | null,
  ): Promise<SendOutcome> {
    const cfg = this.deps.config;
    const addr = wallet.keypair.publicKey.toBase58();
    const { req, quote } = await this.buildRoundTripRequest(wallet, size);

    const before = this.deps.mode === 'execute' ? await this.safeBalance(addr) : null;
    const outcome = await this.deps.sender.send(req, {
      mode: this.deps.mode,
      jito: cfg.dispatch === 'jito-tx',
    } satisfies SendOptions);
    const ok = outcome.simulated || outcome.signature !== '';
    if (ok) {
      this.budget.recordRoundTrip(addr, quote.maxSolIn, quote.expectedCostLamports);
    } else {
      this.budget.recordFailure(addr);
    }

    let measured: bigint | undefined;
    if (before !== null && !outcome.simulated && outcome.signature) {
      await this.deps.rpc.confirm(outcome.signature).catch(() => undefined);
      const after = await this.safeBalance(addr);
      if (after !== null && realized) {
        measured = before - after;
        realized.value += measured;
      }
    }

    this.record({
      round,
      wallet: addr,
      venue: quote.venue,
      sizeLamports: quote.maxSolIn.toString(),
      tokensTraded: quote.tokensOut.toString(),
      expectedCostLamports: quote.expectedCostLamports.toString(),
      signatures: outcome.signatures,
      simulated: outcome.simulated,
      ok,
      error: outcome.warnings.join('; ') || undefined,
      measuredDeltaLamports: measured?.toString(),
      at: new Date().toISOString(),
    });
    log.info({ round, wallet: addr.slice(0, 8), ok, sig: outcome.signature }, 'round trip done');
    return outcome;
  }

  /** bundle: all wallets' round-trip txs in one Jito bundle (same slot). */
  private async executeBundle(
    round: number,
    legs: { wallet: PoolWallet; size: bigint }[],
    _realized: { value: bigint } | null,
  ): Promise<SendOutcome> {
    const cfg = this.deps.config;
    const reqs: TransactionRequest[] = [];
    const quotes = new Map<string, RoundTripQuote>();
    for (const leg of legs) {
      const { req, quote } = await this.buildRoundTripRequest(leg.wallet, leg.size);
      reqs.push(req);
      quotes.set(leg.wallet.keypair.publicKey.toBase58(), quote);
    }

    // Tip paid by the funder as its own bundle member when configured; else
    // the sender auto-appends a tip tx paid by the last member's signer.
    let requireTip = true;
    if (cfg.bundleTipFromFunder && this.deps.funder) {
      const tipAccount = new PublicKey(await this.deps.jito.randomTipAccount());
      reqs.push({
        description: 'jito-tip',
        feePayer: this.deps.funder.publicKey.toBase58(),
        instructions: [
          SystemProgram.transfer({
            fromPubkey: this.deps.funder.publicKey,
            toPubkey: tipAccount,
            lamports: BigInt(this.deps.config.priorityFee?.jitoTipLamports ?? 100_000),
          }),
        ],
        signers: [this.deps.funder],
        priorityFee: { computeUnitLimit: 5_000 },
      });
      requireTip = false;
    }

    const outcome = await this.deps.sender.sendBundle(reqs, { mode: this.deps.mode }, requireTip);
    const ok = outcome.simulated || !!outcome.bundleId;

    for (const leg of legs) {
      const addr = leg.wallet.keypair.publicKey.toBase58();
      const q = quotes.get(addr)!;
      if (ok) this.budget.recordRoundTrip(addr, q.maxSolIn, q.expectedCostLamports);
      else this.budget.recordFailure(addr);
      this.record({
        round,
        wallet: addr,
        venue: q.venue,
        sizeLamports: q.maxSolIn.toString(),
        tokensTraded: q.tokensOut.toString(),
        expectedCostLamports: q.expectedCostLamports.toString(),
        signatures: outcome.signatures,
        simulated: outcome.simulated,
        ok,
        bundleId: outcome.bundleId,
        at: new Date().toISOString(),
      });
    }
    log.info({ round, bundleId: outcome.bundleId, members: reqs.length }, 'bundle dispatched');
    return outcome;
  }

  private async safeBalance(addr: string): Promise<bigint | null> {
    try {
      return await this.deps.rpc.balance(addr);
    } catch {
      return null;
    }
  }

  private openReport(): void {
    const dir = path.resolve(this.deps.outputDir ?? './output');
    fs.mkdirSync(dir, { recursive: true });
    this.reportStream = fs.createWriteStream(path.join(dir, 'volume-bot-report.jsonl'), { flags: 'a' });
  }

  private record(r: VolumeBotRoundRecord): void {
    try {
      this.reportStream?.write(JSON.stringify(r) + '\n');
    } catch (err) {
      log.warn({ err }, 'failed to write report record');
    }
  }

  private closeReport(): void {
    this.reportStream?.end();
    this.reportStream = null;
  }

  /** Live budget snapshot for dashboards/CLI status output. */
  stats() {
    return this.budget.snapshot();
  }
}

function dedupeLuts(tables: import('@solana/web3.js').AddressLookupTableAccount[]) {
  const seen = new Set<string>();
  return tables.filter((t) => (seen.has(t.key.toBase58()) ? false : (seen.add(t.key.toBase58()), true)));
}
