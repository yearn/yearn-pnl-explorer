# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development — run API and dashboard together
bun run dev:api          # Hono API on :3456 (--watch)
bun run dev:dashboard    # Vite React dashboard on :5173 (proxies /api → :3456)

# Data fetching (run in order, or use seed)
bun run seed             # Runs kong → defillama → curation → v1 sequentially
bun run fetch:kong       # V2/V3 vaults from Kong GraphQL API
bun run fetch:defillama  # DefiLlama protocol TVL snapshots
bun run fetch:curation   # Morpho Blue API + Turtle Club on-chain reads
bun run fetch:v1         # V1 legacy vaults on-chain (Ethereum, getPricePerFullShare)
bun run fetch:reports    # Vault harvest reports (gainUsd per harvest)
bun run fetch:depositors # Depositor data from Kong transfers (Ethereum only)

# Post-fetch enrichment
bun run scripts/fetch-v2-fees.ts    # Read actual V2 fee rates on-chain (most are 10%/0%)
bun run scripts/reprice-reports.ts  # Reprice reports using DL historical prices

# Audit — interactive TUI with hierarchical TVL breakdown
bun run audit                              # Interactive TUI (Chain → Category → Vault → Strategy)
bun run audit -- --min-tvl=1000000         # Filter by min TVL
bun run audit -- --include-retired         # Include retired vaults
bun run audit -- --json                    # JSON output
bun run audit -- --static                  # Non-interactive, fully expanded
# TUI controls: ↑↓ navigate, Enter/→ expand, ← collapse, f/Tab cycle filter, q quit
# Filter modes: All → Allocators (no V3 strats) → Strategies (no V3 allocs) → Curation only

# Database
bun run db:generate      # Generate Drizzle migration (interactive — won't work in non-TTY)
bun run db:migrate       # Apply migrations

# Type checking
bun run typecheck        # tsc --noEmit across all packages
```

## How to Use

### First-time setup

```bash
bun install
cp .env.example .env     # Add ETH_RPC_URL and per-chain RPCs
bun run db:migrate       # Create SQLite tables
```

### Populating data

Run the seed to fetch all vault data (V2/V3 from Kong, DefiLlama TVL snapshots, curation vaults from Morpho + Turtle Club):

```bash
bun run seed             # ~2 min, fetches kong + defillama + curation + v1
```

Then run additional fetchers that aren't part of seed:

```bash
bun run fetch:reports                   # Harvest reports for fee analysis (~5 min)
bun run scripts/fetch-v2-fees.ts        # Correct V2 fee rates from on-chain
bun run scripts/reprice-reports.ts      # Reprice reports with DL historical prices (~10 min)
bun run fetch:depositors                # Depositor data (Ethereum only)
```

### Running the dashboard

```bash
bun run dev:api          # Terminal 1: API server on :3456
bun run dev:dashboard    # Terminal 2: React dashboard on :5173
```

Open `http://localhost:5173`. The dashboard has 5 tabs:
- **Overview** — Total TVL by chain and category (V1/V2/V3/Curation), overlap deduction, vault counts
- **Comparison** — Our TVL vs DefiLlama (yearn-finance + yearn-curating), per-chain and per-category deltas
- **Fees** — Fee revenue from harvests (performance + management fees), weekly/monthly history
- **Analysis** — Dead TVL (no harvests in 90d), retired vault TVL, depositor concentration
- **Vaults** — Sortable/filterable per-vault list

### API endpoints

All endpoints return JSON. Base URL: `http://localhost:3456`

```
GET /health                                  # Health check

GET /api/tvl/                                # TVL summary (totals, by chain, by category)
GET /api/tvl/vaults?chainId=1&category=v2    # Per-vault list (filterable)
GET /api/tvl/overlap                         # V3 allocator→strategy overlap details

GET /api/comparison/                         # Our TVL vs DefiLlama

GET /api/fees/?since=1709251200              # Fee summary (optional since= unix ts)
GET /api/fees/vaults?since=1709251200        # Per-vault fee breakdown
GET /api/fees/history?interval=weekly        # Fee history (weekly|monthly)

GET /api/analysis/dead                       # Dead TVL (no reports in 90d)
GET /api/analysis/retired                    # Retired vault TVL
GET /api/analysis/sticky                     # Sticky TVL analysis
GET /api/analysis/depositors/:address        # Depositor concentration (?chainId=1)
```

### Auditing TVL interactively

```bash
bun run audit
```

The TUI shows a hierarchical breakdown: Chain → Category (Allocation/Strategies/Curators) → Vault → Strategy. Use number keys 1-3 to toggle category visibility for double-count analysis.

## Architecture

Bun workspace monorepo with four packages and a scripts directory:

```
packages/shared  →  packages/db  →  packages/api  →  packages/dashboard
                                 ↗
              scripts/ (data fetchers)
```

**Dependency flow**: shared (types/constants) → db (schema/client) → api (Hono routes/services) and scripts (data fetchers). Dashboard is a standalone React SPA that calls the API via Vite proxy.

