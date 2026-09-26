# SolAdmin — Self-Contained Solana Toolkit

A local-first, 100% self-contained TypeScript monorepo replicating the
on-chain capabilities of ct.app (cointool.app) with **zero dependency on any
paid web service**. Everything runs in Node.js — no browser, no headless
browser, no third-party backend of your own required.

```
Node.js 20+ · Turborepo · pnpm · TypeScript (strict) · Pino · Vitest
@solana/web3.js · @solana/spl-token · @raydium-io/raydium-sdk-v2
@metaplex-foundation/mpl-token-metadata · @coral-xyz/anchor
direct calls to the official Pump.fun / Moonit programs
```

> **READ FIRST — SECURITY**
>
> * **Simulation mode is ON by default.** Nothing is ever sent to the
>   network until you (a) set `SOLADMIN_SIMULATION_MODE=false` in your env,
>   and (b) pass `--execute` to the command. Pre-flight simulation is
>   mandatory before every send.
> * **Private keys live only in password-encrypted JSON keystores**
>   (scrypt + AES-256-GCM). Never paste secret keys into code, env files,
>   chats, or command-line arguments.
> * **Revoke authorities after launch.** The token creator revokes mint,
>   freeze, and metadata update authorities by default — keeping them harms
>   your holders and is flagged loudly.
> * Automation can lose money (slippage, MEV, failed bundles). Start on
>   devnet, then small mainnet amounts. See [SECURITY.md](./SECURITY.md).

---

## Repository layout

```
├── apps/
│   ├── cli/                     # `soladmin` — every module as a command (Commander.js)
│   └── web/                     # Optional local Express UI (binds 127.0.0.1)
├── packages/
│   ├── types/                   # @solana-toolkit/types — shared TS types
│   ├── utils/                   # @solana-toolkit/utils — Pino logging, YAML/JSON config, CSV, security warnings
│   ├── rpc-client/              # @solana-toolkit/rpc-client — RPC wrapper, WS subscriptions,
│   │                            #   priority-fee monitor, Jito Block Engine bundle client
│   ├── transaction-builder/     # @solana-toolkit/transaction-builder — simulate-first sender,
│   │                            #   compute budget + Jito tip, bundles, JSONL history
│   ├── wallet-manager/          # @solana-toolkit/wallet-manager — encrypted keystores, batch
│   │                            #   generators, vanity addresses, balance checker
│   ├── solana-programs/         # @solana-toolkit/solana-programs — SPL/Token-2022, Metaplex metadata,
│   │                            #   Pump.fun + PumpSwap, Moonit, Raydium AMM v4, OpenBook V1/V2
│   ├── dex/                     # @solana-toolkit/dex — Jupiter, direct swaps, launches, market maker,
│   │                            #   anti-MEV volume bot, Jito sniping, auto-sell, pool creation
│   └── services/                # @solana-toolkit/services — multisend, collection, exchanges,
│                                #   audits, holders, stealth transfers, website generator, chain tools
├── config/                      # Example YAML configs (toolkit + lifecycles)
├── examples/                    # Example JSON inputs (buyers, recipients, withdrawals)
└── output/                     # Reports, CSV exports, transaction history (gitignored)
```

---

## Setup

```bash
# Node.js 20+ and pnpm 9 (corepack enable prepares it)
corepack enable
corepack prepare pnpm@9.12.0 --activate

pnpm install
pnpm build          # builds every package via Turborepo
pnpm test           # runs the unit-test suite (Vitest)
```

Copy `.env.example` to `.env` and fill in your RPC endpoint. A private RPC
with WebSocket + `sendBundle` support (Helius, QuickNode, Triton, or your own
node) is strongly recommended for launch/sniping work.

The CLI binary is `apps/cli/dist/main.js`; run it through the repo with:

```bash
node apps/cli/dist/main.js --help
# or link it:
pnpm --filter @solana-toolkit/cli exec node dist/main.js --help
```

---

## Safety model

| Layer | Guarantee |
| --- | --- |
| Global mode | `SOLADMIN_SIMULATION_MODE` defaults to **true** — nothing leaves the machine |
| Execute gate | `--execute` is additionally required, and refused while simulation mode is on |
| Pre-flight | Every transaction is simulated before sending; failures abort the send with full logs |
| Bundles | Every Jito bundle carries a tip and is simulated member-by-member pre-flight |
| Keys | scrypt(16384/8/1) + AES-256-GCM keystores, file mode 0600, interactive password prompts |
| Audits | Authority checks, tax/fee detection, LP status, metadata review on any mint |
| History | Every outcome is appended to `output/transaction-history.jsonl` for reconstruction |

