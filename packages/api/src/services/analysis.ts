/**
 * Phase 5: Dead TVL, retired vault, and depositor stickiness analysis.
 * Uses existing DB data to surface underperforming vaults and concentration risk.
 */
import { db, vaults, vaultSnapshots, feeConfigs, strategyReports, depositors } from "@yearn-tvl/db";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import type { VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES } from "@yearn-tvl/shared";

type Classification = "dead" | "low-yield" | "healthy";

interface DeadTvlVault {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  tvlUsd: number;
  gains365d: number;
  gainToTvlRatio: number;
  feeRevenue365d: number;
  classification: Classification;
  lastReportDate: string | null;
  reportCount365d: number;
}

interface DeadTvlResult {
  summary: {
    totalDeadTvl: number;
    totalLowYieldTvl: number;
    healthyTvl: number;
    deadVaultCount: number;
    lowYieldCount: number;
    healthyCount: number;
  };
  vaults: DeadTvlVault[];
}

interface RetiredVault {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  tvlUsd: number;
}

interface StickyTvlVault {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  tvlUsd: number;
  depositorCount: number;
  topDepositorPercent: number;
  isSingleDepositor: boolean;
}

interface DepositorEntry {
  address: string;
  balanceUsd: number;
  balance: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  percentOfVault: number;
}

/** Analyze dead and underperforming vaults based on recent strategy reports */
export async function getDeadTvlAnalysis(): Promise<DeadTvlResult> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 365 * 24 * 3600;

  // Get all active (non-retired) vaults with their latest snapshot
  const latestIds = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      maxId: sql<number>`MAX(${vaultSnapshots.id})`.as("max_id"),
    })
    .from(vaultSnapshots)
    .groupBy(vaultSnapshots.vaultId)
    .as("latest");

  const activeVaults = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      vaultType: vaults.vaultType,
      tvlUsd: vaultSnapshots.tvlUsd,
    })
    .from(vaults)
    .innerJoin(vaultSnapshots, eq(vaultSnapshots.vaultId, vaults.id))
    .innerJoin(latestIds, and(
      eq(vaultSnapshots.vaultId, latestIds.vaultId),
      eq(vaultSnapshots.id, latestIds.maxId),
    ))
    .where(eq(vaults.isRetired, false));

  const result: DeadTvlVault[] = [];

  for (const vault of activeVaults) {
    const tvlUsd = vault.tvlUsd ?? 0;
    if (tvlUsd <= 10_000) continue;

    // Skip vaults that inherently don't have harvest reports:
    // - Curation vaults (Morpho/Turtle Club) are not indexed by Kong
    // - V3 strategies (vaultType=2) receive allocations; reports live on the parent allocator
    if (vault.category === "curation" || vault.vaultType === 2) continue;

    // Aggregate strategy reports in last 365 days
    const [reportAgg] = await db
      .select({
        totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
        count: sql<number>`COUNT(*)`,
        lastReport: sql<number>`MAX(${strategyReports.blockTime})`,
      })
      .from(strategyReports)
      .where(and(
        eq(strategyReports.vaultId, vault.id),
        gte(strategyReports.blockTime, cutoff),
      ));

    const gains365d = reportAgg?.totalGain || 0;
    const reportCount365d = reportAgg?.count || 0;
    const hasRecentReport = reportCount365d > 0;
    const gainToTvlRatio = tvlUsd > 0 ? gains365d / tvlUsd : 0;

    // Get performance fee
    const [feeRow] = await db
      .select({ performanceFee: feeConfigs.performanceFee })
      .from(feeConfigs)
      .where(eq(feeConfigs.vaultId, vault.id))
      .orderBy(desc(feeConfigs.id))
      .limit(1);

    const performanceFee = feeRow?.performanceFee || 0;
    const feeRevenue365d = gains365d * (performanceFee / 10000);

    // Classify
    let classification: Classification;
    if (!hasRecentReport) {
      classification = "dead";
    } else if (gainToTvlRatio < 0.001) {
      classification = "low-yield";
    } else {
      classification = "healthy";
    }

    const lastReportDate = reportAgg?.lastReport
      ? new Date(reportAgg.lastReport * 1000).toISOString()
      : null;

    result.push({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      category: vault.category as VaultCategory,
      tvlUsd,
      gains365d,
      gainToTvlRatio,
      feeRevenue365d,
      classification,
      lastReportDate,
      reportCount365d,
    });
  }

  // Sort by TVL desc
  result.sort((a, b) => b.tvlUsd - a.tvlUsd);

  // Build summary
  let totalDeadTvl = 0;
  let totalLowYieldTvl = 0;
  let healthyTvl = 0;
  let deadVaultCount = 0;
  let lowYieldCount = 0;
  let healthyCount = 0;

  for (const v of result) {
    switch (v.classification) {
      case "dead":
        totalDeadTvl += v.tvlUsd;
        deadVaultCount++;
        break;
      case "low-yield":
        totalLowYieldTvl += v.tvlUsd;
        lowYieldCount++;
        break;
      case "healthy":
        healthyTvl += v.tvlUsd;
        healthyCount++;
        break;
    }
  }

  return {
    summary: {
      totalDeadTvl,
      totalLowYieldTvl,
      healthyTvl,
      deadVaultCount,
      lowYieldCount,
      healthyCount,
    },
    vaults: result,
  };
}