### packages/shared
Types (`VaultCategory`, `TvlSummary`, `KongVault`, etc.), constants (`CHAIN_IDS`, `CHAIN_NAMES`, `KONG_API_URL`, `V1_VAULTS`, `IGNORED_VAULTS`), curation vault registry (`YEARN_CURATOR_OWNERS`, `TURTLE_CLUB_VAULTS`, factory configs per chain), and pluggable pricing interface (`HistoricalPriceProvider`, `DefiLlamaPriceProvider`).

### packages/db
SQLite via Drizzle ORM + `bun:sqlite`. DB file lives at `packages/db/yearn-tvl.db` (resolved relative to the package, not CWD). 9 tables: `vaults`, `vaultSnapshots`, `strategies`, `strategyDebts`, `feeConfigs`, `strategyReports`, `defillamaSnapshots`, `depositors`, `tvlOverlap`. Import as `import { db, vaults, ... } from "@yearn-tvl/db"`.

### packages/api
Hono REST API on port 3456. Four route groups, each backed by a service:

- `/api/tvl` — TVL summary, per-vault list, overlap details. Service computes latest-snapshot aggregation with V3 allocator→strategy overlap deduction.
- `/api/comparison` — Our TVL vs DefiLlama (yearn-finance + yearn-curating), per-chain and per-category.
- `/api/fees` — Fee revenue from harvest reports × fee rates. Supports `?since=` timestamp filter and `?interval=weekly|monthly` history.
- `/api/analysis` — Dead TVL classification (no reports in 90d), retired vault TVL, depositor concentration.

### packages/dashboard
React 19 + Vite + Recharts. 5 tabs: Overview, Comparison, Fees, Analysis, Vaults. Uses `useFetch<T>` hook to call API. Vite proxies `/api/*` to the API server.

### scripts/
Each script fetches from an external source and upserts into the DB:
- `fetch-kong.ts` — Kong GraphQL (`vaults(yearn: true)`) → vaults, snapshots, strategies, debts, fees
- `fetch-defillama.ts` — DefiLlama protocol API → defillamaSnapshots
- `fetch-curation.ts` — Morpho Blue GraphQL (by owner/creator/curator) + Turtle Club viem reads → curation vaults (Ethereum, Base, Katana, Arbitrum, Hyperliquid)
- `fetch-v1-vaults.ts` — 28 legacy V1 Ethereum vaults via on-chain reads (`token()`, `totalSupply()`, `getPricePerFullShare()`)
- `fetch-reports.ts` — Kong `vaultReports(chainId, address)` per vault → strategyReports (includes raw `gain` for repricing)
- `fetch-depositors.ts` — Kong `transfers(chainId, address)` → depositors (Ethereum only, 100/vault limit)
- `fetch-v2-fees.ts` — Reads actual `managementFee()` and `performanceFee()` from V2 vault contracts on-chain
- `reprice-reports.ts` — Reprices reports with `HistoricalPriceProvider` (default: DefiLlama historical prices, snapshot fallback)
- `audit.ts` — Interactive TUI: Chain → Category (Allocation/Strategies/Curators) → Vault → Strategy

## Key Domain Concepts

**Vault categories**: `v1` (legacy, Ethereum only), `v2` (apiVersion 0.4.x), `v3` (v3=true), `curation` (Morpho/Turtle Club, NOT in Kong)

**Vault types (V3 only)**: `1` = allocator (deposits into strategies), `2` = strategy (receives allocations). The audit TUI splits V3 into "Allocators" and "Strategies" sub-categories. Showing only one avoids double-counting.

**Double-counting**: V3 allocators deploy capital to strategies that may be other vaults. The overlap engine in `services/tvl.ts` detects when a strategy address matches a known vault and deducts the debt amount from the total.

**Fee calculation**: Performance fee = `gainUsd × (performanceFee / 10000)`. Management fee = `TVL × (mgmtFee / 10000) × durationYears`. Fees stored in basis points (1000 = 10%).

**DefiLlama mapping**: V1 + V2 + V3 → `yearn-finance`, Curation → `yearn-curating`. Retired vaults excluded from both.

**Pricing**: `HistoricalPriceProvider` interface in `packages/shared/src/pricing.ts`. Default: `DefiLlamaPriceProvider` using `coins.llama.fi/prices/historical`. Swap the provider in `reprice-reports.ts` to use a custom pricing backend.

**Chains supported**: Ethereum (1), Optimism (10), Polygon (137), Fantom (250), Base (8453), Arbitrum (42161), Gnosis (100), Katana (747474), Hyperliquid (999).

## Environment

`.env` at project root with `ETH_RPC_URL` and per-chain RPCs as `RPC_URI_FOR_{chainId}`. Never committed. Required for V1 vaults, V2 fee reads, curation Turtle Club reads (viem).

## Conventions

- All imports use `.js` extensions (ESM with TypeScript)
- Workspace packages referenced as `workspace:*` in package.json
- Kong API URL: `https://kong.yearn.fi/api/gql` — GraphQL with `yearn: true` filter
- 9 vaults explicitly ignored in `IGNORED_VAULTS` (2 bad data + 7 DL blacklist)
- DB path is resolved relative to `packages/db/` directory via `import.meta.url`, not process CWD
