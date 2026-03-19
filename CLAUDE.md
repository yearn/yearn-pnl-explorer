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
bun run fetch:prices     # Weekly historical asset prices from DefiLlama (~10 min)

# Post-fetch enrichment
bun run scripts/fetch-v2-fees.ts    # Read actual V2 fee rates on-chain (most are 10%/0%)
bun run scripts/reprice-reports.ts  # Reprice reports using cached prices + snapshot fallback

# Overlap detection — find strategies that deposit into other Yearn vaults
bun run scripts/detect-overlaps.ts  # On-chain scan, outputs candidates for STRATEGY_OVERLAP_REGISTRY

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
bun run fetch:prices                    # Weekly historical asset prices (~10 min, run before repricing)
bun run scripts/reprice-reports.ts      # Reprice reports using cached prices + snapshot fallback
bun run fetch:depositors                # Depositor data (Ethereum only)
```

### Running the dashboard

**Local development** (API + dashboard together):

```bash
bun run dev:api          # Terminal 1: API server on :3456
bun run dev:dashboard    # Terminal 2: React dashboard on :5173
```

Open `http://localhost:5173`. In local dev, the Vite proxy forwards `/api/*` to `:3456`, so `VITE_API_URL` is not needed.

**Production** — the dashboard is hosted on Vercel and reads from the Fly.io API:

- Dashboard: https://yearn-metrics-dashboard.vercel.app
- API: https://yearn-metrics.fly.dev

The dashboard has 5 tabs:
- **Overview** — Total TVL by chain and category (V1/V2/V3/Curation), overlap deduction, vault counts
- **Comparison** — Our TVL vs DefiLlama (yearn-finance + yearn-curating), per-chain and per-category deltas
- **Fees** — Fee revenue from harvests (performance + management fees), weekly/monthly history
- **Analysis** — Dead TVL (no harvests in 90d), retired vault TVL, depositor concentration
- **Vaults** — Sortable/filterable per-vault list

### API endpoints

All endpoints return JSON. Production base: `https://yearn-metrics.fly.dev`, local: `http://localhost:3456`

```
GET /health                                  # Health check

GET /api/tvl                                 # TVL summary (totals, by chain, by category)
GET /api/tvl/vaults?chainId=1&category=v2    # Per-vault list (filterable)
GET /api/tvl/overlap                         # Vault→vault overlap details (auto + registry)

GET /api/comparison                          # Our TVL vs DefiLlama

GET /api/fees?since=1709251200               # Fee summary (optional since= unix ts)
GET /api/fees/vaults?since=1709251200        # Per-vault fee breakdown
GET /api/fees/history?interval=weekly        # Fee history (weekly|monthly)

GET /api/analysis/dead                       # Dead TVL (no reports in 365d)
GET /api/analysis/retired                    # Retired vault TVL
GET /api/analysis/sticky                     # Sticky TVL analysis
GET /api/analysis/depositors/:address        # Depositor concentration (?chainId=1)
```

### Auditing TVL interactively

```bash
bun run audit
```

The TUI shows a hierarchical breakdown: Chain → Category (Allocation/Strategies/Curators) → Vault → Strategy. Use number keys 1-3 to toggle category visibility for double-count analysis.

## Deployment

### Hosting overview

| Component | Host | URL |
|-----------|------|-----|
| API | Fly.io (free tier) | https://yearn-metrics.fly.dev |
| Dashboard | Vercel (free tier) | https://yearn-metrics-dashboard.vercel.app |

The API runs as a Docker container on Fly.io with a 1GB persistent volume at `/data/` for the SQLite DB. The dashboard is a static Vite build on Vercel that calls the API via `VITE_API_URL` (baked in at build time). CORS is enabled on the API.

The Fly machine has `auto_stop_machines = "stop"` — it sleeps when idle and wakes on first request (cold start ~2-3s).

### Updating the production database

Seed locally, then upload the DB file to Fly:

```bash
# 1. Seed locally
bun run seed
bun run fetch:reports                       # optional extras
bun run scripts/fetch-v2-fees.ts
bun run fetch:prices                        # weekly historical asset prices
bun run scripts/reprice-reports.ts

# 2. Upload to Fly
fly ssh console -C "rm /data/yearn-tvl.db /data/yearn-tvl.db-shm /data/yearn-tvl.db-wal"
fly ssh sftp shell
# then: put packages/db/yearn-tvl.db /data/yearn-tvl.db

# 3. Restart to pick up new DB
fly machines list                           # get machine ID
fly machine restart <machine-id>

# 4. Verify
curl https://yearn-metrics.fly.dev/api/tvl
```

