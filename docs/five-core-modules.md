# Five Core Modules — Design and Usage

Production reference for the five hardened feature areas: **Bundled Sell Token**,
**Token Auto Sell**, **Market Maker (Batch Swap)**, **Token Admin Panel**, and
**Solana Liquidity Pool Management**. All research grounding (Jito bundle
rules, DontFront markers, tip-floor pricing, program layouts) is documented in
[anti-mev-volume-bot.md](./anti-mev-volume-bot.md); the MEV-protection primitives
are shared with these modules.

Everything below is simulate-first: the CLI defaults to simulation mode, and
sending requires `--execute` plus `SOLADMIN_SIMULATION_MODE=false`.

---

## 1. Bundled Sell Token (`trade bundled-sell-exit`)

`packages/dex/src/bundled-sell.ts` — sell bags held across N wallets with MEV
protection and exit liquidity spread over time.

**Two architectures (`--sell-mode`):**

| Mode | Layout | When to use |
|---|---|---|
| `parallel` (default) | Each wallet sells its own balance; wallets are chunked into atomic Jito bundles of ≤5 txs (`chunkLegs`), executed sequentially with a delay between chunks | Large exits that should not hit the curve/pool in one slot |
| `collect-then-sell` | All wallets transfer their bags to one concentrator wallet inside ONE atomic bundle, then a single sell leg lands in the same bundle (`maxCollectSourcesPerBundle` = 4 sources + 1 sell) | Small exits needing perfect price coordination |

**MEV protection applied automatically:**
- DontFront marker (`jitodontfront…`) attached to the first leg of each bundle — the block engine rejects any competing bundle that would front-run it.
- Inline Jito tip on the final leg (never a standalone tip transaction — that risks uncle-bandit theft).
- Tip sized from the landed-tip feed percentile (25/50/75/95/99) with the 1000-lamport minimum enforced.

```bash
node apps/cli/dist/main.js trade bundled-sell-exit \
  --wallets wallets.json --venue pumpfun --mint <MINT> \
  --sell-mode parallel --slippage 500 \
  --tip-percentile 75 --chunk-delay 2000 --execute
```

## 2. Token Auto Sell (`trade auto-sell`)

`packages/dex/src/auto-sell.ts` — exit policy as one pure, fully tested
function (`evaluateExitTrigger`), evaluated on each price sample:

- Take-profit multiple, stop-loss fraction (priority: TP → SL → trailing)
- Trailing stop with activation multiple and peak tracking
- Timeout and Pump.fun graduation triggers
- Null price samples (RPC failures) never fire a price trigger
- Exponential backoff on sample failures, `maxChecks` guard

```bash
node apps/cli/dist/main.js trade auto-sell \
  --keystore wallet.json --mint <MINT> --venue pumpfun \
  --take-profit 3 --stop-loss 0.5 \
  --trailing-stop 2000 --activation 1.5 \
  --poll 1000 --execute
```

## 3. Market Maker — Batch Swap (`trade batch-swap`, `trade mm`)

`packages/dex/src/market-maker.ts` — two regimes:

- **Volume mode** (`trade batch-swap`): round-robin legs per round.
- **MM-skew mode** (`trade mm`): independent `buySchedule`/`sellSchedule` with
  their own notional, cadence, and per-leg size jitter (default ±3%); the loop
  interleaves sides by wall-clock deadlines, so a 5s/8s buy/sell cadence
  behaves like two live orders.

**Guard rails:**
- `InventoryRails`: skip buys at/above `--max-inventory`, skip sells at/below
  `--min-inventory` (independent thresholds; pure `shouldSkipLeg` is unit-tested)
- Circuit breaker: five consecutive leg failures abort the session
- Report carries `legsSkipped` and the last on-chain inventory reading

```bash
node apps/cli/dist/main.js trade mm \
  --keystore wallet.json --venue raydium-amm-v4 --mint <MINT> \
  --rounds 20 --buy-sol 200000000 --buy-interval 8000 \
  --sell-raw 3000000000 --sell-interval 13000 \
  --max-inventory 50000000000 --min-inventory 1000000000 \
  --jitter 300 --jito --execute
```

## 4. Token Admin Panel (`token …`)

`packages/services/src/token-admin.ts` — batch admin facade
(`runAdminPanel`) over 13 operations: mint-supply, burn, burn-lp,
freeze/unfreeze/auto-freeze, authorities, revoke-all, update-metadata,
set-transfer-fee, collect-tax, pause/resume.

**Token-2022 tax lifecycle:**
- `token set-fee --bps 250 --max-fee <raw>` — `SetTransferFee` (disc 26 →
  sub-op 5) via the mint's transfer-fee authority; validated against the wire
  layout in unit tests
- `token collect-tax` — harvest per-account withheld fees to the mint, then
  withdraw to your ATA (`--sources` for an explicit account list)
- `token pause / resume` — Pausable extension (disc 44, sub-ops 1/2); pausing
  freezes ALL transfers for every holder — the CLI flags this loudly

Classic SPL mints are rejected with a clear error for Token-2022-only
operations. Each operation goes through the simulate-first sender.

## 5. Solana Liquidity Pool Management

`packages/dex/src/raydium-pools.ts` — creation and live state:

- Creation: AMM v4 (direct instructions), CPMM and CLMM (official
  raydium-sdk-v2) — see `launch raydium-amm-v4 / raydium-cpmm / raydium-clmm / raydium-seed`
- `launch pool-state`: live AMM v4 vault reserves, LP supply, derived price
  and constant-product k — read from vault token balances, so it survives
  account-layout changes; the pool id is checked against the canonical AMM
  derived from the market id
- `launch pool-list`: Raydium public API pools for a mint with on-chain depth
  enrichment for AMM v4 entries

```bash
node apps/cli/dist/main.js launch pool-state \
  --pool <AMM> --base-mint <MINT> --quote-mint <WSOL> --market <MARKET>
```

---

## Test coverage

| Area | Tests |
|---|---|
| Bundled sell layout (`chunkLegs`, `maxCollectSourcesPerBundle`) | `packages/dex/test/bundled-sell.test.ts` (6) |
| Exit policy (`evaluateExitTrigger`) | `packages/dex/test/auto-sell.test.ts` (10) |
| Inventory rails (`shouldSkipLeg`) | `packages/dex/test/market-maker.test.ts` (4) |
| Admin instruction layouts (set-fee bytes, pause/resume, program detection) | `packages/services/test/token-admin.test.ts` (8) |

## Safety notes

- Nothing here bypasses simulation; every send path simulates first.
- Bundled volume/farming activity on a token you do not control, or wash
  trading, can constitute market manipulation in many jurisdictions. These
  tools are for operating your own token's liquidity and exits.
- Pause/freeze/authority operations are censorship-grade powers over other
  people's funds; the CLI warns on every path that uses them.
