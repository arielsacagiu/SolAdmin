/**
 * Social Promotion CLI commands — configure webhook-based promotion
 * channels and fire coordinated announcements at lifecycle stages.
 *
 * Channels are webhook relays (e.g. Telegram/Discord/Twitter bot bridges):
 * provide --webhook-url to dispatch for real; omit it to run the channel
 * log-only (dry-run).
 * @module
 */

import { Command } from 'commander';
import { printResult, type GlobalOptions } from '../shared.js';
import {
  SocialPromotionManager,
  type SocialPromotionConfig,
  type PromotionTrigger,
  type PromotionContext,
} from '@solana-toolkit/services';

const TRIGGERS: PromotionTrigger[] = [
  'pre-launch',
  'launch-announcement',
  'holder-milestone',
  'volume-milestone',
  'trending-push',
  'pre-exit',
  'exit-notice',
  'consolidated',
];

export function registerSocialCommand(program: Command): void {
  const socialCmd = program
    .command('social')
    .description('Webhook-based social promotion utilities');

  // Trigger a promotion across configured channels.
  socialCmd
    .command('trigger')
    .description('Fire a promotion trigger to the configured channels')
    .requiredOption('--type <trigger>', `promotion trigger: ${TRIGGERS.join(' | ')}`)
    .requiredOption('--token-symbol <symbol>', 'token symbol')
    .requiredOption('--token-name <name>', 'token name')
    .requiredOption('--mint <address>', 'token mint address')
    .option('--platform <name>', 'channel/platform label (default: "default")')
    .option('--webhook-url <url>', 'webhook relay URL; omit for a log-only (dry-run) channel')
    .option('--header <header>', 'extra header as "Key: Value" (repeatable)', collectHeader, {})
    .option('--template <template>', 'message template with {{tokenSymbol}}/{{tokenName}}/{{mint}} placeholders')
    .option('--holders <count>', 'holder count metric', (v) => parseInt(v, 10))
    .option('--volume <volume>', 'volume metric (SOL)', (v) => parseFloat(v))
    .action(async (opts: GlobalOptions & {
      type: string;
      tokenSymbol: string;
      tokenName: string;
      mint: string;
      platform?: string;
      webhookUrl?: string;
      header?: Record<string, string>;
      template?: string;
      holders?: number;
      volume?: number;
    }) => {
      const channel: SocialPromotionConfig = {
        platform: opts.platform ?? 'default',
        webhookUrl: opts.webhookUrl,
        headers: opts.header && Object.keys(opts.header).length > 0 ? opts.header : undefined,
        messageTemplate: opts.template,
        enabled: true,
      };
      const manager = new SocialPromotionManager([channel], {
        tokenSymbol: opts.tokenSymbol,
        tokenName: opts.tokenName,
      });

      const context: PromotionContext = {
        tokenSymbol: opts.tokenSymbol,
        tokenName: opts.tokenName,
        mint: opts.mint,
        stage: opts.type,
        holdersCount: opts.holders,
        volume: opts.volume,
      };

      const results = await manager.triggerPromotion(opts.type, context);

      printResult(opts, {
        trigger: opts.type,
        channels: results.map(r => ({
          platform: r.platform,
          success: r.success,
          simulated: r.simulated ?? false,
          error: r.error,
        })),
        audit: manager.audit(),
      });
    });

  // List available triggers.
  socialCmd
    .command('list-triggers')
    .description('List all available promotion triggers')
    .action(async (opts: GlobalOptions) => {
      printResult(opts, { triggers: TRIGGERS });
    });

  // Preview the rendered message without dispatching anything.
  socialCmd
    .command('preview')
    .description('Preview the rendered promotion message (log-only, nothing is sent)')
    .requiredOption('--type <trigger>', `promotion trigger: ${TRIGGERS.join(' | ')}`)
    .requiredOption('--token-symbol <symbol>', 'token symbol')
    .requiredOption('--token-name <name>', 'token name')
    .requiredOption('--mint <address>', 'token mint address')
    .option('--template <template>', 'message template with {{tokenSymbol}}/{{tokenName}}/{{mint}} placeholders')
    .action(async (opts: GlobalOptions & {
      type: string;
      tokenSymbol: string;
      tokenName: string;
      mint: string;
      template?: string;
    }) => {
      const manager = new SocialPromotionManager(
        [{ platform: 'preview', messageTemplate: opts.template, enabled: true }],
        { tokenSymbol: opts.tokenSymbol, tokenName: opts.tokenName },
      );
      const results = await manager.triggerPromotion(opts.type, {
        tokenSymbol: opts.tokenSymbol,
        tokenName: opts.tokenName,
        mint: opts.mint,
        stage: opts.type,
      });
      printResult(opts, {
        trigger: opts.type,
        // Log-only channels return success with simulated=true; the rendered
        // message is visible in the logger output.
        results: results.map(r => ({ platform: r.platform, success: r.success, simulated: r.simulated })),
      });
    });
}

/** Collects repeatable --header "Key: Value" options into a record. */
function collectHeader(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf(':');
  if (idx <= 0) {
    throw new Error(`invalid --header "${value}" — expected "Key: Value"`);
  }
  return { ...previous, [value.slice(0, idx).trim()]: value.slice(idx + 1).trim() };
}
