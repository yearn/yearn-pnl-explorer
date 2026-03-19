/**
 * Fee analysis service.
 * Calculates fee revenue from vault harvest reports combined with fee configs.
 * Performance fee revenue = gain × (performanceFee / 10000)
 * Management fee revenue is approximated from TVL × (managementFee / 10000) annualized.
 */
import { db, vaults, vaultSnapshots, feeConfigs, strategyReports, assetPrices } from "@yearn-tvl/db";
import { eq, and, sql, gte } from "drizzle-orm";
import type { VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES, toMondayNoon, YEAR_SECONDS, groupBy } from "@yearn-tvl/shared";
import { latestFeeConfigIds } from "./queries.js";

interface TimeWeightedMgmtFeeInput {
  totalAssetsRaw: string | null;
  assetAddress: string | null;
  assetDecimals: number;
  chainId: number;
  mgmtRate: number;
  firstTime: number;
  lastTime: number;
  latestTvlUsd: number;
  pricesByAsset: Map<string, { ts: number; price: number }[]>;
}

/**
 * Compute time-weighted management fee revenue using weekly asset prices.
 * Uses pre-loaded price data to avoid per-vault DB queries.
 */
const computeTimeWeightedMgmtFee = (input: TimeWeightedMgmtFeeInput): number => {
  const { totalAssetsRaw, assetAddress, assetDecimals, chainId, mgmtRate, firstTime, lastTime, latestTvlUsd, pricesByAsset } = input;
  if (mgmtRate <= 0 || lastTime <= firstTime) return 0;

  const simpleFee = () =>
    latestTvlUsd * (mgmtRate / 10000) * ((lastTime - firstTime) / YEAR_SECONDS);

  if (!assetAddress) return simpleFee();

  const totalAssets = totalAssetsRaw ? Number(BigInt(totalAssetsRaw)) : 0;
  if (totalAssets === 0) return simpleFee();

  const totalAssetsNorm = totalAssets / 10 ** assetDecimals;

  const key = `${chainId}:${assetAddress.toLowerCase()}`;
  const allPrices = pricesByAsset.get(key);
  if (!allPrices || allPrices.length === 0) return simpleFee();

  // Filter to the reporting period
  const startWeek = toMondayNoon(firstTime);
  const endWeek = toMondayNoon(lastTime);
  const weeklyPrices = allPrices.filter((p) => p.ts >= startWeek && p.ts <= endWeek);

  if (weeklyPrices.length < 2) return simpleFee();

  const totalMgmtFee = weeklyPrices.reduce((sum, wp, i) => {
    const weeklyTvl = totalAssetsNorm * wp.price;
    const segStart = Math.max(wp.ts, firstTime);
    const segEnd = i < weeklyPrices.length - 1
      ? Math.min(weeklyPrices[i + 1].ts, lastTime)
      : lastTime;
    return sum + weeklyTvl * (mgmtRate / 10000) * (Math.max(0, segEnd - segStart) / YEAR_SECONDS);
  }, 0);

  return totalMgmtFee;
};

/** Load all asset prices into memory, grouped by chainId:address, sorted by timestamp */
const loadPricesByAsset = async (): Promise<Map<string, { ts: number; price: number }[]>> => {
  const rows = await db
    .select({ chainId: assetPrices.chainId, address: assetPrices.address, priceUsd: assetPrices.priceUsd, timestamp: assetPrices.timestamp })
    .from(assetPrices);

  const grouped = groupBy(rows, (r) => `${r.chainId}:${r.address}`);
  const map = new Map<string, { ts: number; price: number }[]>();
  for (const [key, entries] of grouped) {
    map.set(key, entries.map((r) => ({ ts: r.timestamp, price: r.priceUsd })).sort((a, b) => a.ts - b.ts));
  }
  return map;
};

/** Load latest snapshot (tvlUsd + totalAssets) per vault in a single query */
const loadLatestSnapshots = async (): Promise<Map<number, { tvlUsd: number; totalAssets: string | null }>> => {
  const rows = await db
    .select({
      vaultId: vaultSnapshots.vaultId,
      tvlUsd: vaultSnapshots.tvlUsd,
      totalAssets: vaultSnapshots.totalAssets,
      id: vaultSnapshots.id,
    })
    .from(vaultSnapshots)
    .where(
      sql`${vaultSnapshots.id} IN (SELECT MAX(id) FROM ${vaultSnapshots} GROUP BY ${vaultSnapshots.vaultId})`,
    );

  return new Map(rows.map((r) => [r.vaultId, { tvlUsd: r.tvlUsd || 0, totalAssets: r.totalAssets }]));
};