/** Find retired vaults that still hold TVL > 0 */
export async function getRetiredTvlAnalysis(): Promise<RetiredVault[]> {
  const latestIds = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      maxId: sql<number>`MAX(${vaultSnapshots.id})`.as("max_id"),
    })
    .from(vaultSnapshots)
    .groupBy(vaultSnapshots.vaultId)
    .as("latest");

  const rows = await db
    .select({
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      tvlUsd: vaultSnapshots.tvlUsd,
    })
    .from(vaults)
    .innerJoin(vaultSnapshots, eq(vaultSnapshots.vaultId, vaults.id))
    .innerJoin(latestIds, and(
      eq(vaultSnapshots.vaultId, latestIds.vaultId),
      eq(vaultSnapshots.id, latestIds.maxId),
    ))
    .where(eq(vaults.isRetired, true));

  return rows
    .filter((r) => (r.tvlUsd ?? 0) > 0)
    .map((r) => ({
      address: r.address,
      chainId: r.chainId,
      name: r.name,
      category: r.category as VaultCategory,
      tvlUsd: r.tvlUsd ?? 0,
    }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
}

/** Analyze depositor stickiness / concentration per vault */
export async function getStickyTvlAnalysis(): Promise<StickyTvlVault[]> {
  // Get depositor stats grouped by vault
  const vaultDepositorStats = await db
    .select({
      vaultId: depositors.vaultId,
      depositorCount: sql<number>`COUNT(DISTINCT ${depositors.address})`,
      totalBalanceUsd: sql<number>`COALESCE(SUM(${depositors.balanceUsd}), 0)`,
      maxBalanceUsd: sql<number>`COALESCE(MAX(${depositors.balanceUsd}), 0)`,
    })
    .from(depositors)
    .groupBy(depositors.vaultId);

  // Build a lookup
  const statsMap = new Map<number, typeof vaultDepositorStats[0]>();
  for (const s of vaultDepositorStats) {
    statsMap.set(s.vaultId, s);
  }

  // Get vault info with latest snapshot
  const latestIds = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      maxId: sql<number>`MAX(${vaultSnapshots.id})`.as("max_id"),
    })
    .from(vaultSnapshots)
    .groupBy(vaultSnapshots.vaultId)
    .as("latest");

  const vaultRows = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      tvlUsd: vaultSnapshots.tvlUsd,
    })
    .from(vaults)
    .innerJoin(vaultSnapshots, eq(vaultSnapshots.vaultId, vaults.id))
    .innerJoin(latestIds, and(
      eq(vaultSnapshots.vaultId, latestIds.vaultId),
      eq(vaultSnapshots.id, latestIds.maxId),
    ));

  const results: StickyTvlVault[] = [];

  for (const vault of vaultRows) {
    const stats = statsMap.get(vault.id);
    if (!stats) continue;

    const tvlUsd = vault.tvlUsd ?? 0;
    const totalBalance = stats.totalBalanceUsd || 0;
    const topDepositorPercent =
      totalBalance > 0 ? (stats.maxBalanceUsd / totalBalance) * 100 : 0;

    results.push({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      category: vault.category as VaultCategory,
      tvlUsd,
      depositorCount: stats.depositorCount,
      topDepositorPercent: Math.round(topDepositorPercent * 100) / 100,
      isSingleDepositor: stats.depositorCount === 1,
    });
  }

  return results.sort((a, b) => b.tvlUsd - a.tvlUsd);
}

/** Get depositor breakdown for a specific vault */
export async function getDepositorBreakdown(
  address: string,
  chainId: number,
): Promise<DepositorEntry[]> {
  // Find the vault
  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(
      eq(vaults.address, address),
      eq(vaults.chainId, chainId),
    ))
    .limit(1);

  if (!vault) return [];

  // Get all depositors for this vault
  const rows = await db
    .select({
      address: depositors.address,
      balanceUsd: depositors.balanceUsd,
      balance: depositors.balance,
      firstSeen: depositors.firstSeen,
      lastSeen: depositors.lastSeen,
    })
    .from(depositors)
    .where(eq(depositors.vaultId, vault.id));

  const totalUsd = rows.reduce((sum, r) => sum + (r.balanceUsd ?? 0), 0);

  return rows
    .map((r) => ({
      address: r.address,
      balanceUsd: r.balanceUsd ?? 0,
      balance: r.balance,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      percentOfVault: totalUsd > 0
        ? Math.round(((r.balanceUsd ?? 0) / totalUsd) * 10000) / 100
        : 0,
    }))
    .sort((a, b) => b.balanceUsd - a.balanceUsd);
}
