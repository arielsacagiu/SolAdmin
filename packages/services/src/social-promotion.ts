/**
 * Social Promotion — off-chain promotion manager for token launches.
 *
 * This module is deliberately separated from on-chain lifecycle logic: it
 * never signs a transaction. It maps lifecycle triggers (launch
 * announcement, ramp milestones, exit notices) to a set of configured
 * promotion channels — webhook relays feeding Telegram/Discord/Twitter-bot
 * endpoints — so the outer LifecycleController can fire coordinated
 * marketing moments at the right stage transitions.
 *
 * DESIGN:
 *   - `SocialPromotionManager` is a class: per-launch state (dedupe
 *     windows, fired-hook audit) lives on the instance and never leaks
 *     into the next launch.
 *   - Each `SocialPromotionConfig` describes one channel: platform name,
 *     webhook URL, auth headers, subscribed triggers, and an optional
 *     message template with {{tokenSymbol}}/{{mint}} placeholders.
 *   - `triggerPromotion(trigger, data)` renders the message, de-duplicates
 *     per (channel, trigger) within `dedupeMs`, and dispatches each
 *     subscribed channel with retry + exponential backoff.
 *   - Channels without a webhook URL are log-only — useful for dry-run
 *     and for wiring new channels before their relay is live.
 *
 * COMPLIANCE: promotion actions are the operator's responsibility.
 * Coordinated inauthentic behavior (bot farms, astroturfing) violates
 * platform ToS and may violate law; use for disclosed community marketing
 * only.
 * @module
 */

import { moduleLogger, retry } from '@solana-toolkit/utils';

const log = moduleLogger('social-promotion');

/** Lifecycle trigger names a channel can subscribe to. */
export type PromotionTrigger =
  | 'pre-launch'
  | 'launch-announcement'
  | 'holder-milestone'
  | 'volume-milestone'
  | 'trending-push'
  | 'pre-exit'
  | 'exit-notice'
  | 'consolidated';

/** One promotion channel configuration. */
export interface SocialPromotionConfig {
  /** Platform identifier — returned in results, used in logs. */
  platform: string;
  /** Webhook/relay URL; absent = log-only channel (no dispatch). */
  webhookUrl?: string;
  /** Static headers merged into the POST (auth tokens etc.). */
  headers?: Record<string, string>;
  /** Triggers this channel subscribes to (empty/undefined = all). */
  triggers?: PromotionTrigger[];
  /**
   * Message template with {{placeholders}} — tokenSymbol, tokenName,
   * mint, stage, holdersCount, volume. Falls back to a default string.
   */
  messageTemplate?: string;
  /** Enable/disable without removing the config. */
  enabled?: boolean;
  /** Per-channel dedupe window (ms); default 5 min. */
  dedupeMs?: number;
}

/** Data handed to triggerPromotion by the controller at each stage. */
export interface PromotionContext {
  tokenSymbol?: string;
  tokenName?: string;
  mint?: string;
  stage?: string;
  holdersCount?: number;
  volume?: number;
  /** Arbitrary extra metrics merged into the payload for embeds. */
  metrics?: Record<string, string | number>;
}

/** Result of one channel dispatch attempt. */
export interface PromotionResult {
  platform: string;
  success: boolean;
  simulated?: boolean;
  error?: string;
  /** Idempotency key: trigger + mint + minute bucket. */
  dedupeKey?: string;
}

/** Per-launch token context supplied at construction. */
export interface PromotionTokenContext {
  tokenSymbol?: string;
  tokenName?: string;
}

interface FiredRecord {
  platform: string;
  trigger: string;
  dedupeKey: string;
  firedAt: number;
  ok: boolean;
  error?: string;
}

/**
 * Renders a message template with the promotion context. Unknown
 * placeholders are left intact so partial configs still produce output.
 */
function renderTemplate(template: string, data: PromotionContext): string {
  return template
    .replace(/\{\{tokenSymbol\}\}/g, data.tokenSymbol ?? '')
    .replace(/\{\{tokenName\}\}/g, data.tokenName ?? '')
    .replace(/\{\{mint\}\}/g, data.mint ?? '')
    .replace(/\{\{stage\}\}/g, data.stage ?? '')
    .replace(/\{\{holdersCount\}\}/g, String(data.holdersCount ?? ''))
    .replace(/\{\{volume\}\}/g, String(data.volume ?? ''));
}