---

## Module map (CLI → implementation)

| Command | Module | Notes |
| --- | --- | --- |
| `wallet keystore-create / keystore-import / keystore-info` | Keystores | Encrypted JSON keystores (scrypt + AES-256-GCM) |
| `wallet generate` | Batch Wallet Generator | Encrypted keystores + public `batch.json` |
| `wallet vanity` | Vanity Address Generator | Prefix/suffix matching, case sensitivity options |
| `wallet balance` | Batch Balance Checker | SOL + SPL/Token-2022 balances, CSV export |
| `send token-multisend` | Token MultiSender | Chunked batches, destination ATA creation |
| `send nft-multisend` | NFT MultiSender | Per-NFT transfers to many recipients |
| `send multi-to-multi` | Multiple-to-Multiple Transfer | N:N paired transfers |
| `send collect` | Token Batch Collection | Sweep a token from many wallets |
| `send transfer-all` | Transfer All Assets | Swap-to-SOL + close accounts + SOL sweep |
| `send claim-sol` | Claim SOL | Multi-wallet SOL consolidation |
| `send stealth` | Stealth Transfer | Relay legs with jitter (heuristic, not anonymity) |
| `token create` | Token Creator | SPL + Token-2022, transfer-fee/tax, transfer hook, metadata; authority revocation by default |
| `token clone` | Clone Token | Metadata + decimals + supply replication |
| `token mint / burn / burn-liquidity` | Token Admin Panel | Supply ops, LP burns (irreversible — flagged) |
| `token set-fee / collect-tax` | Token Admin Panel | Token-2022 transfer-fee (tax) update + withheld-fee harvest/withdraw |
| `token pause / resume` | Token Admin Panel | Token-2022 Pausable extension (censorship-grade — loud warnings) |
| `token freeze / auto-freeze` | Freeze utilities | Requires freeze authority; loud warnings |
| `token authorities` | Authority Management | Revoke/transfer mint, freeze, metadata authorities |
| `token metadata-update` | Update Token Metadata | Name/symbol/URI + logo upload |
| `token audit` | On-chain Contract Audit | Authorities, tax, curve state, LP status |
| `token holders / nft-holders` | Holder scanners | Paginated scans with CSV export |
| `token website` | Static Website Generator | Self-contained HTML page for a token |
| `swap exec` | Solana Swap | Jupiter + direct Pump.fun / PumpSwap / Moonit / Raydium |
| `swap all` | Fast Swap All Tokens | Whole-wallet conversion to SOL |
| `swap price / fee-monitor` | Monitors | Jupiter price API; live priority-fee sampling |
| `launch pumpfun` | Pump.fun Launch + Buy | Up to 28 simultaneous buyers, atomic Jito bundles |
| `launch moonit` | Moonit Launch + Buy | Up to 6 buyers; launch signed locally |
| `launch raydium-amm-v4` | Raydium launch | OpenBook V1 market + AMM v4 pool seeding |
| `launch openbook-market` | Create OpenBook Market | V1 + V2 layouts |
| `launch raydium-cpmm / raydium-clmm` | Liquidity Pool Management | Via official raydium-sdk-v2 |
| `launch pool-state / pool-list` | Pool monitoring | Live AMM v4 vault reserves, LP supply, price, k; Raydium API pool listing |
| `launch raydium-seed` | AMM v4 pool seeding | Direct instructions |
| `launch claim-creator-fees` | Claim Creator Fees | Pump.fun creator vaults, multi-wallet |
| `trade batch-swap` | Market Maker | Round-robin legs across venues |
| `trade mm` | Market Maker (MM-skew) | Independent buy/sell schedules, per-leg jitter, inventory guard rails, circuit breaker |
| `trade bundled-sell-exit` | Bundled Sell Token exits | Parallel or collect-then-sell across N wallets, adaptive Jito tips — see [docs/five-core-modules.md](./docs/five-core-modules.md) |
| `trade volume-bot` | Anti-MEV Volume Bot | Atomic same-slot buy+sell Jito bundles with DontFront markers and tip-floor pricing — see [docs/anti-mev-volume-bot.md](./docs/anti-mev-volume-bot.md) |
| `trade bundled-buy / bundled-sell` | Bundled Buy/Sell | N wallets, one atomic Jito bundle |
| `trade snipe` | Jito Sniping | logsSubscribe on Pump.fun creates → instant bundle buys |
| `trade auto-sell` | Token Auto Sell | Take-profit / stop-loss / trailing-stop / timeout / graduation triggers |
| `trade increase-holders / increase-txns` | Holders / ↑Txns | Distributed buys / ping-pong trades |
| `exchange withdraw` | Exchange Bulk Withdrawal | Binance, OKX, Bybit, Bitget, Gate.io, MEXC official APIs |
| `chain wsol` | WSOL Converter | Wrap / unwrap |
| `chain airdrop` | Devnet faucet | With retry + clear errors |
| `chain history / probe-rpc / links` | General Chain Tools | History reconstruction, endpoint probe, explorer links |
| `lifecycle` | Full automation | create → launch → buy → monitor → exit → consolidate, driven by YAML/JSON |