interface VaultFeeDetail {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  tvlUsd: number;
  performanceFee: number;
  managementFee: number;
  totalGainUsd: number;
  totalLossUsd: number;
  performanceFeeRevenue: number;
  managementFeeRevenue: number;
  totalFeeRevenue: number;
  reportCount: number;
  lastReportTime: string | null;
}

interface FeeSummary {
  totalFeeRevenue: number;
  performanceFeeRevenue: number;
  managementFeeRevenue: number;
  totalGains: number;
  totalLosses: number;
  vaultCount: number;
  reportCount: number;
  byChain: Record<string, { feeRevenue: number; gains: number; vaultCount: number }>;
  byCategory: Record<string, { feeRevenue: number; gains: number; vaultCount: number }>;
}

/** Get fee summary across all active vaults */
export const getFeeSummary = async (since?: number): Promise<FeeSummary> => {
  const vaultFees = await getVaultFees(since);

  const totals = vaultFees.reduce(
    (acc, v) => ({
      totalFeeRevenue: acc.totalFeeRevenue + v.totalFeeRevenue,
      performanceFeeRevenue: acc.performanceFeeRevenue + v.performanceFeeRevenue,
      managementFeeRevenue: acc.managementFeeRevenue + v.managementFeeRevenue,
      totalGains: acc.totalGains + v.totalGainUsd,
      totalLosses: acc.totalLosses + v.totalLossUsd,
      reportCount: acc.reportCount + v.reportCount,
    }),
    { totalFeeRevenue: 0, performanceFeeRevenue: 0, managementFeeRevenue: 0, totalGains: 0, totalLosses: 0, reportCount: 0 },
  );

  const init = () => ({ feeRevenue: 0, gains: 0, vaultCount: 0 });
  const accumulate = (acc: ReturnType<typeof init>, v: VaultFeeDetail) => ({
    feeRevenue: acc.feeRevenue + v.totalFeeRevenue,
    gains: acc.gains + v.totalGainUsd,
    vaultCount: acc.vaultCount + 1,
  });

  const byChain = vaultFees.reduce((acc, v) => {
    const chainName = CHAIN_NAMES[v.chainId] || `Chain ${v.chainId}`;
    return { ...acc, [chainName]: accumulate(acc[chainName] ?? init(), v) };
  }, {} as Record<string, ReturnType<typeof init>>);

  const byCategory = vaultFees.reduce((acc, v) => {
    return { ...acc, [v.category]: accumulate(acc[v.category] ?? init(), v) };
  }, {} as Record<string, ReturnType<typeof init>>);

  return {
    ...totals,
    vaultCount: vaultFees.length,
    byChain,
    byCategory,
  };
};

