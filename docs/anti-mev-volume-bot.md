# Anti-MEV Volume Bot — design notes

`soladmin trade volume-bot` implements the toolkit's anti-MEV trading loop.
This document explains the MEV model it defends against and the mechanisms
it uses, all verified against Jito's official documentation and the Solana
MEV-protection guide (sources listed at the bottom).

## The threat: bundle sandwiches

On Solana, a sandwich attacker observes your pending swap and submits a Jito
bundle of the form:

```
[frontrun_tx, victim_tx, backrun_tx]
```

The block engine executes bundles sequentially and atomically inside a
single slot, so the attacker's front-run reliably lands before your trade
(you buy at a worse price) and the back-run lands right after (the attacker
pockets the price impact). You cannot be sandwiched "accidentally" across
slot boundaries — the attack requires ordering *inside* one slot, which is
exactly what bundles provide to whoever submits first.

## The defence: own the ordering

The volume bot neutralizes this by controlling the ordering of its own legs:

### 1. Atomic pair bundles (default, `--pair-mode atomic-bundle`)

Each buy+sell pair is submitted as ONE Jito bundle:

```
[buy_tx (DontFront), sell_tx (+ inline Jito tip)]
```

Jito bundle guarantees (docs.jito.wtf):

| Property | Meaning for the bot |
| --- | --- |
| Sequential | The buy always executes before the sell |
| Same-slot | Bundles cannot cross slot boundaries — both legs land together |
| All-or-nothing | If the sell fails, the buy is reverted too; no one-sided exposure |

No third-party transaction can be inserted between the two legs, because
there is no slot boundary between them — the sandwich needs its front-run
*inside the same slot before your buy*, which brings us to:

### 2. DontFront (`--dontfront`, on by default)

Jito's **DontFront** feature: any valid public key starting with
`jitodontfront` added as a read-only account to a transaction forces the
block engine to place that transaction at **bundle index 0** — any bundle
that would order another transaction before it is rejected outright. Via
`sendTransaction` (single-tx relay), no one else's bundle may front-run it
either.

The bot attaches the marker
(`jitodontfront111111111111111111111111111111`) to a dedicated **SPL Memo
instruction** (the verified executable Memo program,
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) instead of mutating the swap
instruction itself — memo is a no-op that tolerates arbitrary accounts, so
venue programs with strict account validation (e.g. aggregators) are never
touched.

DontFront ordering rules the bot respects:

- The marked buy is always bundle index 0 ✓
- Multi-wallet bundles (`bundled-buy`/`bundled-sell`) mark only the FIRST
  leg — multiple marked transactions must be contiguous at the front AND
  share a signer with the first, which independent wallets cannot.

### 3. Inline tips, sized from the market

Bundles compete in the block engine's auction (50ms ticks) on tips; Jito
enforces a **minimum tip of 1000 lamports** and drops below-tip bundles.
Two features follow the official guidance:

- **Inline tip** (`TransactionRequest.jitoTipLamports`): the tip transfer is
  the last instruction of the final leg transaction, not a standalone
  tipping transaction — Jito explicitly recommends integrating tips into
  the main transaction because standalone tip transactions invite
  "uncle bandit" scenarios.
- **Tip-floor sizing** (`--tip-mode tip-floor`): tips are sized from Jito's
  public landed-tip percentile feed
  (`https://bundles.jito.wtf/api/v1/bundles/tip_floor`), defaulting to the
  75th percentile with a configurable `--tip-percentile`. The value is
  cached for 30s (the feed refreshes each minute).

Because only the tip matters for `sendBundle` auction priority, priority
fees on bundle legs are kept minimal (they still pay the vote-credit-free
base fee).

## Pair modes

| Mode | Layout | MEV exposure | Looks like |
| --- | --- | --- | --- |
| `atomic-bundle` (default) | `[buy, sell]` one bundle, one slot | None between legs; DontFront blocks front-runs | Same-slot round trip — trivially non-organic |
| `intra-tx` | Both swaps in one transaction | Zero inter-leg exposure (single tx is atomic by definition) | One tx, two swaps; some venues restrict same-tx round trips (the pre-flight simulation surfaces these) |
| `separated` | Buy and sell land in different slots with a randomized gap | Exposed between slots (each leg still DontFront-marked and tip-relayed) | Closest to organic retail flow |