---

## End-to-end lifecycle automation

`config/lifecycle.pumpfun.example.yaml` shows the full declarative flow:

```bash
node apps/cli/dist/main.js lifecycle --config config/lifecycle.pumpfun.example.yaml
```

Stages can be run individually with `--stage create|launch|monitor|exit|consolidate`.
The example configs run in **simulation mode** (`simulationMode: true`) so you
can rehearse the whole lifecycle risk-free. Buyer wallets are auto-generated
as encrypted keystores in `buyerKeystoreDir` when missing.

---

## Example configurations

* `config/toolkit.example.yaml` — RPC (Helius/QuickNode/local), Jito block
  engine (region), priority fees, safety caps, named keystores.
* `config/lifecycle.pumpfun.example.yaml` — Pump.fun launch lifecycle (8 buyers).
* `config/lifecycle.raydium.example.yaml` — Raydium AMM v4 launch lifecycle.
* `examples/*.json` — buyer lists, multisend recipients, M2M pairs, exchange
  withdrawal requests.

## Legitimate use cases for DeFi automation

SolAdmin exists for builders and operators who want sovereign, auditable
tooling instead of closed web services:

* **Token launches** — create a fair token, revoke authorities, seed
  liquidity, and distribute to community wallets with full pre-flight
  simulation and JSONL audit history.
* **Treasury operations** — consolidate revenue wallets, sweep airdrops,
  batch-pay contributors, and convert holdings through the best venue.
* **Market making / liquidity provision** — quote both sides on Raydium,
  manage CPMM/CLMM pools, and monitor priority fees before adjusting.
* **Risk management** — automated exit strategies with take-profit/stop-loss,
  holder concentration audits before buying, and tax/fee detection.
* **Research & audits** — read-only holder scans, authority reviews, curve
  state decoding, and static website generation for transparency pages.

Anything that manipulates apparent interest (holders/txns/volume) affects
other market participants. Many jurisdictions treat coordinated wash
trading or misleading volume as unlawful manipulation; use those modules
only on tokens you own, in sandboxed environments, or for load testing —
and check your local rules first.

## Verifying the builds

```bash
pnpm build    # 12 packages compile under strict TypeScript
pnpm test     # unit tests for encoders, builders, PDAs, keystores, quotes,
              # event parsers and the simulation-first pipeline
```

The devnet smoke flow used during development:

```bash
export SOLADMIN_RPC_URL=https://api.devnet.solana.com
export SOLADMIN_CLUSTER=devnet
export SOLADMIN_SIMULATION_MODE=true
export SOLADMIN_KEYSTORE_PASSWORD=devnet-password
node apps/cli/dist/main.js wallet keystore-create --out wallets/dev.keystore.json
node apps/cli/dist/main.js chain airdrop --keystore wallets/dev.keystore.json
node apps/cli/dist/main.js token create --keystore wallets/dev.keystore.json \
  --name "Demo" --symbol "DEMO" --uri "https://example.com/m.json" \
  --decimals 6 --supply 1000000000
# add --execute (and SOLADMIN_SIMULATION_MODE=false) to actually send
```

## Optional web UI

```bash
pnpm --filter @solana-toolkit/web build
SOLADMIN_WEB_PORT=8787 pnpm --filter @solana-toolkit/web start
# http://127.0.0.1:8787 — read-only endpoints + execute-gated swap
```

The server binds **127.0.0.1 only**. Do not expose it without an
authenticating reverse proxy (see SECURITY.md).

## Program addresses used

All program IDs, instruction discriminators and account layouts were
verified against official sources (pump-fun/pump-public-docs IDL,
gomoonit/moonit-sdk IDL v4, docs.raydium.io + raydium-sdk-V2 source,
openbook-dex/openbook-v2 client, Metaplex docs, Solana Labs) and are pinned
in `packages/solana-programs/src/constants.ts`, with a regression test that
validates every constant. A constants test failure means an address changed
upstream — update the source, not the test.
