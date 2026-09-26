/**
 * Simulation-first transaction dispatcher.
 *
 * Policy enforced here (the single choke point of the toolkit):
 *   1. Every transaction is PRE-FLIGHT SIMULATED before it is ever sent,
 *      unless the caller explicitly opted out (sniping hot paths).
 *   2. Simulation mode is the global default — nothing leaves the machine.
 *   3. Execution may be dispatched to the RPC endpoint or relayed through
 *      Jito (bundle or single-transaction endpoint).
 *   4. Failed sends retry with a fresh blockhash up to `maxRetries`.
 * @module
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type BlockhashWithExpiryBlockHeight,
  type Signer,
} from '@solana/web3.js';
import type {
  PriorityFeeConfig,
  SafetyConfig,
  SendOptions,
  SendOutcome,
  SimulationReport,
} from '@solana-toolkit/types';
import {
  JITO_MIN_TIP_LAMPORTS,
  JitoBundleClient,
  PriorityFeeMonitor,
  SolanaRpcClient,
} from '@solana-toolkit/rpc-client';
import { moduleLogger } from '@solana-toolkit/utils';
import { buildSignedTransaction, type BuildTransactionParams } from './builder.js';

const log = moduleLogger('sender');

/** Jito hard limit on transactions per bundle (docs.jito.wtf). */
const JITO_BUNDLE_MAX_TXS = 5;

/** What a service wants to send. The sender handles the rest. */
export interface TransactionRequest {
  description: string;
  feePayer: string;
  instructions: TransactionInstruction[];
  signers: Signer[];
  priorityFee?: PriorityFeeConfig;
  /** Address lookup tables needed to compile the v0 message (e.g. Jupiter). */
  lookupTables?: AddressLookupTableAccount[];
  /**
   * Inline Jito tip (lamports) attached as the last instruction of THIS
   * transaction. Used for bundles where the tip should ride in the final
   * leg instead of a standalone tipping transaction (Jito recommends
   * integrating tips into the main transaction — standalone tip txs are
   * exposed to uncle-bandit scenarios).
   */
  jitoTipLamports?: bigint;
}

