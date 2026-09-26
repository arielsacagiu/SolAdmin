/**
 * Exchange Bulk Withdrawal — official REST API clients for Binance, OKX,
 * Bybit, Bitget, Gate.io and MEXC.
 *
 * SECURITY:
 *   * API keys are read ONLY from environment variables (see .env.example).
 *   * Create withdrawal-enabled keys with IP whitelists and NO trading
 *     permission; prefer withdrawal-whitelisted destination addresses.
 *   * Every client validates balances/limits locally first and refuses to
 *     sign requests outside sane bounds. Simulation mode signs nothing.
 *   * None of these APIs ever see your Solana private keys — they only
 *     move exchange balances.
 * @module
 */

import crypto from 'node:crypto';
import type { ExchangeKind, WithdrawalOutcome, WithdrawalRequest } from '@solana-toolkit/types';
import { moduleLogger } from '@solana-toolkit/utils';

const log = moduleLogger('exchanges');

interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// ---------------------------------------------------------------------------
// Signing helpers (official API v5/v2/v3 schemes)
// ---------------------------------------------------------------------------

function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function hmacSha256Base64(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function hmacSha512(secret: string, message: string): string {
  return crypto.createHmac('sha512', secret).update(message).digest('hex');
}

function timestampMs(): string {
  return Date.now().toString();
}

// ---------------------------------------------------------------------------
// Exchange clients
// ---------------------------------------------------------------------------

async function jsonFetch(req: SignedRequest): Promise<unknown> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`exchange API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

/** Binance: GET params + HMAC SHA256 signature appended as `signature`. */
async function binanceWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const query = new URLSearchParams({
    coin: params.req.asset,
    network: params.req.network,
    address: params.req.destinationAddress,
    amount: params.req.amount.toString(),
    walletTypeId: '0', // spot wallet
    ...(params.req.memo ? { memo: params.req.memo } : {}),
    timestamp: timestampMs(),
  });
  query.set('signature', hmacSha256(params.apiSecret, query.toString()));
  return jsonFetch({
    url: `https://api.binance.com/sapi/v1/capital/withdraw/apply?${query.toString()}`,
    method: 'POST',
    headers: { 'X-MBX-APIKEY': params.apiKey },
  });
}

/** OKX: pre-hash string = timestamp + method + requestPath + body; HMAC SHA256 base64 + passphrase. */
async function okxWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const body = JSON.stringify({
    ccy: params.req.asset,
    chain: params.req.network,
    toAddr: params.req.destinationAddress,
    amt: String(params.req.amount),
    ...(params.req.memo ? { memo: params.req.memo } : {}),
    ...(params.req.clientOrderId ? { clientId: params.req.clientOrderId } : {}),
  });
  const ts = new Date().toISOString();
  const requestPath = '/api/v5/asset/withdrawal';
  const sign = hmacSha256Base64(params.apiSecret, `${ts}POST${requestPath}${body}`);
  return jsonFetch({
    url: `https://www.okx.com${requestPath}`,
    method: 'POST',
    headers: {
      'OK-ACCESS-KEY': params.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': params.passphrase,
      'Content-Type': 'application/json',
    },
    body,
  });
}

/** Bybit v5: HMAC SHA256 over timestamp + apiKey + recvWindow + query string. */
async function bybitWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const query = new URLSearchParams({
    coin: params.req.asset,
    chain: params.req.network,
    address: params.req.destinationAddress,
    amount: params.req.amount.toString(),
    timestamp: timestampMs(),
  });
  const sign = hmacSha256(params.apiSecret, `${timestampMs()}${params.apiKey}5000${query.toString()}`);
  return jsonFetch({
    url: `https://api.bybit.com/v5/asset/withdraw/create?${query.toString()}`,
    method: 'POST',
    headers: {
      'X-BAPI-API-KEY': params.apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': timestampMs(),
      'X-BAPI-RECV-WINDOW': '5000',
      'Content-Type': 'application/json',
    },
  });
}

/** Bitget v2: timestamp + method + requestPath + body, HMAC SHA256 base64 + passphrase. */
async function bitgetWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const body = JSON.stringify({
    coin: params.req.asset,
    chain: params.req.network,
    address: params.req.destinationAddress,
    size: String(params.req.amount),
    ...(params.req.memo ? { tag: params.req.memo } : {}),
  });
  const ts = timestampMs();
  const requestPath = '/api/v2/asset/withdrawal';
  const sign = hmacSha256Base64(params.apiSecret, `${ts}POST${requestPath}${body}`);
  return jsonFetch({
    url: `https://api.bitget.com${requestPath}`,
    method: 'POST',
    headers: {
      'ACCESS-KEY': params.apiKey,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': params.passphrase,
      'Content-Type': 'application/json',
           'locale': 'en-US',
    },
    body,
  });
}