### Deploying API changes

```bash
fly deploy                                  # builds Docker image and deploys
```

The `Dockerfile` strips the `scripts` workspace from `package.json` (only `packages/*` are needed at runtime). If you add new workspace packages the API depends on, update the Dockerfile `COPY` steps.

### Deploying dashboard changes

```bash
cd packages/dashboard
vercel deploy --yes --prod                  # builds on Vercel with VITE_API_URL from project env
```

`VITE_API_URL` is set as a Vercel project env var (production). To change it: `vercel env rm VITE_API_URL production && echo "https://new-url" | vercel env add VITE_API_URL production`, then redeploy.

### Fly.io useful commands

```bash
fly status                                  # App status
fly machines list                           # List machines + IDs
fly ssh console -C "<cmd>"                  # Run command on the machine
fly ssh sftp shell                          # Interactive file transfer
fly logs                                    # Stream live logs
fly volumes list                            # Volume info
```

## Architecture

Bun workspace monorepo with four packages and a scripts directory:

```
packages/shared  →  packages/db  →  packages/api  →  packages/dashboard
                                 ↗
              scripts/ (data fetchers)
```

**Dependency flow**: shared (types/constants) → db (schema/client) → api (Hono routes/services) and scripts (data fetchers). Dashboard is a standalone React SPA that calls the API via Vite proxy.

### packages/shared
Types (`VaultCategory`, `TvlSummary`, `KongVault`, etc.), constants (`CHAIN_IDS`, `CHAIN_NAMES`, `KONG_API_URL`, `V1_VAULTS`, `IGNORED_VAULTS`), curation vault registry (`YEARN_CURATOR_OWNERS`, `TURTLE_CLUB_VAULTS`, factory configs per chain), strategy overlap registry (`STRATEGY_OVERLAP_REGISTRY`), and pluggable pricing interface (`HistoricalPriceProvider`, `DefiLlamaPriceProvider`).

### packages/db
SQLite via Drizzle ORM + `bun:sqlite`. DB file lives at `packages/db/yearn-tvl.db` (resolved relative to the package, not CWD). 10 tables: `vaults`, `vaultSnapshots`, `strategies`, `strategyDebts`, `feeConfigs`, `strategyReports`, `defillamaSnapshots`, `depositors`, `tvlOverlap`, `assetPrices`. Import as `import { db, vaults, ... } from "@yearn-tvl/db"`.

### packages/api
Hono REST API on port 3456. Four route groups, each backed by a service:

- `/api/tvl` — TVL summary, per-vault list, overlap details. Service computes latest-snapshot aggregation with vault→vault overlap deduction (auto-detected + registry-based).
- `/api/comparison` — Our TVL vs DefiLlama (yearn-finance + yearn-curating), per-chain and per-category.
- `/api/fees` — Fee revenue from harvest reports × fee rates. Supports `?since=` timestamp filter and `?interval=weekly|monthly` history.
- `/api/analysis` — Dead TVL classification (no reports in 365d), retired vault TVL, depositor concentration.

### packages/dashboard
React 19 + Vite + Recharts. 5 tabs: Overview, Comparison, Fees, Analysis, Vaults. Uses `useFetch<T>` hook which prepends `VITE_API_URL` to all fetch calls (empty string in local dev → Vite proxy handles it; full URL in production → direct to Fly.io API). Standalone `tsconfig.json` (no `extends`) so it builds independently on Vercel.

### scripts/
Each script fetches from an external source and upserts into the DB:
- `fetch-kong.ts` — Kong GraphQL (`vaults(yearn: true)`) → vaults, snapshots, strategies, debts, fees
- `fetch-defillama.ts` — DefiLlama protocol API → defillamaSnapshots
- `fetch-curation.ts` — Morpho Blue GraphQL (by owner/creator/curator) + Turtle Club viem reads → curation vaults (Ethereum, Base, Katana, Arbitrum, Hyperliquid)
- `fetch-v1-vaults.ts` — 28 legacy V1 Ethereum vaults via on-chain reads (`token()`, `totalSupply()`, `getPricePerFullShare()`)
- `fetch-reports.ts` — Kong `vaultReports(chainId, address)` per vault → strategyReports (includes raw `gain` for repricing)
- `fetch-depositors.ts` — Kong `transfers(chainId, address)` → depositors (Ethereum only, 100/vault limit)
- `fetch-v2-fees.ts` — Reads actual `managementFee()` and `performanceFee()` from V2 vault contracts on-chain
- `fetch-historical-prices.ts` — Weekly historical asset prices from DefiLlama → assetPrices (used by repricing and fee calculations)
- `reprice-reports.ts` — Reprices reports using: (1) cached weekly prices from assetPrices, (2) vault snapshot fallback for LP tokens
- `detect-overlaps.ts` — On-chain scan for strategies holding shares of other Yearn vaults; outputs candidates for `STRATEGY_OVERLAP_REGISTRY` in `packages/shared/src/strategy-overlaps.ts`
- `audit.ts` — Interactive TUI: Chain → Category (Allocation/Strategies/Curators) → Vault → Strategy

