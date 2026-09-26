import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  DEVNET_PROGRAMS,
  MOONIT_DEX_FEE,
  MOONIT_HELIO_FEE,
  PROGRAMS,
  PUMPFUN_FEE_RECIPIENTS,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
  RAYDIUM_API_DEVNET,
  RAYDIUM_API_MAINNET,
  RAYDIUM_V5_MODEL_DATA,
  RENT_SYSVAR,
  SYSVAR_RENT,
  WSOL_MINT,
  OPENBOOK_V1_PROGRAM_ID,
  OPENBOOK_V2_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  MOONIT_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from '../src/index.js';
import {
  JITO_TIP_ACCOUNTS_FALLBACK as RPC_TIPS,
  JITO_REGIONS,
} from '@solana-toolkit/rpc-client';

describe('program addresses', () => {
  const allPrograms: Record<string, string> = {
    ...Object.fromEntries(Object.entries(PROGRAMS).map(([k, v]) => [k, v as string])),
    ...Object.fromEntries(Object.entries(DEVNET_PROGRAMS).map(([k, v]) => [`devnet.${k}`, v as string])),
    RENT_SYSVAR,
    WSOL_MINT,
    PUMPSWAP_GLOBAL_CONFIG,
    MOONIT_HELIO_FEE,
    MOONIT_DEX_FEE,
    RAYDIUM_V5_MODEL_DATA,
    ...Object.fromEntries(PUMPFUN_FEE_RECIPIENTS.map((r, i) => [`fee.${i}`, r])),
    ...Object.fromEntries(RPC_TIPS.map((r, i) => [`jito.${i}`, r])),
  };

  it('every constant is a valid, unique public key', () => {
    const seen = new Set<string>();
    for (const [name, addr] of Object.entries(allPrograms)) {
      expect(() => new PublicKey(addr), `invalid pubkey for ${name}: ${addr}`).not.toThrow();
      expect(seen.has(addr), `duplicate address for ${name}: ${addr}`).toBe(false);
      seen.add(addr);
    }
  });

  it('verified program IDs match the official values', () => {
    expect(PROGRAMS.PUMPFUN).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(PROGRAMS.PUMPSWAP).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    expect(PROGRAMS.PUMPFUN_FEES).toBe('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
    expect(PROGRAMS.MOONIT).toBe('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');
    expect(PROGRAMS.RAYDIUM_AMM_V4).toBe('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    expect(PROGRAMS.RAYDIUM_CPMM).toBe('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
    expect(PROGRAMS.RAYDIUM_CLMM).toBe('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
    expect(PROGRAMS.OPENBOOK_V1).toBe('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX');
    expect(PROGRAMS.OPENBOOK_V2).toBe('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');
    expect(PROGRAMS.METAPLEX_TOKEN_METADATA).toBe('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    // Token program IDs come from the official @solana/spl-token package.
    expect(PROGRAMS.TOKEN).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(PROGRAMS.TOKEN_2022).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  });

  it('exposes the jito regions and tip accounts', () => {
    expect(JITO_REGIONS).toContain('mainnet');
    expect(JITO_REGIONS).toContain('tokyo');
    expect(RPC_TIPS).toHaveLength(8);
    expect(SYSVAR_RENT).toBe(RENT_SYSVAR);
    expect(RAYDIUM_API_MAINNET).toContain('raydium.io');
    expect(RAYDIUM_API_DEVNET).toContain('devnet');
  });
});
