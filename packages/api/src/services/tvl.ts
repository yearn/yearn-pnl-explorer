/**
 * TVL calculation engine.
 * Aggregates vault snapshots, deducts double-counted overlap, produces metrics.
 * Separates active vs retired vault TVL for accurate DefiLlama comparison.
 */
import { db, vaults, vaultSnapshots, strategies, strategyDebts, tvlOverlap } from "@yearn-tvl/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type { TvlSummary, VaultTvl, OverlapDetail, VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES } from "@yearn-tvl/shared";

/** Get the latest snapshot for each vault */
async function getLatestSnapshots() {
  const latestIds = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      maxId: sql<number>`MAX(${vaultSnapshots.id})`.as("max_id"),
    })
    .from(vaultSnapshots)
    .groupBy(vaultSnapshots.vaultId)
    .as("latest");

  return db
    .select({ vault: vaults, snapshot: vaultSnapshots })
    .from(vaultSnapshots)
    .innerJoin(latestIds, and(
      eq(vaultSnapshots.vaultId, latestIds.vaultId),
      eq(vaultSnapshots.id, latestIds.maxId),
    ))
    .innerJoin(vaults, eq(vaultSnapshots.vaultId, vaults.id));
}

/** Detect allocator→strategy/vault overlap */
async function computeOverlap(): Promise<OverlapDetail[]> {
  const allVaults = await db.select({
    id: vaults.id,
    address: vaults.address,
    chainId: vaults.chainId,
    category: vaults.category,
    isRetired: vaults.isRetired,
  }).from(vaults);

  const vaultByAddress = new Map<string, typeof allVaults[0]>();
  for (const v of allVaults) {
    vaultByAddress.set(`${v.chainId}:${v.address.toLowerCase()}`, v);
  }

  const allocatorVaults = await db.select({
    id: vaults.id,
    address: vaults.address,
    chainId: vaults.chainId,
    category: vaults.category,
    isRetired: vaults.isRetired,
  }).from(vaults).where(eq(vaults.vaultType, 1));

  const overlaps: OverlapDetail[] = [];

  for (const allocator of allocatorVaults) {
    if (allocator.isRetired) continue; // Skip retired allocators

    const vaultStrategies = await db.select().from(strategies).where(eq(strategies.vaultId, allocator.id));

    for (const strat of vaultStrategies) {
      const targetVault = vaultByAddress.get(`${allocator.chainId}:${strat.address.toLowerCase()}`);
      if (!targetVault) continue;

      const [latestDebt] = await db
        .select()
        .from(strategyDebts)
        .where(eq(strategyDebts.strategyId, strat.id))
        .orderBy(desc(strategyDebts.id))
        .limit(1);

      if (!latestDebt?.currentDebtUsd || latestDebt.currentDebtUsd <= 0) continue;

      overlaps.push({
        sourceVault: allocator.address,
        targetVault: targetVault.address,
        strategyAddress: strat.address,
        overlapUsd: latestDebt.currentDebtUsd,
        sourceCategory: allocator.category as VaultCategory,
        targetCategory: targetVault.category as VaultCategory,
      });
    }
  }

  return overlaps;
}

export async function calculateTvl(): Promise<TvlSummary> {
  const snapshots = await getLatestSnapshots();
  const overlaps = await computeOverlap();

  const totalOverlap = overlaps.reduce((sum, o) => sum + o.overlapUsd, 0);

  // Aggregate — separate active vs retired
  const tvlByCategory: Record<VaultCategory, number> = { v1: 0, v2: 0, v3: 0, curation: 0 };
  const retiredTvlByCategory: Record<VaultCategory, number> = { v1: 0, v2: 0, v3: 0, curation: 0 };
  const tvlByChain: Record<string, number> = {};
  const vaultCount = { total: 0, v1: 0, v2: 0, v3: 0, curation: 0, active: 0, retired: 0 };

  for (const { vault, snapshot } of snapshots) {
    const tvl = snapshot.tvlUsd ?? 0;
    const cat = vault.category as VaultCategory;
    const chainName = CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`;

    vaultCount.total++;
    vaultCount[cat]++;

    if (vault.isRetired) {
      vaultCount.retired++;
      retiredTvlByCategory[cat] += tvl;
    } else {
      vaultCount.active++;
      tvlByCategory[cat] += tvl;
      tvlByChain[chainName] = (tvlByChain[chainName] || 0) + tvl;
    }
  }

  const activeRaw = tvlByCategory.v1 + tvlByCategory.v2 + tvlByCategory.v3 + tvlByCategory.curation;
  const retiredRaw = retiredTvlByCategory.v1 + retiredTvlByCategory.v2 + retiredTvlByCategory.v3 + retiredTvlByCategory.curation;

  return {
    totalTvl: activeRaw - totalOverlap,
    v1Tvl: tvlByCategory.v1,
    v2Tvl: tvlByCategory.v2,
    v3Tvl: tvlByCategory.v3,
    curationTvl: tvlByCategory.curation,
    overlapAmount: totalOverlap,
    tvlByChain,
    tvlByCategory,
    vaultCount,
  };
}

export async function getVaultTvls(filters?: {
  chainId?: number;
  category?: VaultCategory;
  vaultType?: number;
  includeRetired?: boolean;
}): Promise<VaultTvl[]> {
  const snapshots = await getLatestSnapshots();

  return snapshots
    .filter(({ vault }) => {
      if (!filters?.includeRetired && vault.isRetired) return false;
      if (filters?.chainId && vault.chainId !== filters.chainId) return false;
      if (filters?.category && vault.category !== filters.category) return false;
      if (filters?.vaultType && vault.vaultType !== filters.vaultType) return false;
      return true;
    })
    .map(({ vault, snapshot }) => ({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      category: vault.category as VaultCategory,
      vaultType: vault.vaultType,
      tvlUsd: snapshot.tvlUsd ?? 0,
      isRetired: vault.isRetired ?? false,
    }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
}

export async function getOverlapDetails(): Promise<OverlapDetail[]> {
  return computeOverlap();
}
