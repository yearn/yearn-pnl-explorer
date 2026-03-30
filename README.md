# Yearn PnL Explorer

`yearn-metrics` is currently the frontend shell for Yearn address-level holdings and PnL analysis.

The active product is a PnL-first dashboard in `packages/dashboard` that talks to the holdings backend in the separate [`yearn.fi`](../yearn.fi) repo. The dashboard does not implement PnL logic itself. It fetches compact portfolio data and on-demand drilldown data from the backend API.

## Current Scope

- Address-driven PnL lookup
- Portfolio summary cards
- 365d portfolio value chart
- Per-vault breakdown table
- On-demand drilldown for lots, realized entries, unknown transfers, unknown withdrawals, and journal timeline
- Accounting-quality warnings for partial / unknown basis

## Backend Contract

The dashboard currently consumes these routes from the `yearn.fi` holdings backend:

```text
GET /api/holdings/history?address=0x...
GET /api/holdings/pnl?address=0x...&version=all|v2|v3&unknownMode=strict|zero_basis|windfall&fetchType=seq|parallel&paginationMode=paged|all
GET /api/holdings/pnl/drilldown?address=0x...&vault=0x...&version=all|v2|v3&unknownMode=strict|zero_basis|windfall&fetchType=seq|parallel&paginationMode=paged|all
```

## Quick Start

1. Start the holdings backend from the `yearn.fi` repo on `http://localhost:3001`.
2. Start this dashboard:

```bash
bun install
bun run dev:dashboard
```

The dashboard runs on `http://localhost:5173` and proxies `/api/*` to `http://localhost:3001` by default.

If your backend is running somewhere else locally, set:

```bash
LOCAL_API_PROXY_TARGET=http://localhost:3001
```

For Vercel or other server-side deployments, set:

```bash
API_PROXY_TARGET=https://your-api-host
```

`API_PROXY_TARGET` is only read by the server-side proxy route in `packages/dashboard/api`, so it is not exposed to the client bundle.

## Useful Commands

```bash
bun run dev:dashboard         # Vite dashboard on :5173
bun run typecheck             # TypeScript across the repo
bun run lint                  # Biome check
bun run format                # Biome format
```

## Architecture

```text
yearn.fi holdings backend  --->  /api/holdings/*  --->  yearn-metrics dashboard
                                      ^
                                      |
                           Vite proxy in local dev
```

Relevant frontend entry points:

- `packages/dashboard/src/App.tsx`
- `packages/dashboard/src/panels/PnlPanel.tsx`
- `packages/dashboard/src/hooks.tsx`

## Notes On Legacy TVL Code

This repository still contains the older TVL stack:

- `packages/api`
- `packages/db`
- `packages/shared`
- `scripts/`

That code is legacy for the current product direction. The live dashboard no longer mounts the TVL views, and the PnL explorer does not depend on the SQLite seed pipeline in this repo.

So for normal PnL frontend work:

- you do not need `bun run seed`
- you do not need `bun run db:migrate`
- you do not need `bun run dev:api` from this repo

Those commands are only relevant if you are working on the historical TVL tooling that still lives here.

## Known Limitations

- Historical PnL attribution is not available yet. The history route returns portfolio value history, not realized/unrealized/windfall time series.
- Drilldown detail is fetched per vault family on demand, not preloaded for the whole address.
- This frontend includes compatibility normalization for both the legacy and renamed holdings response fields while backend contracts settle.

## License

Private.
