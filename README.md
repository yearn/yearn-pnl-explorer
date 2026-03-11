# Yearn TVL Tracker

Tracks Yearn Finance TVL across all vault generations (V1, V2, V3) and curation vaults (Morpho Blue, Turtle Club), with DefiLlama comparison, fee revenue analysis, and depositor analytics.

## Quick Start

```bash
bun install
cp .env.example .env     # Add your RPC URLs
bun run db:migrate       # Create SQLite tables
bun run seed             # Fetch all vaults + DefiLlama + curation (~2 min, requires ETH_RPC_URL)
```

Start the dashboard:

```bash
bun run dev:api          # API on http://localhost:3456
bun run dev:dashboard    # Dashboard on http://localhost:5173
```

## What It Does

- **TVL aggregation** across 9 chains (Ethereum, Arbitrum, Base, Optimism, Polygon, Fantom, Gnosis, Katana, Hyperliquid) with V3 allocator/strategy overlap deduction
- **DefiLlama comparison** against `yearn-finance` and `yearn-curating` protocols, broken down by chain and category
- **Fee revenue tracking** from vault harvest reports — performance and management fees with weekly/monthly history
- **Analysis** — dead TVL detection, retired vault tracking, depositor concentration
- **Interactive audit TUI** — drill into Chain > Category > Vault > Strategy with filter toggles

## Data Sources

| Source | What | Command |
|--------|------|---------|
| [Kong API](https://kong.yearn.fi) | V2/V3 vaults, strategies, debts, fees, harvest reports | `fetch:kong`, `fetch:reports` |
| On-chain (viem) | V1 vaults, V2 fee rates, Turtle Club vaults | `fetch:v1`, `scripts/fetch-v2-fees.ts` |
| [Morpho Blue API](https://blue-api.morpho.org) | Curation vaults (Morpho) | `fetch:curation` |
| [DefiLlama API](https://defillama.com) | Protocol TVL snapshots, historical token prices | `fetch:defillama`, `scripts/reprice-reports.ts` |

## Architecture

```
packages/shared  →  packages/db  →  packages/api  →  packages/dashboard
                                 ↗
              scripts/ (data fetchers)
```

- **shared** — Types, constants, curation registry, pricing interface
- **db** — SQLite via Drizzle ORM (9 tables)
- **api** — Hono REST API (TVL, comparison, fees, analysis)
- **dashboard** — React + Vite + Recharts (5 tabs)
- **scripts/** — Data fetchers, repricing, interactive audit TUI

## API

```
GET /api/tvl/                              # TVL summary
GET /api/tvl/vaults?chainId=1&category=v2  # Per-vault list
GET /api/tvl/overlap                       # Double-count details

GET /api/comparison/                       # Us vs DefiLlama

GET /api/fees/?since=1709251200            # Fee revenue
GET /api/fees/history?interval=weekly      # Fee history

GET /api/analysis/dead                     # Dead TVL (no harvests 90d)
GET /api/analysis/retired                  # Retired vault TVL
GET /api/analysis/sticky                   # Sticky TVL
GET /api/analysis/depositors/:address      # Depositor lookup
```

## Environment

Copy `.env.example` and fill in RPC URLs. Only `ETH_RPC_URL` is strictly required — other chain RPCs are needed for V2 fee reads and curation vault discovery.

## License

Private.
