/**
 * Fee analysis service.
 * Calculates fee revenue from vault harvest reports combined with fee configs.
 * Performance fee revenue = gain × (performanceFee / 10000)
 * Management fee revenue is approximated from TVL × (managementFee / 10000) annualized.
 */
import { db, vaults, vaultSnapshots, feeConfigs, strategyReports } from "@yearn-tvl/db";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import type { VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES } from "@yearn-tvl/shared";

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
export async function getFeeSummary(since?: number): Promise<FeeSummary> {
  const vaultFees = await getVaultFees(since);

  let totalFeeRevenue = 0;
  let performanceFeeRevenue = 0;
  let managementFeeRevenue = 0;
  let totalGains = 0;
  let totalLosses = 0;
  let reportCount = 0;
  const byChain: Record<string, { feeRevenue: number; gains: number; vaultCount: number }> = {};
  const byCategory: Record<string, { feeRevenue: number; gains: number; vaultCount: number }> = {};

  for (const v of vaultFees) {
    totalFeeRevenue += v.totalFeeRevenue;
    performanceFeeRevenue += v.performanceFeeRevenue;
    managementFeeRevenue += v.managementFeeRevenue;
    totalGains += v.totalGainUsd;
    totalLosses += v.totalLossUsd;
    reportCount += v.reportCount;

    const chainName = CHAIN_NAMES[v.chainId] || `Chain ${v.chainId}`;
    if (!byChain[chainName]) byChain[chainName] = { feeRevenue: 0, gains: 0, vaultCount: 0 };
    byChain[chainName].feeRevenue += v.totalFeeRevenue;
    byChain[chainName].gains += v.totalGainUsd;
    byChain[chainName].vaultCount++;

    if (!byCategory[v.category]) byCategory[v.category] = { feeRevenue: 0, gains: 0, vaultCount: 0 };
    byCategory[v.category].feeRevenue += v.totalFeeRevenue;
    byCategory[v.category].gains += v.totalGainUsd;
    byCategory[v.category].vaultCount++;
  }

  return {
    totalFeeRevenue,
    performanceFeeRevenue,
    managementFeeRevenue,
    totalGains,
    totalLosses,
    vaultCount: vaultFees.length,
    reportCount,
    byChain,
    byCategory,
  };
}

/** Get per-vault fee breakdown */
export async function getVaultFees(since?: number): Promise<VaultFeeDetail[]> {
  // Get all active vaults with fee configs
  const vaultRows = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      performanceFee: feeConfigs.performanceFee,
      managementFee: feeConfigs.managementFee,
    })
    .from(vaults)
    .innerJoin(feeConfigs, eq(feeConfigs.vaultId, vaults.id))
    .where(eq(vaults.isRetired, false));

  const results: VaultFeeDetail[] = [];

  for (const vault of vaultRows) {
    // Get latest TVL snapshot
    const [snapshot] = await db
      .select({ tvlUsd: vaultSnapshots.tvlUsd })
      .from(vaultSnapshots)
      .where(eq(vaultSnapshots.vaultId, vault.id))
      .orderBy(desc(vaultSnapshots.id))
      .limit(1);

    // Aggregate reports
    const conditions = [eq(strategyReports.vaultId, vault.id)];
    if (since) {
      conditions.push(gte(strategyReports.blockTime, since));
    }

    const [agg] = await db
      .select({
        totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
        totalLoss: sql<number>`COALESCE(SUM(${strategyReports.lossUsd}), 0)`,
        count: sql<number>`COUNT(*)`,
        lastReport: sql<number>`MAX(${strategyReports.blockTime})`,
      })
      .from(strategyReports)
      .where(and(...conditions));

    const totalGain = agg?.totalGain || 0;
    const totalLoss = agg?.totalLoss || 0;
    const count = agg?.count || 0;

    // Performance fee = gain × rate / 10000
    const perfFee = vault.performanceFee || 0;
    const perfRevenue = totalGain * (perfFee / 10000);

    // Management fee approximation:
    // Annual management fee on current TVL, prorated by time span of reports
    const mgmtFee = vault.managementFee || 0;
    const tvlUsd = snapshot?.tvlUsd || 0;
    let mgmtRevenue = 0;

    if (mgmtFee > 0 && tvlUsd > 0 && count > 0) {
      // Use report timespan to approximate — mgmt fee accrues on AUM over time
      const firstReport = await db
        .select({ blockTime: strategyReports.blockTime })
        .from(strategyReports)
        .where(eq(strategyReports.vaultId, vault.id))
        .orderBy(strategyReports.blockTime)
        .limit(1);

      const lastTime = agg?.lastReport || 0;
      const firstTime = firstReport[0]?.blockTime || lastTime;

      if (firstTime && lastTime && lastTime > firstTime) {
        const durationYears = (lastTime - Number(firstTime)) / (365.25 * 24 * 3600);
        mgmtRevenue = tvlUsd * (mgmtFee / 10000) * durationYears;
      }
    }

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
}

interface FeeHistoryBucket {
  period: string;
  gains: number;
  losses: number;
  performanceFeeRevenue: number;
  reportCount: number;
}

/** Get fee revenue bucketed by time period (weekly or monthly) */
export async function getFeeHistory(
  interval: "weekly" | "monthly" = "monthly",
): Promise<FeeHistoryBucket[]> {
  // Build a fee rate lookup: vaultId → performanceFee
  const feeRates = await db
    .select({ vaultId: feeConfigs.vaultId, performanceFee: feeConfigs.performanceFee })
    .from(feeConfigs);
  const rateMap = new Map<number, number>();
  for (const r of feeRates) rateMap.set(r.vaultId, r.performanceFee || 0);

  // Get all reports with blockTime
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

  const buckets = new Map<string, FeeHistoryBucket>();

  for (const r of reports) {
    if (!r.blockTime) continue;
    const date = new Date(r.blockTime * 1000);
    let period: string;
    if (interval === "weekly") {
      // ISO week: start of week (Monday)
      const day = date.getUTCDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(date);
      monday.setUTCDate(date.getUTCDate() - diff);
      period = monday.toISOString().slice(0, 10);
    } else {
      period = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    }

    if (!buckets.has(period)) {
      buckets.set(period, { period, gains: 0, losses: 0, performanceFeeRevenue: 0, reportCount: 0 });
    }
    const bucket = buckets.get(period)!;
    const gain = r.gainUsd || 0;
    const loss = r.lossUsd || 0;
    const rate = rateMap.get(r.vaultId) || 0;

    bucket.gains += gain;
    bucket.losses += loss;
    bucket.performanceFeeRevenue += gain * (rate / 10000);
    bucket.reportCount++;
  }

  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}
