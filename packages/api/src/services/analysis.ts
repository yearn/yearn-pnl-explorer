/**
 * Phase 5: Dead TVL, retired vault, and depositor stickiness analysis.
 * Uses existing DB data to surface underperforming vaults and concentration risk.
 */
import { db, depositors, feeConfigs, strategyReports, vaultSnapshots, vaults } from "@yearn-tvl/db";
import type { VaultCategory } from "@yearn-tvl/shared";
import { toMap } from "@yearn-tvl/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import { isAnalysisEligible, latestFeeConfigIds, latestSnapshotIds } from "./queries.js";

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

const classify = (hasRecentReport: boolean, gainToTvlRatio: number): Classification => {
  if (!hasRecentReport) return "dead";
  if (gainToTvlRatio < 0.001) return "low-yield";
  return "healthy";
};

/** Analyze dead and underperforming vaults based on recent strategy reports */
export const getDeadTvlAnalysis = async (chainId?: number): Promise<DeadTvlResult> => {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 365 * 24 * 3600;

  // Get all active (non-retired) vaults with their latest snapshot
  const latestIds = latestSnapshotIds();

  const conditions = [eq(vaults.isRetired, false)];
  if (chainId) conditions.push(eq(vaults.chainId, chainId));

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
    .innerJoin(latestIds, and(eq(vaultSnapshots.vaultId, latestIds.vaultId), eq(vaultSnapshots.id, latestIds.maxId)))
    .where(and(...conditions));

  // Batch-load report aggregates for all vaults (last 365d)
  const reportAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
      count: sql<number>`COUNT(*)`,
      lastReport: sql<number>`MAX(${strategyReports.blockTime})`,
    })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, cutoff))
    .groupBy(strategyReports.vaultId);
  const reportMap = toMap(reportAggs, (r) => r.vaultId);

  // Batch-load latest fee configs
  const latestFees = latestFeeConfigIds();
  const feeRows = await db
    .select({ vaultId: feeConfigs.vaultId, performanceFee: feeConfigs.performanceFee })
    .from(feeConfigs)
    .innerJoin(latestFees, and(eq(feeConfigs.vaultId, latestFees.vaultId), eq(feeConfigs.id, latestFees.maxId)));
  const feeMap = toMap(
    feeRows,
    (r) => r.vaultId,
    (r) => r.performanceFee || 0,
  );

  const result = activeVaults
    .map((vault) => {
      const tvlUsd = vault.tvlUsd ?? 0;
      if (!isAnalysisEligible(vault, tvlUsd)) return null;

      const reportAgg = reportMap.get(vault.id);
      const gains365d = reportAgg?.totalGain || 0;
      const reportCount365d = reportAgg?.count || 0;
      const gainToTvlRatio = tvlUsd > 0 ? gains365d / tvlUsd : 0;

      const classification = classify(reportCount365d > 0, gainToTvlRatio);

      return {
        address: vault.address,
        chainId: vault.chainId,
        name: vault.name,
        category: vault.category as VaultCategory,
        tvlUsd,
        gains365d,
        gainToTvlRatio,
        feeRevenue365d: gains365d * ((feeMap.get(vault.id) || 0) / 10000),
        classification,
        lastReportDate: reportAgg?.lastReport ? new Date(reportAgg.lastReport * 1000).toISOString() : null,
        reportCount365d,
      } satisfies DeadTvlVault;
    })
    .filter((v): v is DeadTvlVault => v !== null)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);

  const summary = result.reduce(
    (acc, v) => {
      switch (v.classification) {
        case "dead":
          return { ...acc, totalDeadTvl: acc.totalDeadTvl + v.tvlUsd, deadVaultCount: acc.deadVaultCount + 1 };
        case "low-yield":
          return { ...acc, totalLowYieldTvl: acc.totalLowYieldTvl + v.tvlUsd, lowYieldCount: acc.lowYieldCount + 1 };
        case "healthy":
          return { ...acc, healthyTvl: acc.healthyTvl + v.tvlUsd, healthyCount: acc.healthyCount + 1 };
        default:
          return acc;
      }
    },
    { totalDeadTvl: 0, totalLowYieldTvl: 0, healthyTvl: 0, deadVaultCount: 0, lowYieldCount: 0, healthyCount: 0 },
  );

  return { summary, vaults: result };
};

/** Find retired vaults that still hold TVL > 0 */
export const getRetiredTvlAnalysis = async (chainId?: number): Promise<RetiredVault[]> => {
  const latestIds = latestSnapshotIds();

  const conditions = [eq(vaults.isRetired, true)];
  if (chainId) conditions.push(eq(vaults.chainId, chainId));

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
    .innerJoin(latestIds, and(eq(vaultSnapshots.vaultId, latestIds.vaultId), eq(vaultSnapshots.id, latestIds.maxId)))
    .where(and(...conditions));

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
};

