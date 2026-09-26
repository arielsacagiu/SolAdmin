import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { planStealthTransfer } from '../src/stealth.js';
import { generateTokenWebsite } from '../src/website-generator.js';

describe('stealth transfer planner', () => {
  it('splits the total across relay legs without losing lamports', () => {
    const source = Keypair.generate();
    const relays = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const plan = planStealthTransfer({
      source,
      destination: Keypair.generate().publicKey.toBase58(),
      totalLamports: 1_000_000_000n,
      relays,
    });
    expect(plan.legs).toHaveLength(3);
    const total = plan.legs.reduce((a, l) => a + l.lamports, 0n);
    expect(total).toBe(1_000_000_000n);
    for (const leg of plan.legs) {
      expect(leg.lamports).toBeGreaterThan(0n);
    }
  });

  it('requires at least one relay', () => {
    const source = Keypair.generate();
    expect(() =>
      planStealthTransfer({
        source,
        destination: '11111111111111111111111111111111',
        totalLamports: 100n,
        relays: [],
      }),
    ).toThrow(/relay/);
  });
});

describe('static website generator', () => {
  it('generates escaping-safe HTML with audit data', () => {
    const { indexHtml, metadataJson } = generateTokenWebsite({
      outDir: './output-test-website',
      audit: {
        mint: Keypair.generate().publicKey.toBase58(),
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9SsP231HmDLv',
        decimals: 9,
        supplyRaw: '1000000000',
        mintAuthority: null,
        freezeAuthority: null,
        metadata: { name: '<script>x</script>', symbol: 'TST', uri: 'https://example.com/m.json' },
        liquidity: [],
        findings: ['Mint authority revoked — supply is fixed.'],
      },
    });
    expect(indexHtml).toContain('&lt;script&gt;');
    expect(indexHtml).not.toContain('<script>x</script>');
    expect(indexHtml).toContain('$TST');
    expect(JSON.parse(metadataJson)).toMatchObject({ symbol: 'TST' });
  });
});

describe('pubkey validity helper', () => {
  it('detects valid and invalid pubkeys', async () => {
    const { isValidPubkey } = await import('../src/chain-tools.js');
    expect(isValidPubkey(Keypair.generate().publicKey.toBase58())).toBe(true);
    expect(isValidPubkey('not-a-pubkey')).toBe(false);
    expect(isValidPubkey(new PublicKey('11111111111111111111111111111111').toBase58())).toBe(true);
  });
});
