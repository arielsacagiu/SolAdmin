# Anti-MEV Volume Bot (`soladmin volbot`)

Atomic buy→sell round trips on Solana venues, engineered so each round trip
leaves no exposure window for MEV extraction.

```
┌──────────────┐    ┌─────────────────────────────────────────────┐
│  one wallet   │ →  │  ONE transaction:                           │
│  per leg      │    │   wrap SOL → buy (exact-out) → sell → unwrap│
└──────────────┘    └─────────────────────────────────────────────┘
        intra-tx mode: both legs in the same tx → zero sandwich window

        bundle mode: N wallets' round-trip txs in one Jito bundle
                     → all land in the same slot, tip paid once
```

## ⚠️ Integrity & legality

This tool generates **synthetic** volume: buys and sells from wallets you
control. Artificial volume and wash trading **can violate laws** (e.g. market
manipulation statutes), **exchange rules**, and **venue/launchpad policies**.
Legitimate uses: localnet/devnet testing, program fuzzing, staging
environments, and research where the synthetic nature is disclosed.

**Never** present bot-generated volume as organic market activity.

## Commands

```bash
# resolve the venue and price one round trip (no keys needed, pure read)
soladmin volbot quote --mint <MINT> --venue auto --size 10000000

# run the schedule from a config file (simulation unless --execute + env gate)
soladmin [--execute] volbot run --file config/volume-bot.example.yaml

# sell residuals + sweep SOL out of the pool (e.g. after CTRL-C)
soladmin [--execute] volbot unwind --file config/volume-bot.example.yaml

# print pool balances
soladmin volbot balances --file config/volume-bot.example.yaml
```

## Execution shapes

| `execution` | `dispatch` | Behaviour |
|---|---|---|
| `intra-tx` | `rpc` | One atomic buy+sell tx per wallet via RPC (default). |
| `intra-tx` | `jito-tx` | Same atomic tx relayed through the Jito single-tx endpoint. |
| `bundle` | `jito-bundle` | `walletsPerRound` round-trip txs in one Jito bundle + tip member. |

`bundleTipFromFunder: true` adds a dedicated tip transaction signed by the
funder keystore; otherwise the sender appends a tip paid by the last member.

## Venues

`venue: auto` probes cheapest-first: **pump.fun** bonding curve (PDA read) →
**PumpSwap** (memcmp scan) → **LaunchLab/Bonk** (PDA + scan) → **Raydium CPMM**
(memcmp scan) → **Jupiter** route probe. Pin a venue explicitly or pass
`cpmmPoolAddress` to skip the CPMM scan.

All direct-venue constants (program IDs, discriminators, PDA seeds, account
layouts) are pinned in `packages/venues/src/*.ts` headers and covered by
`packages/venues/test/*` — 38 tests assert them byte-for-byte.

## Budgets

`budget.maxNetCostLamports` is a **required** hard cap on cumulative estimated
net cost (fees + spread). `maxVolumeLamports` caps gross notional (buy+sell).
`maxPerWalletLamports` caps a single round trip. Hitting a cap stops the run
cleanly (`BudgetExhausted`).

## Funding & unwind

- With `funderKeystore` set and `--execute`, the engine tops each pool wallet
  up to `tradeLamports.max + overhead` before round 1.
- After the run (or via `volbot unwind`): residual token balances are sold
  through the same venue, token ATAs closed (rent reclaimed), WSOL unwrapped,
  and SOL swept to `unwind.consolidateTo` (or the funder), keeping
  `unwind.leaveLamports` per wallet.

## Audit

- `output/volume-bot-report.jsonl` — one record per round trip: wallet, venue,
  size, tokens, expected cost, signatures, simulated flag, measured SOL delta
  (execute mode).
- `output/transaction-history.jsonl` — sender-level history.

## Keys

Pool and funder are keystore files (`soladmin-keystore` envelopes). Generate a
pool with `soladmin wallet generate-batch` (or `generateWalletPool` in code).
Passwords come from `SOLADMIN_KEYSTORE_PASSWORD` or the interactive prompt —
never from this config file.
