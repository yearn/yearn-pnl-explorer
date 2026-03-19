/**
 * Reprice strategy reports using historical token prices.
 *
 * Kong often returns gainUsd=0 despite having raw gain values.
 * This script reprices ALL reports with raw gains using:
 *   1. Cached weekly price from asset_prices table (populated by fetch-historical-prices.ts)
 *   2. Fallback: vault snapshot price (TVL/totalAssets) — for LP tokens not on DefiLlama
 *
 * Run fetch-historical-prices.ts first to populate the cache for best results.
 */
import { db, vaults, vaultSnapshots, strategyReports, assetPrices } from "@yearn-tvl/db";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";
import { WEEK_SECONDS, MIN_BLOCK_TIMESTAMP } from "@yearn-tvl/shared";

const MAX_GAIN_PER_REPORT = 500_000;
const TX_BATCH_SIZE = 2000;

/** Load all asset prices into memory, keyed by chainId:address */
const buildPriceCache = async (): Promise<Map<string, { ts: number; price: number }[]>> => {
  const allPrices = await db
    .select({
      chainId: assetPrices.chainId,
      address: assetPrices.address,
      priceUsd: assetPrices.priceUsd,
      timestamp: assetPrices.timestamp,
    })
    .from(assetPrices);

  const cache = allPrices.reduce((acc, row) => {
    const key = `${row.chainId}:${row.address.toLowerCase()}`;
    const arr = acc.get(key) ?? [];
    arr.push({ ts: row.timestamp, price: row.priceUsd });
    return acc.set(key, arr);
  }, new Map<string, { ts: number; price: number }[]>());

  for (const arr of cache.values()) {
    arr.sort((a, b) => a.ts - b.ts);
  }

  return cache;
};

/** Find nearest price in a sorted array within ±1 week via binary search */
const findNearestPrice = (
  prices: { ts: number; price: number }[],
  timestamp: number,
): number => {
  if (prices.length === 0) return 0;

  let lo = 0;
  let hi = prices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].ts < timestamp) lo = mid + 1;
    else hi = mid;
  }

  let best = prices[lo];
  let bestDiff = Math.abs(best.ts - timestamp);
  if (lo > 0) {
    const diff = Math.abs(prices[lo - 1].ts - timestamp);
    if (diff < bestDiff) {
      best = prices[lo - 1];
      bestDiff = diff;
    }
  }

  return bestDiff <= WEEK_SECONDS ? best.price : 0;
};

const getSnapshotTokenPrice = async (vaultId: number, decimals: number): Promise<number> => {
  const [snap] = await db
    .select({ tvlUsd: vaultSnapshots.tvlUsd, totalAssets: vaultSnapshots.totalAssets })
    .from(vaultSnapshots)
    .where(eq(vaultSnapshots.vaultId, vaultId))
    .orderBy(desc(vaultSnapshots.id))
    .limit(1);

  if (!snap?.tvlUsd || !snap?.totalAssets) return 0;
  const totalAssets = Number(snap.totalAssets);
  if (totalAssets === 0) return 0;
  return snap.tvlUsd / (totalAssets / 10 ** decimals);
};

const rawToUsd = (rawGain: string, decimals: number, price: number): number => {
  try {
    return (Number(BigInt(rawGain)) / 10 ** decimals) * price;
  } catch {
    return 0;
  }
};

export const repriceReports = async () => {
  const reports = await db
    .select({
      id: strategyReports.id,
      vaultId: strategyReports.vaultId,
      gain: strategyReports.gain,
      blockTime: strategyReports.blockTime,
    })
    .from(strategyReports)
    .where(
      and(
        isNotNull(strategyReports.gain),
        sql`${strategyReports.gain} != '0'`,
        isNotNull(strategyReports.blockTime),
        sql`${strategyReports.blockTime} >= ${MIN_BLOCK_TIMESTAMP}`,
      ),
    );

  console.log(`Found ${reports.length} reports with raw gains to reprice\n`);

  // Build vault info cache
  const allVaults = await db
    .select({ id: vaults.id, assetAddress: vaults.assetAddress, assetDecimals: vaults.assetDecimals, chainId: vaults.chainId })
    .from(vaults);

  const vaultInfoCache = new Map(
    allVaults
      .filter((v): v is typeof v & { assetAddress: string } => !!v.assetAddress)
      .map((v) => [v.id, { assetAddress: v.assetAddress, assetDecimals: v.assetDecimals || 18, chainId: v.chainId }] as const),
  );

  // Load the full price cache into memory
  console.log("Loading asset price cache...");
  const priceCache = await buildPriceCache();
  const cacheSize = [...priceCache.values()].reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Loaded ${cacheSize} cached prices for ${priceCache.size} assets\n`);

  let updated = 0;
  let cachedPriced = 0;
  let snapshotPriced = 0;
  let failed = 0;
  let skipped = 0;
  const snapshotPriceCache = new Map<number, number>();

  // Prepare updates, then write in batched transactions
  const pending: { id: number; gainUsd: number; source: string | null }[] = [];

  for (const r of reports) {
    const info = vaultInfoCache.get(r.vaultId);
    if (!info || !r.gain) { skipped++; continue; }

    const cacheKey = `${info.chainId}:${info.assetAddress.toLowerCase()}`;
    const prices = priceCache.get(cacheKey);
    let price = prices ? findNearestPrice(prices, r.blockTime!) : 0;
    let source: "defillama_historical" | "snapshot" | null = price > 0 ? "defillama_historical" : null;

    if (!price) {
      if (!snapshotPriceCache.has(r.vaultId)) {
        snapshotPriceCache.set(r.vaultId, await getSnapshotTokenPrice(r.vaultId, info.assetDecimals));
      }
      price = snapshotPriceCache.get(r.vaultId)!;
      source = price > 0 ? "snapshot" : null;
    }

    if (!price || price === 0) { failed++; continue; }

    let newGainUsd = rawToUsd(r.gain, info.assetDecimals, price);
    if (newGainUsd > MAX_GAIN_PER_REPORT) newGainUsd = 0;

    pending.push({ id: r.id, gainUsd: newGainUsd, source });
    if (source === "defillama_historical") cachedPriced++;
    else snapshotPriced++;
  }

  // Write in batched transactions for performance
  for (let start = 0; start < pending.length; start += TX_BATCH_SIZE) {
    const batch = pending.slice(start, start + TX_BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const p of batch) {
        await tx.update(strategyReports)
          .set({ gainUsd: p.gainUsd, pricingSource: p.source })
          .where(eq(strategyReports.id, p.id));
      }
    });
    updated += batch.length;
    process.stdout.write(
      `  ${Math.min(start + TX_BATCH_SIZE, pending.length)}/${pending.length}: ${updated} updated — ${cachedPriced} cached, ${snapshotPriced} snapshot\n`,
    );
  }

  console.log(`\nDone: ${updated} reports repriced`);
  console.log(`  Cached price (asset_prices): ${cachedPriced}`);
  console.log(`  Snapshot fallback: ${snapshotPriced}`);
  console.log(`  Failed (no price): ${failed}`);
  console.log(`  Skipped (no vault info): ${skipped}`);

  return { updated, cachedPriced, snapshotPriced, failed };
};

if (import.meta.main) {
  const result = await repriceReports();
  console.log("Result:", result);
}