## Key Domain Concepts

**Vault categories**: `v1` (legacy, Ethereum only), `v2` (apiVersion 0.4.x), `v3` (v3=true), `curation` (Morpho/Turtle Club, NOT in Kong)

**Vault types (V3 only)**: `1` = allocator (deposits into strategies), `2` = strategy (receives allocations). The audit TUI splits V3 into "Allocators" and "Strategies" sub-categories. Showing only one avoids double-counting.

**Double-counting**: Vaults can deploy capital to strategies that are (or deposit into) other vaults. The overlap engine in `services/tvl.ts` uses two methods: (1) auto-detection — checks if any strategy address matches a known vault address across all vault types, (2) registry-based — `STRATEGY_OVERLAP_REGISTRY` in `packages/shared/src/strategy-overlaps.ts` lists intermediary depositor contracts whose address ≠ target vault. Run `bun run scripts/detect-overlaps.ts` to discover new candidates.

**Fee calculation**: Performance fee = `gainUsd × (performanceFee / 10000)`. Management fee = `TVL × (mgmtFee / 10000) × durationYears`. Fees stored in basis points (1000 = 10%).

**DefiLlama mapping**: V1 + V2 + V3 → `yearn-finance`, Curation → `yearn-curating`. Retired vaults excluded from both.

**Pricing**: Weekly historical asset prices are cached in the `assetPrices` table via `fetch-historical-prices.ts` (sources from `coins.llama.fi/prices/historical`). `reprice-reports.ts` reads from this cache. `CHAIN_PREFIXES` in `packages/shared/src/pricing.ts` maps chainId → DL chain name.

**Chains supported**: Ethereum (1), Optimism (10), Polygon (137), Fantom (250), Base (8453), Arbitrum (42161), Gnosis (100), Katana (747474), Hyperliquid (999).

## Data Methodology

### Data sources

| Source | What it provides | Scripts |
|--------|-----------------|---------|
| Kong GraphQL API (`kong.yearn.fi/api/gql`) | V2/V3 vaults, TVL (`tvl.close`), strategies, debts, fee configs, harvest reports | `fetch-kong.ts`, `fetch-reports.ts` |
| DefiLlama Protocol API (`api.llama.fi/protocol/{slug}`) | Reference TVL for `yearn-finance` and `yearn-curating` protocols, per-chain breakdown | `fetch-defillama.ts` |
| DefiLlama Pricing API (`coins.llama.fi/prices`) | Current token prices (fallback for Kong zero-TVL vaults), weekly historical prices for asset cache | `fetch-kong.ts`, `fetch-v1-vaults.ts`, `fetch-historical-prices.ts` |
| Morpho Blue API (`blue-api.morpho.org/graphql`) | Curation vault discovery by owner/creator/curator address, totalAssetsUsd | `fetch-curation.ts` |
| On-chain RPC reads | V1 vault state (`getPricePerFullShare`, `totalSupply`), V2 fee rates, Turtle Club vault balances | `fetch-v1-vaults.ts`, `fetch-v2-fees.ts`, `fetch-curation.ts` |
| Velodrome/Aerodrome Sugar Oracle | LP token pricing on Optimism/Base when Kong returns zero | `fetch-kong.ts` (via `velo-oracle.ts`) |

### How TVL is calculated

1. **Snapshot collection**: Each fetcher stores a timestamped `vaultSnapshots` row with `tvlUsd`. Kong provides USD TVL directly (`tvl.close`); V1 and curation vaults are priced via on-chain reads + DefiLlama token prices.

2. **Aggregation**: The TVL service takes the latest snapshot per vault, groups by category (v1/v2/v3/curation) and chain, and sums.

3. **Overlap deduction**: Capital can flow vault → strategy → another vault, creating double-counts. Two detection methods:
   - *Auto*: If a strategy address equals a known vault address on the same chain, the strategy's `currentDebtUsd` is flagged as overlap.
   - *Registry*: `STRATEGY_OVERLAP_REGISTRY` lists intermediary contracts where strategy address ≠ target vault (discovered via `detect-overlaps.ts`).