export class TransactionSender {
  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly jito: JitoBundleClient,
    private readonly safety: SafetyConfig,
    private readonly feeMonitor?: PriorityFeeMonitor,
  ) {}

  /** Resolves the effective mode for a call. */
  effectiveMode(opts?: SendOptions): 'simulate' | 'execute' {
    if (opts?.mode === 'simulate' || opts?.mode === 'execute') return opts.mode;
    return this.safety.simulationMode ? 'simulate' : 'execute';
  }

  /** Base priority fee config combining safety defaults and monitor data. */
  basePriorityFee(override?: PriorityFeeConfig): PriorityFeeConfig {
    const base = { ...this.safety.priorityFee, ...override };
    if (base.dynamic && this.feeMonitor) {
      const live = this.feeMonitor.currentMicroLamports();
      const cap = base.maxMicroLamportsPerCu ?? 10_000_000;
      base.microLamportsPerCu = Math.min(live, cap);
    }
    return base;
  }

  /**
   * Pre-flight simulation of an unsigned message. Returns consumed units so
   * the caller can size the compute budget precisely.
   */
  async simulate(
    instructions: TransactionInstruction[],
    feePayer: string,
    signers: Signer[],
    blockhash: BlockhashWithExpiryBlockHeight,
    lookupTables?: AddressLookupTableAccount[],
  ): Promise<SimulationReport> {
    const message = new TransactionMessage({
      payerKey: typeof feePayer === 'string' ? new PublicKey(feePayer) : feePayer,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign(signers);
    try {
      const sim = await this.rpc.connection.simulateTransaction(tx, {
        // sigVerify is incompatible with replaceRecentBlockhash; the tx is
        // already signed locally so signature checks add nothing here.
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      const consumed = sim.value.unitsConsumed ?? 0;
      return {
        ok: sim.value.err === null,
        logs: sim.value.logs ?? [],
        consumedUnits: consumed,
        error: sim.value.err ? JSON.stringify(sim.value.err) : sim.value.logs?.find((l) => l.includes('failed') || l.includes('Error')),
      };
    } catch (err) {
      return { ok: false, logs: [], consumedUnits: 0, error: String(err) };
    }
  }

  /**
   * Full pipeline for a single transaction: simulate → build → sign → send.
   */
  async send(req: TransactionRequest, opts: SendOptions = {}): Promise<SendOutcome> {
    const started = Date.now();
    const warnings: string[] = [];
    const mode = this.effectiveMode(opts);
    const priorityFee = this.basePriorityFee(req.priorityFee ?? opts.priorityFee);
    const jitoTip = opts.jito
      ? BigInt(this.jito.config.tipLamports)
      : opts.priorityFee?.jitoTipLamports
        ? BigInt(opts.priorityFee.jitoTipLamports!)
        : 0n;

    // 1. Simulate (pre-flight), estimating CU usage with budget instructions applied.
    const blockhash = await this.rpc.latestBlockhash();
    const budget = priorityFee.computeUnitLimit;
    const probe = [...(budget ? [ComputeBudgetProgram.setComputeUnitLimit({ units: budget })] : []), ...req.instructions];
    let simulatedCu: number | undefined;
    if (!opts.skipSimulation) {
      const report = await this.simulate(probe, req.feePayer, req.signers, blockhash, req.lookupTables);
      if (!report.ok) {
        log.error(
          { description: req.description, error: report.error, logs: report.logs.slice(-5) },
          'pre-flight simulation FAILED — transaction not sent',
        );
        return {
          signature: '',
          signatures: [],
          simulated: mode === 'simulate',
          simulationLogs: report.logs,
          consumedUnits: report.consumedUnits,
          elapsedMs: Date.now() - started,
          warnings: [...warnings, `simulation failed: ${report.error ?? 'unknown'}`],
        };
      }
      simulatedCu = report.consumedUnits;
      if (this.safety.maxComputeUnits && simulatedCu > this.safety.maxComputeUnits) {
        warnings.push(`consumed CU ${simulatedCu} exceeds configured max; aborting`);
        return {
          signature: '',
          signatures: [],
          simulated: mode === 'simulate',
          simulationLogs: report.logs,
          consumedUnits: simulatedCu,
          elapsedMs: Date.now() - started,
          warnings,
        };
      }
      log.info({ description: req.description, consumedUnits: simulatedCu }, 'pre-flight simulation ok');
      if (mode === 'simulate') {
        return {
          signature: '(simulated)',
          signatures: [],
          simulated: true,
          simulationLogs: report.logs,
          consumedUnits: simulatedCu,
          elapsedMs: Date.now() - started,
          warnings,
        };
      }
    } else if (mode === 'execute') {
      warnings.push('pre-flight simulation SKIPPED by caller request');
    }

    // 2. Build + sign with the final compute budget sized from simulation.
    const buildParams: BuildTransactionParams = {
      description: req.description,
      feePayer: req.feePayer,
      instructions: req.instructions,
      priorityFee,
      jitoTipLamports: jitoTip,
      signers: req.signers,
      blockhash,
      simulatedCu,
      lookupTables: req.lookupTables,
    };
    const signed = buildSignedTransaction(buildParams);

    // 3. Dispatch with retry on fresh blockhash.
    const maxRetries = opts.maxRetries ?? 2;
    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (opts.jito && !this.jito.config.relaySingleTxs) {
          throw new Error('jito relay disabled');
        }
        if (opts.jito) {
          const accepted = await this.jito.sendTransaction(signed.base64);
          log.info({ description: req.description, accepted: accepted.slice(0, 120) }, 'sent via Jito tx relay');
          return {
            signature: signed.signature,
            signatures: [signed.signature],
            simulated: false,
            elapsedMs: Date.now() - started,
            warnings,
          };
        }
        const signature = await this.rpc.sendRawTransaction(signed.base64, { maxRetries: 0 });
        log.info({ description: req.description, signature }, 'transaction sent');
        return {
          signature,
          signatures: [signature],
          simulated: false,
          elapsedMs: Date.now() - started,
          warnings,
        };
      } catch (err) {
        lastError = String(err);
        log.warn({ attempt, err: lastError, description: req.description }, 'send attempt failed');
        if (attempt < maxRetries) {
          const fresh = await this.rpc.latestBlockhash();
          buildParams.blockhash = fresh;
          const resigned = buildSignedTransaction(buildParams);
          Object.assign(signed, resigned);
        }
      }
    }
    throw new Error(`transaction send failed after ${maxRetries + 1} attempts: ${lastError}`);
  }

  /**
   * Sends an atomic bundle of transactions through Jito. The caller is
   * expected to have appended tip instructions; the sender enforces the
   * presence of at least one tip transfer when `requireTip` (default true).
   */
  async sendBundle(
    reqs: TransactionRequest[],
    opts: SendOptions = {},
    requireTip = true,
  ): Promise<SendOutcome> {
    const started = Date.now();
    const warnings: string[] = [];
    const mode = this.effectiveMode(opts);
    const blockhash = await this.rpc.latestBlockhash();

    // Build all transactions sharing one blockhash so they land atomically.
    // Tip handling (Jito guidance): integrate the tip instruction into the
    // final leg's transaction when possible. A standalone tip transaction is
    // only appended when the last request carries its own inline tip already
    // (so the bundle has at least one tip either way).
    const tipLamports = BigInt(
      (opts.priorityFee?.jitoTipLamports ?? this.jito.config.tipLamports),
    );
    if (tipLamports < JITO_MIN_TIP_LAMPORTS) {
      warnings.push(
        `tip ${tipLamports} lamports is below Jito's enforced minimum of ${JITO_MIN_TIP_LAMPORTS}; the bundle will likely be dropped`,
      );
      log.warn({ tipLamports }, 'bundle tip below Jito minimum');
    }

    const lastHasInlineTip = (reqs[reqs.length - 1]?.jitoTipLamports ?? 0n) > 0n;
    const anyInlineTip = reqs.some((r) => (r.jitoTipLamports ?? 0n) > 0n);
    const appendStandaloneTip = requireTip && !anyInlineTip;

    const signedTxs: string[] = [];
    const signatures: string[] = [];
    for (const [i, req] of reqs.entries()) {
      const priorityFee = this.basePriorityFee(req.priorityFee ?? opts.priorityFee);
      // Attach the inline tip to the final leg unless it already has one.
      const inlineTip =
        req.jitoTipLamports ??
        (requireTip && !appendStandaloneTip && i === reqs.length - 1 ? tipLamports : 0n);
      const signed = buildSignedTransaction({
        description: req.description,
        feePayer: req.feePayer,
        instructions: req.instructions,
        priorityFee,
        jitoTipLamports: inlineTip,
        signers: req.signers,
        blockhash,
        lookupTables: req.lookupTables,
      });
      signedTxs.push(signed.base64);
      signatures.push(signed.signature);
    }

    // Fallback: standalone tip transaction at the end of the bundle.
    if (appendStandaloneTip) {
      const tipReq = reqs[reqs.length - 1]!;
      const tipTx = buildSignedTransaction({
        description: 'jito-tip',
        feePayer: tipReq.feePayer,
        instructions: [],
        priorityFee: { computeUnitLimit: 1_500 },
        jitoTipLamports: tipLamports,
        signers: tipReq.signers,
        blockhash,
      });
      signedTxs.push(tipTx.base64);
      signatures.push(tipTx.signature);
    }
    void lastHasInlineTip;

    // Jito hard limit: max 5 transactions per bundle.
    if (signedTxs.length > JITO_BUNDLE_MAX_TXS) {
      throw new Error(
        `bundle has ${signedTxs.length} transactions; Jito bundles allow at most ${JITO_BUNDLE_MAX_TXS}`,
      );
    }

    // Simulate each tx pre-flight (non-atomic view; Jito enforces atomicity).
    if (!opts.skipSimulation) {
      for (let i = 0; i < reqs.length; i++) {
        const report = await this.simulate(
          reqs[i]!.instructions,
          reqs[i]!.feePayer,
          reqs[i]!.signers,
          blockhash,
          reqs[i]!.lookupTables,
        );
        if (!report.ok) {
          log.error({ index: i, error: report.error, description: reqs[i]!.description }, 'bundle pre-flight simulation failed');
          return {
            signature: signatures[i] ?? '',
            signatures,
            simulated: mode === 'simulate',
            simulationLogs: report.logs,
            consumedUnits: report.consumedUnits,
            elapsedMs: Date.now() - started,
            warnings: [...warnings, `bundle member ${i} simulation failed: ${report.error ?? ''}`],
          };
        }
      }
      if (mode === 'simulate') {
        return {
          signature: signatures[0] ?? '(simulated)',
          signatures,
          simulated: true,
          elapsedMs: Date.now() - started,
          warnings,
        };
      }
    } else if (mode === 'execute') {
      warnings.push('bundle pre-flight simulation SKIPPED');
    }

    const bundleId = await this.jito.sendBundle(signedTxs);
    const status = await this.jito.waitForBundle(bundleId);
    log.info({ bundleId, status: status.status, slot: status.slot }, 'bundle finalized');
    return {
      signature: signatures[0] ?? '',
      signatures,
      simulated: false,
      bundleId,
      bundleStatus: status.status,
      elapsedMs: Date.now() - started,
      warnings,
    };
  }
}