**Design trade-off to understand:** atomicity and organic appearance are
opposites. Same-slot round trips are the most sandwich-proof and the most
obviously non-organic. Choose per your goal: inventory rebalancing on your
own tokens → `atomic-bundle`; anything meant to look like retail flow →
`separated` (and read the legality note below).

## Pattern controls (why the defaults are what they are)

Detection heuristics for non-organic volume (from published volume-bot
documentation) flag exactly four signatures, all countered by defaults:

| Signature | Countermeasure (default) |
| --- | --- |
| Identical trade sizes | `--jitter 3000` — every buy size randomized ±30% |
| Regular fixed cadence | `--interval-jitter 3000` + `--min-interval 2000` — clustered/bursty timing |
| Single wallet hammering | Wallet pool rotated round-robin per pair |
| One-block funding chain | Buyer wallets are pre-funded separately (see `send transfer-all` guidance) |

Round-trip economics are tracked per pair and per session: venue fees
(pump.fun/moonit 1% per leg, Raydium/PumpSwap 0.25% per leg — the relevant
feed's verified tiers), 2× base fee, and the tip. `--max-cost <lamports>`
skips any pair whose estimated cost exceeds the budget; the report itemizes
`tipsPaidLamports` and `estimatedCostsLamports`.

## Reliability

- **Pre-flight simulation** of every bundle member before submission (the
  toolkit default; Jito's own onboarding recommends `simulateTransaction`
  before your first bundles).
- **Bundle size guard**: Jito allows at most 5 transactions per bundle — the
  sender throws rather than submitting oversized bundles.
- **Circuit breaker**: `--failure-limit` (default 3) stops the session after
  repeated failed pairs (lost auctions, drifted quotes).
- **Fresh quotes**: each pair re-reads curve/vault state at build time so
  the sell amount always matches the buy's expected output within the same
  slot.

## Usage

```bash
# Simulated rehearsal (default) — builds and simulates, never sends:
node apps/cli/dist/main.js trade volume-bot \
  --wallets examples/buyers.example.json \
  --venue pumpfun --mint <MINT> \
  --buy-sol 100000000 --pairs 5 --interval 15000 --slippage 1000

# Anti-MEV defaults + market-sized tips, executed:
#   (requires SOLADMIN_SIMULATION_MODE=false and --execute)
node apps/cli/dist/main.js --execute trade volume-bot \
  --wallets examples/buyers.example.json \
  --venue pumpfun --mint <MINT> \
  --buy-sol 100000000 --pairs 20 --interval 20000 --slippage 1000 \
  --pair-mode atomic-bundle --tip-mode tip-floor --tip-percentile 75

# Organic-looking separated legs instead of atomic pairs:
node apps/cli/dist/main.js --execute trade volume-bot ... --pair-mode separated
```

## Legality note

Volume generation that trades a token back to yourself affects other market
participants' perception. Coordinated wash trading is unlawful
market manipulation in many jurisdictions, and same-slot round trips are
trivially identifiable on-chain. Use these modules only on tokens you own,
in sandboxed environments, or where explicitly lawful — and see SECURITY.md.

## Sources

- Jito Labs, "Low Latency Transaction Send" (docs.jito.wtf/lowlatencytxnsend)
  — bundle limits/atomicity, auction mechanics, 1000-lamport minimum tip,
  tip placement guidance, tip-floor API.
- Solana Developers, "MEV Protection with Jito DontFront"
  (solana.com/developers/guides/advanced/mev-protection) — sandwich-via-
  bundle mechanics, the `jitodontfront` marker and its ordering rules.
- SPL Memo program address verified executable on mainnet via
  `getAccountInfo` (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
- Published volume-bot documentation — detection heuristics (size/cadence/
  wallet/funding signatures) and venue fee tiers.
