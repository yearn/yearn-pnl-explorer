/**
 * Fetch weekly historical asset prices from DefiLlama.
 *
 * For every unique (chainId, assetAddress) pair in the vaults table, fetches
 * the USD price at weekly intervals (Monday noon UTC) from the earliest report
 * blockTime to now. Stores in the asset_prices table and skips weeks that
 * already exist.
 *
 * This price cache is used by:
 *   - reprice-reports.ts (accurate historical gainUsd)
 *   - fees.ts (time-weighted TVL for management fees)
 */
import { assetPrices, db, strategyReports, vaults } from "@yearn-tvl/db";
import { CHAIN_PREFIXES, MIN_BLOCK_TIMESTAMP, weeklyTimestamps } from "@yearn-tvl/shared";
import { gte, isNotNull, sql } from "drizzle-orm";

const DELAY_MS = 250;
const BATCH_SIZE = 80; // DL handles ~100 coins per call, stay under

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AssetInfo {
  chainId: number;
  address: string;
  symbol: string | null;
}

/** Get all unique assets from the vaults table */
const getUniqueAssets = async (): Promise<AssetInfo[]> => {
  const rows = await db
    .select({
      chainId: vaults.chainId,
      address: vaults.assetAddress,
      symbol: vaults.assetSymbol,
    })
    .from(vaults)
    .where(isNotNull(vaults.assetAddress));

  const deduped = new Map(
    rows
      .filter((row): row is typeof row & { address: string } => !!row.address && !!CHAIN_PREFIXES[row.chainId])
      .map((row) => [`${row.chainId}:${row.address.toLowerCase()}`, { chainId: row.chainId, address: row.address, symbol: row.symbol }]),
  );
  return [...deduped.values()];
};

/** Get the earliest report blockTime (post-2020) */
const getEarliestReportTime = async (): Promise<number> => {
  const [row] = await db
    .select({ earliest: sql<number>`MIN(${strategyReports.blockTime})` })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, MIN_BLOCK_TIMESTAMP));
  return row?.earliest || MIN_BLOCK_TIMESTAMP;
};

/** Load all existing asset price timestamps in one query, grouped by asset key */
const getAllExistingTimestamps = async (): Promise<Map<string, Set<number>>> => {
  const rows = await db
    .select({ chainId: assetPrices.chainId, address: assetPrices.address, timestamp: assetPrices.timestamp })
    .from(assetPrices);

  return rows.reduce((acc, row) => {
    const key = `${row.chainId}:${row.address}`;
    const existing = acc.get(key) ?? new Set<number>();
    existing.add(row.timestamp);
    return acc.set(key, existing);
  }, new Map<string, Set<number>>());
};

/** Batch-fetch prices from DefiLlama for multiple assets at a single timestamp */
const fetchPricesFromDL = async (timestamp: number, assets: AssetInfo[]): Promise<Map<string, number>> => {
  const coinKeys = assets
    .map((a) => {
      const prefix = CHAIN_PREFIXES[a.chainId];
      return prefix ? `${prefix}:${a.address}` : null;
    })
    .filter(Boolean)
    .join(",");

  if (!coinKeys) return new Map();

  try {
    const url = `https://coins.llama.fi/prices/historical/${timestamp}/${coinKeys}?searchWidth=6h`;
    const res = await fetch(url);
    if (!res.ok) return new Map();

    const data = (await res.json()) as {
      coins: Record<string, { price: number }>;
    };

    const prices = Object.entries(data.coins).reduce((acc, [key, info]) => {
      if (info.price > 0) {
        acc.set(key.toLowerCase(), info.price);
      }
      return acc;
    }, new Map<string, number>());
    return prices;
  } catch {
    return new Map();
  }
};

