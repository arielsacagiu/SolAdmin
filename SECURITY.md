# Security Policy & Best Practices

## The five rules

1. **Simulation first, always.** `SOLADMIN_SIMULATION_MODE=true` is the
   default. Real sends additionally require `--execute`. Never disable the
   pre-flight simulation (`skipSimulation` exists only for sniping hot paths —
   know exactly what you are trading away when you use it).
2. **Keys live in encrypted keystores.** `soladmin wallet keystore-create`
   writes scrypt(16384/8/1) + AES-256-GCM envelopes with file mode 0600.
   Never store secret keys in `.env`, source code, shell history, or chat.
   `SOLADMIN_KEYSTORE_PASSWORD` exists for automation on machines you
   control — prefer interactive prompts anywhere else.
3. **Revoke what you don't need.** After launching a token, revoke mint,
   freeze, and metadata update authorities (`token authorities --revoke-all`).
   Holding them is a standing risk to your holders and to you.
4. **Least privilege everywhere.** Exchange API keys: withdrawal-only, IP
   whitelisted. RPC endpoints: dedicated keys. Web UI: bound to localhost
   behind an authenticating proxy if exposed at all.
5. **Verify before you trust.** `token audit` before buying unfamiliar mints:
   mint/freeze authority, transfer fee ("tax"), transfer-hook programs,
   bonding-curve state and LP status. The audit output is designed to be
   read before the trade, not after.

## Keystore format

```jsonc
{
  "format": "soladmin-keystore",
  "version": 1,
  "kdf": "scrypt",               // N=16384 r=8 p=1 dklen=32
  "kdfParams": { "salt": "…" },
  "cipher": "aes-256-gcm",       // authenticated encryption
  "cipherParams": { "iv": "…", "tag": "…" },
  "ciphertext": "…",             // encrypted 64-byte secret key
  "publicKey": "…",              // readable without the password
  "createdAt": "…"
}
```

Plain Solana CLI JSON arrays are accepted for migration (with a loud warning)
and devnet use only.

## Execution checklist (mainnet)

- [ ] Rehearsed the exact command on devnet / in simulation mode
- [ ] `soladmin chain probe-rpc` shows the endpoint features you rely on
- [ ] Amounts in **raw lamports/base units** double-checked (`--amount` values)
- [ ] Slippage and Jito tip sized for current conditions (`swap fee-monitor`)
- [ ] Buyer wallets funded only with what the operation needs
- [ ] Destination addresses verified (send 1% first for large transfers)
- [ ] Authority revocation planned immediately after launch
- [ ] `output/transaction-history.jsonl` retained for your records

## Exchange withdrawals

- Withdrawal-enabled API keys are the highest-value secret on any exchange.
  Use withdrawal-whitelisted destination addresses so even a leaked key
  cannot redirect funds to attacker-controlled wallets.
- The `exchange withdraw` command prints a double confirmation and stays in
  simulation mode unless both `--execute` and `SOLADMIN_SIMULATION_MODE=false`
  are set. Credentials are read from environment variables only.
- Supported officially: Binance, OKX, Bybit, Bitget, Gate.io, MEXC.

## Web UI

`apps/web` binds `127.0.0.1` by default. It is a local convenience surface —
if you expose it, put it behind an authenticating reverse proxy with TLS,
and keep in mind mutation endpoints execute transactions.

## What this toolkit cannot protect you from

- **Market risk.** Slippage, failed auctions, MEV competition, and failed
  bundles cost real money; tips are non-refundable.
- **Regulatory risk.** Volume/holder/transaction-boosting modules can
  constitute market manipulation. Use them only on assets you own, in
  sandboxes, or where explicitly lawful.
- **Privacy limits.** "Stealth transfer" is heuristic graph obfuscation,
  not anonymity — chain analysis can correlate the legs.
- **Program risk.** Even audited programs can change. The constants test
  (`packages/solana-programs/test/constants.test.ts`) will fail loudly if a
  pinned program ID or layout drifts from the verified values.

## Reporting a vulnerability

This is a self-hosted personal/organizational tool with no central service.
If you find a security-relevant bug in the code, patch it locally and rotate
any keys that may have been exposed — assume compromise of any secret that
ever left the keystore unencrypted.