/** Analyze depositor stickiness / concentration per vault */
export const getStickyTvlAnalysis = async (chainId?: number): Promise<StickyTvlVault[]> => {
  const vaultDepositorStats = await db
    .select({
      vaultId: depositors.vaultId,
      depositorCount: sql<number>`COUNT(DISTINCT ${depositors.address})`,
      totalBalanceUsd: sql<number>`COALESCE(SUM(${depositors.balanceUsd}), 0)`,
      maxBalanceUsd: sql<number>`COALESCE(MAX(${depositors.balanceUsd}), 0)`,
    })
    .from(depositors)
    .groupBy(depositors.vaultId);

  const statsMap = new Map(vaultDepositorStats.map((s) => [s.vaultId, s]));

  const latestIds = latestSnapshotIds();

  const stickyQuery = db
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
    .innerJoin(latestIds, and(eq(vaultSnapshots.vaultId, latestIds.vaultId), eq(vaultSnapshots.id, latestIds.maxId)));

  const vaultRows = chainId ? await stickyQuery.where(eq(vaults.chainId, chainId)) : await stickyQuery;

  return vaultRows
    .filter((vault) => statsMap.has(vault.id))
    .map((vault) => {
      const stats = statsMap.get(vault.id)!;
      const totalBalance = stats.totalBalanceUsd || 0;
      const topDepositorPercent = totalBalance > 0 ? (stats.maxBalanceUsd / totalBalance) * 100 : 0;

      return {
        address: vault.address,
        chainId: vault.chainId,
        name: vault.name,
        category: vault.category as VaultCategory,
        tvlUsd: vault.tvlUsd ?? 0,
        depositorCount: stats.depositorCount,
        topDepositorPercent: Math.round(topDepositorPercent * 100) / 100,
        isSingleDepositor: stats.depositorCount === 1,
      };
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
};

// Whitelist of valid sort columns for vault depositors
const DEPOSITOR_SORT_COLUMNS = {
  balance: depositors.balance,
  balanceUsd: depositors.balanceUsd,
  firstSeen: depositors.firstSeen,
  lastSeen: depositors.lastSeen,
} as const;

export const VALID_DEPOSITOR_SORTS = Object.keys(DEPOSITOR_SORT_COLUMNS);
type DepositorSortKey = keyof typeof DEPOSITOR_SORT_COLUMNS;

interface VaultDepositorsOpts {
  sort?: string;
  order?: string;
  limit?: number;
}

/** Get paginated depositor list for a vault with safe sorting */
export const getVaultDepositors = async (
  address: string,
  chainId: number,
  opts: VaultDepositorsOpts = {},
): Promise<{ depositors: DepositorEntry[]; next: string | null }> => {
  const sortKey = opts.sort && opts.sort in DEPOSITOR_SORT_COLUMNS ? (opts.sort as DepositorSortKey) : "balanceUsd";
  const order = opts.order === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(1, opts.limit || 50), 100);

  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.address, address), eq(vaults.chainId, chainId)))
    .limit(1);

  if (!vault) return { depositors: [], next: null };

  const sortCol = DEPOSITOR_SORT_COLUMNS[sortKey];

  // Get total vault balance for accurate percentages (not just page total)
  const [totalRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${depositors.balanceUsd}), 0)` })
    .from(depositors)
    .where(eq(depositors.vaultId, vault.id));
  const vaultTotalUsd = totalRow?.total || 0;

  const rows = await db
    .select({
      address: depositors.address,
      balanceUsd: depositors.balanceUsd,
      balance: depositors.balance,
      firstSeen: depositors.firstSeen,
      lastSeen: depositors.lastSeen,
    })
    .from(depositors)
    .where(eq(depositors.vaultId, vault.id))
    .orderBy(order === "asc" ? sql`${sortCol} ASC` : sql`${sortCol} DESC`)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const entries: DepositorEntry[] = pageRows.map((r) => ({
    address: r.address,
    balanceUsd: r.balanceUsd ?? 0,
    balance: r.balance,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    percentOfVault: vaultTotalUsd > 0 ? Math.round(((r.balanceUsd ?? 0) / vaultTotalUsd) * 10000) / 100 : 0,
  }));

  return { depositors: entries, next: hasMore ? "true" : null };
};

interface UserVaultHolding {
  vaultAddress: string;
  vaultName: string | null;
  chainId: number;
  category: string;
  balanceUsd: number;
  balance: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Get all vault holdings for a specific user address */
export const getUserVaults = async (
  userAddress: string,
): Promise<{ address: string; totalBalanceUsd: number; holdings: UserVaultHolding[] }> => {
  const rows = await db
    .select({
      vaultId: depositors.vaultId,
      balanceUsd: depositors.balanceUsd,
      balance: depositors.balance,
      firstSeen: depositors.firstSeen,
      lastSeen: depositors.lastSeen,
      vaultAddress: vaults.address,
      vaultName: vaults.name,
      chainId: vaults.chainId,
      category: vaults.category,
    })
    .from(depositors)
    .innerJoin(vaults, eq(depositors.vaultId, vaults.id))
    .where(eq(depositors.address, userAddress.toLowerCase()));

  const holdings: UserVaultHolding[] = rows
    .map((r) => ({
      vaultAddress: r.vaultAddress,
      vaultName: r.vaultName,
      chainId: r.chainId,
      category: r.category,
      balanceUsd: r.balanceUsd ?? 0,
      balance: r.balance,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))
    .sort((a, b) => b.balanceUsd - a.balanceUsd);

  const totalBalanceUsd = holdings.reduce((sum, h) => sum + h.balanceUsd, 0);

  return { address: userAddress, totalBalanceUsd, holdings };
};
