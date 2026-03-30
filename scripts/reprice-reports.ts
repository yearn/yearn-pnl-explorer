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
import { assetPrices, db, strategyReports, vaultSnapshots, vaults } from "@yearn-tvl/db";
import { MIN_BLOCK_TIMESTAMP, WEEK_SECONDS } from "@yearn-tvl/shared";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

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

  [...cache.values()].forEach((arr) => {
    arr.sort((a, b) => a.ts - b.ts);
  });

  return cache;
};

/** Find nearest price in a sorted array within ±1 week via binary search */
const findNearestPrice = (prices: { ts: number; price: number }[], timestamp: number): number => {
  if (prices.length === 0) return 0;

  // Binary search using recursive helper to find insertion point
  const bsearch = (lo: number, hi: number): number => {
    if (lo >= hi) return lo;
    const mid = (lo + hi) >> 1;
    return prices[mid].ts < timestamp ? bsearch(mid + 1, hi) : bsearch(lo, mid);
  };
  const idx = bsearch(0, prices.length - 1);

  const candidates = [prices[idx], ...(idx > 0 ? [prices[idx - 1]] : [])];
  const best = candidates.reduce((a, b) => (Math.abs(a.ts - timestamp) <= Math.abs(b.ts - timestamp) ? a : b));
  const bestDiff = Math.abs(best.ts - timestamp);

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

  const snapshotPriceCache = new Map<number, number>();

  // Prepare updates, then write in batched transactions
  // Sequential reduce because we need async snapshot price lookups that populate a shared cache
  const { pending, cachedPriced, snapshotPriced, failed, skipped } = await reports.reduce(
    async (accP, r) => {
      const acc = await accP;
      const info = vaultInfoCache.get(r.vaultId);
      if (!info || !r.gain) {
        acc.skipped++;
        return acc;
      }

      const cacheKey = `${info.chainId}:${info.assetAddress.toLowerCase()}`;
      const prices = priceCache.get(cacheKey);
      const cachedPrice = prices ? findNearestPrice(prices, r.blockTime!) : 0;
      const priceAndSource = await (async (): Promise<{ price: number; source: "defillama_historical" | "snapshot" | null }> => {
        if (cachedPrice > 0) return { price: cachedPrice, source: "defillama_historical" };
        if (!snapshotPriceCache.has(r.vaultId)) {
          snapshotPriceCache.set(r.vaultId, await getSnapshotTokenPrice(r.vaultId, info.assetDecimals));
        }
        const snapPrice = snapshotPriceCache.get(r.vaultId)!;
        return { price: snapPrice, source: snapPrice > 0 ? "snapshot" : null };
      })();

      if (!priceAndSource.price || priceAndSource.price === 0) {
        acc.failed++;
        return acc;
      }

      const rawGainUsd = rawToUsd(r.gain, info.assetDecimals, priceAndSource.price);
      const newGainUsd = rawGainUsd > MAX_GAIN_PER_REPORT ? 0 : rawGainUsd;

      acc.pending.push({ id: r.id, gainUsd: newGainUsd, source: priceAndSource.source });
      acc.cachedPriced += priceAndSource.source === "defillama_historical" ? 1 : 0;
      acc.snapshotPriced += priceAndSource.source === "snapshot" ? 1 : 0;
      return acc;
    },
    Promise.resolve({
      pending: [] as { id: number; gainUsd: number; source: string | null }[],
      cachedPriced: 0,
      snapshotPriced: 0,
      failed: 0,
      skipped: 0,
    }),
  );

  // Write in batched transactions for performance
  const batches = Array.from({ length: Math.ceil(pending.length / TX_BATCH_SIZE) }, (_, i) =>
    pending.slice(i * TX_BATCH_SIZE, (i + 1) * TX_BATCH_SIZE),
  );
  const updated = await batches.reduce(async (accP, batch, i) => {
    const acc = await accP;
    await db.transaction(async (tx) => {
      await Promise.all(
        batch.map((p) =>
          tx.update(strategyReports).set({ gainUsd: p.gainUsd, pricingSource: p.source }).where(eq(strategyReports.id, p.id)),
        ),
      );
    });
    const totalProcessed = acc + batch.length;
    process.stdout.write(
      `  ${Math.min((i + 1) * TX_BATCH_SIZE, pending.length)}/${pending.length}: ${totalProcessed} updated — ${cachedPriced} cached, ${snapshotPriced} snapshot\n`,
    );
    return totalProcessed;
  }, Promise.resolve(0));

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