const DEFAULT_TEMPLATE = '🚀 {{tokenSymbol}} ({{tokenName}}) — {{stage}} — mint {{mint}}';

export class SocialPromotionManager {
  private readonly channels: SocialPromotionConfig[];
  private readonly tokenCtx: PromotionTokenContext;
  private readonly fired: FiredRecord[] = [];
  private readonly lastFiredAt = new Map<string, number>();

  constructor(config: SocialPromotionConfig[], tokenContext: PromotionTokenContext = {}) {
    this.channels = config.filter((c) => c.enabled !== false);
    this.tokenCtx = tokenContext;
  }

  /**
   * Fires all channels subscribed to `trigger`. Returns one
   * PromotionResult per attempted channel — failures are reported per
   * channel so the controller can log them without aborting the stage.
   */
  async triggerPromotion(trigger: PromotionTrigger | string, data: PromotionContext): Promise<PromotionResult[]> {
    const merged: PromotionContext = { ...this.tokenCtx, ...data };
    const dedupeKey = `${trigger}:${merged.mint ?? 'global'}:${Math.floor(Date.now() / 60_000)}`;
    const results: PromotionResult[] = [];

    for (const channel of this.channels) {
      if (!this.subscribes(channel, trigger)) continue;
      if (this.inCooldown(channel, trigger)) continue;
      const result = await this.dispatch(channel, trigger, merged, dedupeKey);
      results.push(result);
      this.fired.push({
        platform: channel.platform,
        trigger,
        dedupeKey,
        firedAt: Date.now(),
        ok: result.success,
        error: result.error,
      });
      if (result.success) this.lastFiredAt.set(`${channel.platform}:${trigger}`, Date.now());
    }
    return results;
  }

  /** Channel subscribes when its trigger list is empty or contains the name. */
  private subscribes(channel: SocialPromotionConfig, trigger: string): boolean {
    return !channel.triggers?.length || (channel.triggers as string[]).includes(trigger);
  }

  /**
   * Per-(channel, trigger) dedupe — prevents rapid stage loops from
   * spamming one channel with the same announcement.
   */
  private inCooldown(channel: SocialPromotionConfig, trigger: string): boolean {
    const window = channel.dedupeMs ?? 300_000;
    const last = this.lastFiredAt.get(`${channel.platform}:${trigger}`) ?? 0;
    return Date.now() - last < window;
  }

  /** Dispatches one hook to one channel with retry; log-only if no URL. */
  private async dispatch(
    channel: SocialPromotionConfig,
    trigger: string,
    data: PromotionContext,
    dedupeKey: string,
  ): Promise<PromotionResult> {
    const message = renderTemplate(channel.messageTemplate ?? DEFAULT_TEMPLATE, data);
    const payload = {
      trigger,
      message,
      token: { symbol: data.tokenSymbol, name: data.tokenName, mint: data.mint },
      stage: data.stage,
      metrics: { holdersCount: data.holdersCount, volume: data.volume, ...(data.metrics ?? {}) },
      dedupeKey,
      sentAt: new Date().toISOString(),
    };

    if (!channel.webhookUrl) {
      log.info({ platform: channel.platform, trigger, simulated: true }, 'promotion hook (log-only channel)');
      return { platform: channel.platform, success: true, simulated: true, dedupeKey };
    }

    try {
      await retry(
        async () => {
          const res = await fetch(channel.webhookUrl!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(channel.headers ?? {}) },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error(`promotion dispatch HTTP ${res.status}`);
        },
        { retries: 3, backoffMs: 500, label: `promotion ${channel.platform}` },
      );
      log.info({ platform: channel.platform, trigger }, 'promotion dispatched');
      return { platform: channel.platform, success: true, dedupeKey };
    } catch (err) {
      log.error({ platform: channel.platform, err }, 'promotion dispatch failed');
      return {
        platform: channel.platform,
        success: false,
        dedupeKey,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Full audit trail of hooks fired this session. */
  audit(): readonly FiredRecord[] {
    return this.fired;
  }
}
