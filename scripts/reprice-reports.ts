/**
 * Reprice strategy reports using historical token prices.
 *
 * Kong often returns gainUsd=0 despite having raw gain values.
 * This script reprices ALL reports with raw gains using:
 *   1. Historical price from a pluggable provider (default: DefiLlama)
 *   2. Fallback: vault snapshot price (TVL/totalAssets) when provider has no data
 *
 * To use a different pricing backend, swap the provider in main().
 */
import { db, vaults, vaultSnapshots, strategyReports } from "@yearn-tvl/db";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";
import { DefiLlamaPriceProvider, type HistoricalPriceProvider } from "@yearn-tvl/shared";

const DELAY_MS = 220; // rate limit for external API calls
const MAX_GAIN_PER_REPORT = 500_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getSnapshotTokenPrice(vaultId: number, decimals: number): Promise<number> {
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
}

function rawToUsd(rawGain: string, decimals: number, price: number): number {
  try {
    return (Number(BigInt(rawGain)) / 10 ** decimals) * price;
  } catch {
    return 0;
  }
}

export async function repriceReports(provider: HistoricalPriceProvider) {
  const reports = await db
    .select({
      id: strategyReports.id,
      vaultId: strategyReports.vaultId,
      gain: strategyReports.gain,
      gainUsd: strategyReports.gainUsd,
      blockTime: strategyReports.blockTime,
    })
    .from(strategyReports)
    .where(
      and(
        isNotNull(strategyReports.gain),
        sql`${strategyReports.gain} != '0'`,
        isNotNull(strategyReports.blockTime),
      ),
    );

  console.log(`Found ${reports.length} reports with raw gains to reprice\n`);

  // Build vault info cache
  const vaultInfoCache = new Map<number, { assetAddress: string; assetDecimals: number; chainId: number }>();
  const allVaults = await db
    .select({ id: vaults.id, assetAddress: vaults.assetAddress, assetDecimals: vaults.assetDecimals, chainId: vaults.chainId })
    .from(vaults)
    .where(eq(vaults.isRetired, false));

  for (const v of allVaults) {
    if (v.assetAddress) {
      vaultInfoCache.set(v.id, { assetAddress: v.assetAddress, assetDecimals: v.assetDecimals || 18, chainId: v.chainId });
    }
  }

  // Group reports by day (noon timestamp) for batching
  const byDay = new Map<number, typeof reports>();
  for (const r of reports) {
    if (!r.blockTime) continue;
    const dayTs = Math.floor(r.blockTime / 86400) * 86400 + 43200;
    if (!byDay.has(dayTs)) byDay.set(dayTs, []);
    byDay.get(dayTs)!.push(r);
  }

  const days = [...byDay.keys()].sort();
  console.log(`Grouped into ${days.length} unique days\n`);

  let updated = 0;
  let dlPriced = 0;
  let snapshotPriced = 0;
  let failed = 0;
  let skipped = 0;

  const snapshotPriceCache = new Map<number, number>();

  for (let i = 0; i < days.length; i++) {
    const dayTs = days[i];
    const dayReports = byDay.get(dayTs)!;

    // Collect unique assets needed for this day
    const assetsNeeded = new Map<string, { chainId: number; address: string }>();
    for (const r of dayReports) {
      const info = vaultInfoCache.get(r.vaultId);
      if (!info) continue;
      assetsNeeded.set(info.assetAddress.toLowerCase(), { chainId: info.chainId, address: info.assetAddress });
    }

    // Fetch historical prices via provider
    const prices = assetsNeeded.size > 0
      ? await provider.getPrices(dayTs, [...assetsNeeded.values()])
      : new Map<string, number>();

    if (assetsNeeded.size > 0) await sleep(DELAY_MS);

    // Reprice each report
    for (const r of dayReports) {
      const info = vaultInfoCache.get(r.vaultId);
      if (!info || !r.gain) { skipped++; continue; }

      const assetLower = info.assetAddress.toLowerCase();
      let price = prices.get(assetLower);
      let source: "provider" | "snapshot" | null = price ? "provider" : null;

      // Fall back to snapshot price
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

      await db.update(strategyReports).set({ gainUsd: newGainUsd }).where(eq(strategyReports.id, r.id));
      updated++;
      if (source === "provider") dlPriced++;
      else snapshotPriced++;
    }

    if ((i + 1) % 100 === 0 || i === days.length - 1) {
      const date = new Date(dayTs * 1000).toISOString().slice(0, 10);
      process.stdout.write(`  Day ${i + 1}/${days.length} (${date}): ${updated} updated, ${dlPriced} provider, ${snapshotPriced} snapshot\n`);
    }
  }

  console.log(`\nDone: ${updated} reports repriced`);
  console.log(`  Historical prices (provider): ${dlPriced}`);
  console.log(`  Snapshot fallback: ${snapshotPriced}`);
  console.log(`  Failed (no price): ${failed}`);
  console.log(`  Skipped (no vault info): ${skipped}`);

  return { updated, dlPriced, snapshotPriced, failed };
}

if (import.meta.main) {
  // Swap this to use your own pricing service when ready
  const provider = new DefiLlamaPriceProvider();
  const result = await repriceReports(provider);
  console.log("Result:", result);
}