/** Get per-vault fee breakdown */
export const getVaultFees = async (since?: number): Promise<VaultFeeDetail[]> => {
  const latestFees = latestFeeConfigIds();
  const vaultRows = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      assetAddress: vaults.assetAddress,
      assetDecimals: vaults.assetDecimals,
      performanceFee: feeConfigs.performanceFee,
      managementFee: feeConfigs.managementFee,
    })
    .from(vaults)
    .innerJoin(feeConfigs, eq(feeConfigs.vaultId, vaults.id))
    .innerJoin(latestFees, and(
      eq(feeConfigs.vaultId, latestFees.vaultId),
      eq(feeConfigs.id, latestFees.maxId),
    ))
    .where(eq(vaults.isRetired, false));

  // Batch-load all data upfront to avoid N+1 queries
  const reportQuery = db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
      totalLoss: sql<number>`COALESCE(SUM(${strategyReports.lossUsd}), 0)`,
      count: sql<number>`COUNT(*)`,
      firstReport: sql<number>`MIN(${strategyReports.blockTime})`,
      lastReport: sql<number>`MAX(${strategyReports.blockTime})`,
    })
    .from(strategyReports);
  const filtered = since
    ? reportQuery.where(gte(strategyReports.blockTime, since))
    : reportQuery;
  const reportAggs = await filtered.groupBy(strategyReports.vaultId);
  const reportMap = new Map(reportAggs.map((r) => [r.vaultId, r]));

  const [snapshots, pricesByAsset] = await Promise.all([
    loadLatestSnapshots(),
    loadPricesByAsset(),
  ]);

  const results: VaultFeeDetail[] = [];

  for (const vault of vaultRows) {
    const snapshot = snapshots.get(vault.id);
    const tvlUsd = snapshot?.tvlUsd || 0;

    const agg = reportMap.get(vault.id);
    const totalGain = agg?.totalGain || 0;
    const totalLoss = agg?.totalLoss || 0;
    const count = agg?.count || 0;

    const perfFee = vault.performanceFee || 0;
    const perfRevenue = totalGain * (perfFee / 10000);
    const mgmtFee = vault.managementFee || 0;

    const firstTime = agg?.firstReport || 0;
    const lastTime = agg?.lastReport || 0;

    const mgmtRevenue = mgmtFee > 0 && tvlUsd > 0 && count > 0 && lastTime > firstTime
      ? computeTimeWeightedMgmtFee({
          totalAssetsRaw: snapshot?.totalAssets ?? null,
          assetAddress: vault.assetAddress, assetDecimals: vault.assetDecimals || 18,
          chainId: vault.chainId, mgmtRate: mgmtFee, firstTime, lastTime,
          latestTvlUsd: tvlUsd, pricesByAsset,
        })
      : 0;

    if (count === 0 && perfFee === 0 && mgmtFee === 0) continue;

    results.push({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      category: vault.category as VaultCategory,
      tvlUsd,
      performanceFee: perfFee,
      managementFee: mgmtFee,
      totalGainUsd: totalGain,
      totalLossUsd: totalLoss,
      performanceFeeRevenue: perfRevenue,
      managementFeeRevenue: mgmtRevenue,
      totalFeeRevenue: perfRevenue + mgmtRevenue,
      reportCount: count,
      lastReportTime: agg?.lastReport
        ? new Date(agg.lastReport * 1000).toISOString()
        : null,
    });
  }

  return results.sort((a, b) => b.totalFeeRevenue - a.totalFeeRevenue);
};

interface FeeHistoryBucket {
  period: string;
  gains: number;
  losses: number;
  performanceFeeRevenue: number;
  reportCount: number;
}

const getPeriodKey = (blockTime: number, interval: "weekly" | "monthly"): string => {
  if (interval === "weekly") {
    return new Date(toMondayNoon(blockTime) * 1000).toISOString().slice(0, 10);
  }
  const date = new Date(blockTime * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Get fee revenue bucketed by time period (weekly or monthly) */
export const getFeeHistory = async (
  interval: "weekly" | "monthly" = "monthly",
): Promise<FeeHistoryBucket[]> => {
  const latestFees = latestFeeConfigIds();
  const feeRates = await db
    .select({ vaultId: feeConfigs.vaultId, performanceFee: feeConfigs.performanceFee })
    .from(feeConfigs)
    .innerJoin(latestFees, and(
      eq(feeConfigs.vaultId, latestFees.vaultId),
      eq(feeConfigs.id, latestFees.maxId),
    ));
  const rateMap = new Map(feeRates.map((r) => [r.vaultId, r.performanceFee || 0]));

  const reports = await db
    .select({
      vaultId: strategyReports.vaultId,
      gainUsd: strategyReports.gainUsd,
      lossUsd: strategyReports.lossUsd,
      blockTime: strategyReports.blockTime,
    })
    .from(strategyReports)
    .where(sql`${strategyReports.blockTime} IS NOT NULL`)
    .orderBy(strategyReports.blockTime);

  const buckets = reports
    .filter((r) => r.blockTime)
    .reduce((acc, r) => {
      const period = getPeriodKey(r.blockTime!, interval);
      const bucket = acc.get(period) || { period, gains: 0, losses: 0, performanceFeeRevenue: 0, reportCount: 0 };
      const gain = r.gainUsd || 0;
      const rate = rateMap.get(r.vaultId) || 0;
      acc.set(period, {
        ...bucket,
        gains: bucket.gains + gain,
        losses: bucket.losses + (r.lossUsd || 0),
        performanceFeeRevenue: bucket.performanceFeeRevenue + gain * (rate / 10000),
        reportCount: bucket.reportCount + 1,
      });
      return acc;
    }, new Map<string, FeeHistoryBucket>());

  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
};
