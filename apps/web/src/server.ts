/**
 * SolAdmin web UI — a lightweight, read-mostly Express server exposing the
 * toolkit over HTTP. It reuses the same service layer as the CLI.
 *
 * SECURITY MODEL:
 *   * The server binds 127.0.0.1 by default. Do NOT expose it to the public
 *     internet without an authenticating reverse proxy.
 *   * Key operations accept keystore PATHS (read on the server's local disk),
 *     never uploaded secrets.
 *   * Mutation endpoints refuse to run unless the server was started with
 *     SOLADMIN_SIMULATION_MODE=false — read-only endpoints are always safe.
 * @module
 */

import express, { type Request, type Response } from 'express';
import { loadEnvFile, loadToolkitConfig } from '@solana-toolkit/utils';
import { createServiceContext } from '@solana-toolkit/services';
import { auditToken } from '@solana-toolkit/services';
import { checkBalances } from '@solana-toolkit/wallet-manager';
import { readKeystorePublicKey, loadBatchWallets } from '@solana-toolkit/wallet-manager';
import { generateWebsiteForMint } from '@solana-toolkit/services';
import { probeRpcEndpoint } from '@solana-toolkit/services';
import { createDexContext, executeSwap } from '@solana-toolkit/dex';
import { Keypair } from '@solana/web3.js';
import { loadKeystoreInteractive } from '@solana-toolkit/wallet-manager';
import fs from 'node:fs';

const PORT = Number(process.env['SOLADMIN_WEB_PORT'] ?? 8787);
const HOST = process.env['SOLADMIN_WEB_HOST'] ?? '127.0.0.1';

loadEnvFile();
const config = loadToolkitConfig(process.env['SOLADMIN_CONFIG_FILE']);
const services = createServiceContext(config);
const dex = createDexContext(config);
const app = express();
app.use(express.json({ limit: '1mb' }));

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}

// ------------------------------------------------------------- read-only API

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, cluster: config.rpc.cluster, simulationMode: config.safety.simulationMode });
});

app.get('/api/rpc', asyncHandler(async (_req, res) => {
  res.json(await probeRpcEndpoint(services));
}));

app.post('/api/audit', asyncHandler(async (req, res) => {
  const { mint } = req.body as { mint?: string };
  if (!mint) { res.status(400).json({ error: 'mint required' }); return; }
  res.json(await auditToken(services, mint));
}));

app.post('/api/balances', asyncHandler(async (req, res) => {
  const { wallets, tokens } = req.body as { wallets?: string; tokens?: string[] };
  if (!wallets) { res.status(400).json({ error: 'wallets (batch.json path) required' }); return; }
  const records = fs.existsSync(wallets) ? loadBatchWallets(wallets) : [];
  res.json(await checkBalances(services.rpc, records, tokens ?? []));
}));

app.post('/api/keystore-info', asyncHandler(async (req, res) => {
  const { keystore } = req.body as { keystore?: string };
  if (!keystore) { res.status(400).json({ error: 'keystore path required' }); return; }
  res.json({ keystore, publicKey: readKeystorePublicKey(keystore) });
}));

app.post('/api/website', asyncHandler(async (req, res) => {
  const { mint, outDir } = req.body as { mint?: string; outDir?: string };
  if (!mint) { res.status(400).json({ error: 'mint required' }); return; }
  const result = await generateWebsiteForMint(services, mint, outDir ?? './output/website');
  res.json({ outDir: result.outDir });
}));

app.post('/api/fee-sample', asyncHandler(async (_req, res) => {
  res.json(await services.feeMonitor.sample());
}));

// -------------------------------------------------------------- mutation API

function requireExecutionEnabled(_req: Request, res: Response): boolean {
  if (config.safety.simulationMode) {
    res.status(409).json({
      error: 'simulation mode is ON — mutations are simulated only. Start with SOLADMIN_SIMULATION_MODE=false to execute.',
    });
    return false;
  }
  return true;
}

app.post('/api/swap', asyncHandler(async (req, res) => {
  const body = req.body as {
    keystore?: string;
    venue?: string;
    from?: string;
    to?: string;
    amountRaw?: string;
    slippageBps?: number;
  };
  if (!body.keystore || !body.venue || !body.from || !body.to || !body.amountRaw) {
    res.status(400).json({ error: 'keystore, venue, from, to, amountRaw required' });
    return;
  }
  requireExecutionEnabled(req, res);
  if (res.writableEnded) return;
  const wallet: Keypair = await loadKeystoreInteractive(body.keystore);
  const result = await executeSwap(dex, {
    venue: body.venue as never,
    user: wallet,
    inputMint: body.from,
    outputMint: body.to,
    amountInRaw: BigInt(body.amountRaw),
    slippageBps: body.slippageBps ?? 100,
    mode: config.safety.simulationMode ? 'simulate' : 'execute',
  });
  res.json(result);
}));

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SolAdmin</title>
<style>body{font-family:system-ui;background:#0b0e14;color:#e6edf3;max-width:720px;margin:48px auto;padding:0 16px}
a{color:#14F195}code{background:#11151f;padding:2px 6px;border-radius:6px}</style></head><body>
<h1>SolAdmin Web</h1>
<p>Simulation mode: <b>${config.safety.simulationMode ? 'ON (default)' : 'OFF'}</b></p>
<h3>Endpoints</h3>
<ul>
<li><code>GET /api/health</code></li>
<li><code>GET /api/rpc</code> — endpoint probe</li>
<li><code>POST /api/audit { mint }</code></li>
<li><code>POST /api/balances { wallets, tokens }</code></li>
<li><code>POST /api/keystore-info { keystore }</code></li>
<li><code>POST /api/website { mint, outDir }</code></li>
<li><code>POST /api/fee-sample</code></li>
<li><code>POST /api/swap { keystore, venue, from, to, amountRaw, slippageBps }</code> (execute-only)</li>
</ul>
<p>Full functionality lives in the CLI: <code>soladmin --help</code>.</p>
<footer>Local-first toolkit — this server binds ${HOST} only.</footer></body></html>`);
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`SolAdmin web UI listening on http://${HOST}:${PORT} (simulation mode: ${config.safety.simulationMode ? 'ON' : 'OFF'})`);
});