export const fetchHistoricalPrices = async () => {
  console.log("Fetching unique assets from vaults...");
  const assets = await getUniqueAssets();
  console.log(`Found ${assets.length} unique assets across supported chains\n`);

  const earliestReport = await getEarliestReportTime();
  const now = Math.floor(Date.now() / 1000);
  const weeks = weeklyTimestamps(earliestReport, now);
  console.log(
    `Date range: ${new Date(earliestReport * 1000).toISOString().slice(0, 10)} → ${new Date(now * 1000).toISOString().slice(0, 10)}`,
  );
  console.log(`${weeks.length} weekly timestamps to check\n`);

  // Build lookup for what we already have (single query)
  console.log("Checking existing price data...");
  const existingByAsset = await getAllExistingTimestamps();
  // Ensure all assets have an entry (even if empty)
  assets.forEach((asset) => {
    const key = `${asset.chainId}:${asset.address.toLowerCase()}`;
    if (!existingByAsset.has(key)) existingByAsset.set(key, new Set());
  });

  // Skip assets that DL has never priced (LP tokens, exotic assets)
  // If we have >10 weeks of history and 0 cached prices, DL can't price this asset
  const minWeeksForSkip = Math.min(10, weeks.length);
  const pricableAssets = assets.filter((a) => {
    const key = `${a.chainId}:${a.address.toLowerCase()}`;
    const existing = existingByAsset.get(key)!;
    if (existing.size > 0) return true; // has some prices — keep
    // First run: no data yet, try everything
    // Re-run: if we have 0 prices after trying many weeks, skip
    return weeks.length <= minWeeksForSkip;
  });
  const skippedAssets = assets.length - pricableAssets.length;
  if (skippedAssets > 0) {
    console.log(`Skipping ${skippedAssets} assets with no DL coverage (LP tokens, etc.)\n`);
  }

  // For assets with existing prices, only fetch weeks AFTER the latest cached week.
  // Historical gaps are permanent DL limitations — don't retry them.
  // For new assets (no cached prices), fetch from the beginning.
  const assetFetchAfter = new Map(
    pricableAssets
      .map((asset) => {
        const key = `${asset.chainId}:${asset.address.toLowerCase()}`;
        const existing = existingByAsset.get(key)!;
        return existing.size > 0 ? ([key, Math.max(...existing)] as const) : null;
      })
      .filter((entry): entry is [string, number] => entry !== null),
  );

  // Count how many we need to fetch
  const totalNeeded = pricableAssets.reduce((sum, asset) => {
    const key = `${asset.chainId}:${asset.address.toLowerCase()}`;
    const existing = existingByAsset.get(key)!;
    const fetchAfter = assetFetchAfter.get(key) || 0;
    return sum + weeks.filter((w) => !existing.has(w) && w > fetchAfter).length;
  }, 0);
  const cached = [...existingByAsset.values()].reduce((sum, s) => sum + s.size, 0);
  console.log(`Need to fetch ${totalNeeded} new price points (${cached} already cached)\n`);

  if (totalNeeded === 0) {
    console.log("All prices already cached!");
    return { fetched: 0, stored: 0, failed: 0 };
  }

  // Process week by week, batching assets per DL call
  const { stored, failed, apiCalls } = await weeks.reduce(
    async (accP, weekTs, wi) => {
      const acc = await accP;

      // Collect pricable assets that need pricing for this week
      const needed = pricableAssets.filter((a) => {
        const key = `${a.chainId}:${a.address.toLowerCase()}`;
        if (existingByAsset.get(key)!.has(weekTs)) return false;
        const fetchAfter = assetFetchAfter.get(key);
        if (fetchAfter && weekTs <= fetchAfter) return false; // already covered or gap
        return true;
      });

      if (needed.length === 0) return acc;

      // Batch into groups of BATCH_SIZE
      const batches = Array.from({ length: Math.ceil(needed.length / BATCH_SIZE) }, (_, i) =>
        needed.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
      );

      const batchResult = await batches.reduce(
        async (batchAccP, batch) => {
          const batchAcc = await batchAccP;
          const prices = await fetchPricesFromDL(weekTs, batch);

          // Store results
          const { rows, batchFailed } = batch.reduce(
            (rowAcc, asset) => {
              const prefix = CHAIN_PREFIXES[asset.chainId];
              const dlKey = `${prefix}:${asset.address}`.toLowerCase();
              const price = prices.get(dlKey);
              if (price && price > 0) {
                return {
                  rows: [
                    ...rowAcc.rows,
                    {
                      chainId: asset.chainId,
                      address: asset.address.toLowerCase(),
                      symbol: asset.symbol,
                      priceUsd: price,
                      timestamp: weekTs,
                    },
                  ],
                  batchFailed: rowAcc.batchFailed,
                };
              }
              return { rows: rowAcc.rows, batchFailed: rowAcc.batchFailed + 1 };
            },
            {
              rows: [] as { chainId: number; address: string; symbol: string | null; priceUsd: number; timestamp: number }[],
              batchFailed: 0,
            },
          );

          if (rows.length > 0) {
            await db.insert(assetPrices).values(rows);
          }

          await sleep(DELAY_MS);

          return {
            stored: batchAcc.stored + rows.length,
            failed: batchAcc.failed + batchFailed,
            apiCalls: batchAcc.apiCalls + 1,
          };
        },
        Promise.resolve({ stored: acc.stored, failed: acc.failed, apiCalls: acc.apiCalls }),
      );

      if ((wi + 1) % 10 === 0 || wi === weeks.length - 1) {
        const date = new Date(weekTs * 1000).toISOString().slice(0, 10);
        process.stdout.write(
          `  Week ${wi + 1}/${weeks.length} (${date}): ${batchResult.stored} stored, ${batchResult.failed} failed, ${batchResult.apiCalls} API calls\n`,
        );
      }

      return batchResult;
    },
    Promise.resolve({ stored: 0, failed: 0, apiCalls: 0 }),
  );

  console.log(`\nDone: ${stored} prices stored, ${failed} unavailable, ${apiCalls} API calls`);
  return { fetched: apiCalls, stored, failed };
};

if (import.meta.main) {
  const result = await fetchHistoricalPrices();
  console.log("Result:", result);
}