4. **Final formula**: `totalTvl = v1Tvl + v2Tvl + v3Tvl + curationTvl - overlapAmount`

5. **Exclusions**: Retired vaults excluded from active totals. 9 vaults in `IGNORED_VAULTS` excluded entirely (bad data or DL blacklist).

### How fees are calculated

**Performance fees**: For each harvest report, `gainUsd × (performanceFee / 10000)`. Only positive gains count; losses are ignored.

**Management fees**: Time-weighted using weekly asset prices from `assetPrices` table. For each week between first and last harvest, computes `totalAssets × assetPrice × (mgmtFee / 10000) × weekDuration`. Falls back to `latestTvlUsd × rate × duration` if no cached prices available.

**Fee rates**: Stored in basis points (1000 = 10%). V2 defaults to 1000 perf / 0 mgmt if Kong has no data. Corrected by `fetch-v2-fees.ts` which reads actual on-chain rates.

### How reports are priced

Harvest reports record raw token `gain` amounts. USD conversion (`gainUsd`) follows a priority chain:

1. Kong's `gainUsd` — used if non-zero
2. Cached weekly asset price from `assetPrices` table (nearest within ±1 week of harvest timestamp) — populated by `fetch-historical-prices.ts`
3. Vault snapshot price (`tvlUsd / totalAssets`) — fallback for LP tokens not on DefiLlama
4. Cap at $500K per report — protects against corrupted Kong data (e.g. OHM-FRAXBP returning $4T)

### How DL comparison works

Our TVL is compared against DefiLlama's two protocol slugs:
- `yearn-finance` ↔ our V1 + V2 + V3 (minus overlap)
- `yearn-curating` ↔ our Curation

Per-chain and per-category deltas are computed. Automated notes flag alignment (<5% diff), large retired TVL (>$1M), overlap deductions, and curation gaps (missing Morpho vaults).

### Pricing fallback chain

When Kong returns `tvl.close = 0` but `totalAssets > 0`:
1. DefiLlama current price → `totalAssets / 10^decimals × price`
2. Velodrome/Aerodrome Sugar Oracle (Optimism/Base LP tokens only)
3. Previous snapshot TVL (if vault exists in DB)
4. Stablecoin assumption ($1/token for USDC/USDT/DAI/FRAX/LUSD) — curation vaults only

### Known limitations

- **Point-in-time only**: All TVL numbers are latest snapshots, not historical time-series.
- **Overlap deduction is conservative**: Only single-hop deduction (A→B), no cascade (A→B→C). Registry requires manual curation via `detect-overlaps.ts`.
- **Management fee uses latest totalAssets**: Time-weighted across weekly price changes, but `totalAssets` is from the latest snapshot (doesn't capture historical deposit/withdrawal changes).
- **Fee rates are latest-only**: Historical fee rate changes are not tracked; if a vault changed from 20% to 10% perf fee, all reports use the current 10%.
- **LP token repricing is imprecise**: Snapshot-based fallback uses current reserves, not historical composition.
- **Curation discovery is incomplete**: Morpho API queries by known owner/creator/curator addresses. Vaults from unknown curators or new factories won't appear until registry is updated.
- **V1 vaults are a fixed list**: 28 hard-coded addresses; new V1 vaults (unlikely) require manual addition.
- **DefiLlama comparison is approximate**: DL may use different double-count rules, include/exclude different vaults, or lag on updates.

## Environment

`.env` at project root. Never committed.

- `VITE_API_URL` — Production API URL for the dashboard (e.g. `https://yearn-metrics.fly.dev`). Not needed for local dev (Vite proxy handles it). Also set as a Vercel project env var.
- `DB_PATH` — Override SQLite path (default: `packages/db/yearn-tvl.db`). Set to `/data/yearn-tvl.db` on Fly.io.
- `ETH_RPC_URL` and `RPC_URI_FOR_{chainId}` — Per-chain RPCs. Required for V1 vaults, V2 fee reads, curation Turtle Club reads (viem).

## Conventions

- All imports use `.js` extensions (ESM with TypeScript)
- Workspace packages referenced as `workspace:*` in package.json
- Kong API URL: `https://kong.yearn.fi/api/gql` — GraphQL with `yearn: true` filter
- 9 vaults explicitly ignored in `IGNORED_VAULTS` (2 bad data + 7 DL blacklist)
- DB path is resolved relative to `packages/db/` directory via `import.meta.url`, not process CWD