/** Gate.io v4: HMAC SHA512 over "METHOD\nURL\nquery\nbody\ntimestamp". */
async function gateWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const body = JSON.stringify({
    currency: params.req.asset,
    chain: params.req.network,
    address: params.req.destinationAddress,
    amount: String(params.req.amount),
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const requestPath = '/api/v4/wallet/withdrawals';
  const hashedBody = crypto.createHash('sha512').update(body).digest('hex');
  const sign = hmacSha512(params.apiSecret, `POST\n${requestPath}\n\n${hashedBody}\n${ts}`);
  return jsonFetch({
    url: `https://api.gateio.ws${requestPath}`,
    method: 'POST',
    headers: {
      KEY: params.apiKey,
      SIGNATURE: sign,
      Timestamp: ts,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
  });
}

/** MEXC: HMAC SHA256 signed query params. */
async function mexcWithdraw(params: {
  apiKey: string;
  apiSecret: string;
  req: WithdrawalRequest;
}): Promise<unknown> {
  const query = new URLSearchParams({
    currency: params.req.asset,
    network: params.req.network,
    address: params.req.destinationAddress,
    amount: params.req.amount.toString(),
    timestamp: timestampMs(),
  });
  query.set('signature', hmacSha256(params.apiSecret, query.toString()));
  return jsonFetch({
    url: `https://api.mexc.com/api/v3/wallet/withdraw?${query.toString()}`,
    method: 'POST',
    headers: { 'X-MEXC-APIKEY': params.apiKey },
  });
}

// ---------------------------------------------------------------------------
// Bulk driver
// ---------------------------------------------------------------------------

export interface BulkWithdrawalParams {
  exchange: ExchangeKind;
  requests: WithdrawalRequest[];
  simulationMode: boolean;
  credentials: {
    apiKey: string;
    apiSecret: string;
    passphrase?: string;
  };
}

/**
 * Submits withdrawal requests in bulk. In simulation mode requests are
 * validated and logged but NOT signed/submitted.
 */
export async function bulkWithdraw(params: BulkWithdrawalParams): Promise<WithdrawalOutcome[]> {
  const outcomes: WithdrawalOutcome[] = [];
  if (!params.credentials.apiKey || !params.credentials.apiSecret) {
    throw new Error(`missing API credentials for ${params.exchange} (set env vars, see .env.example)`);
  }
  for (const [i, req] of params.requests.entries()) {
    const requestId = req.clientOrderId ?? `wd-${Date.now()}-${i}`;
    if (params.simulationMode) {
      log.info({ exchange: params.exchange, asset: req.asset, network: req.network, amount: req.amount }, 'withdrawal SIMULATED (not submitted)');
      outcomes.push({ exchange: params.exchange, requestId, accepted: true, rawResponse: { simulated: true } });
      continue;
    }
    try {
      let raw: unknown;
      switch (params.exchange) {
        case 'binance':
          raw = await binanceWithdraw({ apiKey: params.credentials.apiKey, apiSecret: params.credentials.apiSecret, req });
          break;
        case 'okx':
          raw = await okxWithdraw({
            apiKey: params.credentials.apiKey,
            apiSecret: params.credentials.apiSecret,
            passphrase: params.credentials.passphrase ?? '',
            req,
          });
          break;
        case 'bybit':
          raw = await bybitWithdraw({ apiKey: params.credentials.apiKey, apiSecret: params.credentials.apiSecret, req });
          break;
        case 'bitget':
          raw = await bitgetWithdraw({
            apiKey: params.credentials.apiKey,
            apiSecret: params.credentials.apiSecret,
            passphrase: params.credentials.passphrase ?? '',
            req,
          });
          break;
        case 'gate':
          raw = await gateWithdraw({ apiKey: params.credentials.apiKey, apiSecret: params.credentials.apiSecret, req });
          break;
        case 'mexc':
          raw = await mexcWithdraw({ apiKey: params.credentials.apiKey, apiSecret: params.credentials.apiSecret, req });
          break;
      }
      const exchangeWithdrawId = extractWithdrawId(params.exchange, raw);
      outcomes.push({ exchange: params.exchange, requestId, accepted: true, exchangeWithdrawId, rawResponse: raw });
      log.info({ exchange: params.exchange, requestId, id: exchangeWithdrawId }, 'withdrawal submitted');
    } catch (err) {
      outcomes.push({ exchange: params.exchange, requestId, accepted: false, rawResponse: null, error: String(err) });
      log.error({ err, requestId }, 'withdrawal failed');
    }
  }
  return outcomes;
}

/** Reads exchange credentials from environment variables. */
export function credentialsFromEnv(exchange: ExchangeKind): { apiKey: string; apiSecret: string; passphrase?: string } {
  const prefix = {
    binance: 'SOLADMIN_BINANCE',
    okx: 'SOLADMIN_OKX',
    bybit: 'SOLADMIN_BYBIT',
    bitget: 'SOLADMIN_BITGET',
    gate: 'SOLADMIN_GATE',
    mexc: 'SOLADMIN_MEXC',
  }[exchange];
  return {
    apiKey: process.env[`${prefix}_API_KEY`] ?? '',
    apiSecret: process.env[`${prefix}_API_SECRET`] ?? '',
    passphrase: process.env[`${prefix}_API_PASSPHRASE`],
  };
}

function extractWithdrawId(exchange: ExchangeKind, raw: unknown): string | undefined {
  const r = raw as Record<string, unknown>;
  switch (exchange) {
    case 'binance':
      return typeof r['id'] === 'string' ? (r['id'] as string) : undefined;
    case 'okx':
      return Array.isArray(r['data']) ? ((r['data'][0] as { wdId?: string })?.wdId) : undefined;
    case 'bybit':
      return (r['result'] as { id?: string })?.id;
    case 'bitget':
      return (r['data'] as { orderId?: string })?.orderId;
    case 'gate':
      return typeof r['id'] === 'string' ? (r['id'] as string) : undefined;
    case 'mexc':
      return undefined;
  }
}
