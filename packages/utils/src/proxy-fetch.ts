/**
 * Optional HTTPS proxy for RPC and Jito HTTP.
 * Set SOLADMIN_HTTPS_PROXY (operator Tor bridge speaks HTTP CONNECT).
 * Uses Node's bundled undici. No extra dependency.
 * @module
 */
import { createRequire } from 'node:module';
import { moduleLogger } from './logger.js';

const log = moduleLogger('proxy-fetch');

let cached: typeof fetch | undefined;

export function proxiedFetch(): typeof fetch {
  if (cached) return cached;
  const proxy = process.env['SOLADMIN_HTTPS_PROXY'];
  if (!proxy) {
    cached = globalThis.fetch.bind(globalThis);
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    const undici = require('undici') as {
      ProxyAgent: new (url: string) => object;
      fetch: (input: unknown, init?: object) => Promise<Response>;
    };
    const dispatcher = new undici.ProxyAgent(proxy);
    cached = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      undici.fetch(input, { ...(init ?? {}), dispatcher })) as typeof fetch;
    log.info({ proxy }, 'HTTPS proxy enabled for outbound HTTP');
  } catch (err) {
    log.warn({ err }, 'SOLADMIN_HTTPS_PROXY set but undici ProxyAgent is unavailable — using direct fetch');
    cached = globalThis.fetch.bind(globalThis);
  }
  return cached;
}
