/**
 * TVL calculation engine.
 * Aggregates vault snapshots, deducts double-counted overlap, produces metrics.
 * Includes retired vault TVL in totals (matching DefiLlama behavior — DL counts
 * any vault with positive on-chain TVL regardless of retirement status).
 */
import { db, strategies, strategyDebts, vaults } from "@yearn-tvl/db";
import type { OverlapDetail, TvlSummary, VaultCategory, VaultTvl } from "@yearn-tvl/shared";
import { CHAIN_NAMES, CROSS_CHAIN_OVERLAP_REGISTRY, groupBy, STRATEGY_OVERLAP_REGISTRY, toMap } from "@yearn-tvl/shared";
import { and, eq, sql } from "drizzle-orm";
import { getLatestSnapshots } from "./queries.js";

/** Detect vault→vault overlap (auto + registry-based) */
export const computeOverlap = async (): Promise<OverlapDetail[]> => {
  const allVaults = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      category: vaults.category,
      isRetired: vaults.isRetired,
    })
    .from(vaults);

  const vaultByAddress = new Map(allVaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));

  // Preload all strategies and group by vault
  const allStrategies = await db.select().from(strategies);
  const strategiesByVault = groupBy(allStrategies, (s) => s.vaultId);

  // Preload latest debt per strategy in a single query
  const latestDebtSub = db
    .select({
      strategyId: strategyDebts.strategyId,
      maxId: sql<number>`MAX(${strategyDebts.id})`.as("max_id"),
    })
    .from(strategyDebts)
    .groupBy(strategyDebts.strategyId)
    .as("latest_debts");

  const allDebts = await db
    .select({
      strategyId: strategyDebts.strategyId,
      currentDebtUsd: strategyDebts.currentDebtUsd,
    })
    .from(strategyDebts)
    .innerJoin(latestDebtSub, and(eq(strategyDebts.strategyId, latestDebtSub.strategyId), eq(strategyDebts.id, latestDebtSub.maxId)));
  const debtByStrategy = toMap(
    allDebts,
    (d) => d.strategyId,
    (d) => d.currentDebtUsd,
  );

  // Index strategies by chainId:address for registry lookups
  const strategyByAddr = toMap(allStrategies, (s) => `${s.chainId}:${s.address.toLowerCase()}`);

  // Auto-detection (all in-memory)
  const activeVaults = allVaults.filter((v) => !v.isRetired);

  const autoResults: OverlapDetail[] = activeVaults.flatMap((vault) =>
    (strategiesByVault.get(vault.id) ?? [])
      .map((strat) => {
        const targetVault = vaultByAddress.get(`${vault.chainId}:${strat.address.toLowerCase()}`);
        if (!targetVault) return null;

        const debtUsd = debtByStrategy.get(strat.id);
        if (!debtUsd || debtUsd <= 0) return null;

        return {
          sourceVault: vault.address,
          targetVault: targetVault.address,
          strategyAddress: strat.address,
          chainId: vault.chainId,
          overlapUsd: debtUsd,
          sourceCategory: vault.category as VaultCategory,
          targetCategory: targetVault.category as VaultCategory,
          detectionMethod: "auto" as const,
        } satisfies OverlapDetail;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
  );

  const autoDetectedStratKeys = new Set(autoResults.map((r) => `${r.chainId}:${r.strategyAddress.toLowerCase()}`));

  // Registry-based (all in-memory)
  const registryResults = STRATEGY_OVERLAP_REGISTRY.map((entry) => {
    const key = `${entry.chainId}:${entry.strategyAddress.toLowerCase()}`;
    if (autoDetectedStratKeys.has(key)) return null;

    const targetVault = vaultByAddress.get(`${entry.chainId}:${entry.targetVaultAddress.toLowerCase()}`);
    if (!targetVault) return null;

    const strat = strategyByAddr.get(key);
    if (!strat) return null;

    const debtUsd = debtByStrategy.get(strat.id);
    if (!debtUsd || debtUsd <= 0) return null;

    const sourceVault = allVaults.find((v) => v.id === strat.vaultId);
    if (!sourceVault) return null;

    return {
      sourceVault: sourceVault.address,
      targetVault: targetVault.address,
      strategyAddress: strat.address,
      chainId: entry.chainId,
      overlapUsd: debtUsd,
      sourceCategory: sourceVault.category as VaultCategory,
      targetCategory: targetVault.category as VaultCategory,
      detectionMethod: "registry" as const,
      label: entry.label,
    } satisfies OverlapDetail;
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  return [...autoResults, ...registryResults];
};

export const calculateTvl = async (): Promise<TvlSummary> => {
  const snapshots = await getLatestSnapshots();
  const overlaps = await computeOverlap();

  const totalOverlap = overlaps.reduce((sum, o) => sum + o.overlapUsd, 0);

  // Per-chain overlap (auto + registry)
  const overlapByChain = overlaps.reduce(
    (acc, o) => {
      const chainName = CHAIN_NAMES[o.chainId] || `Chain ${o.chainId}`;
      return { ...acc, [chainName]: (acc[chainName] || 0) + o.overlapUsd };
    },
    {} as Record<string, number>,
  );

  const initCat = (): Record<VaultCategory, number> => ({ v1: 0, v2: 0, v3: 0, curation: 0 });

  const agg = snapshots.reduce(
    (acc, { vault, snapshot }) => {
      const tvl = typeof snapshot.tvlUsd === "number" ? snapshot.tvlUsd : 0;
      const cat = vault.category as VaultCategory;
      const chainName = CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`;

      const counts = {
        ...acc.vaultCount,
        total: acc.vaultCount.total + 1,
        [cat]: acc.vaultCount[cat] + 1,
        ...(vault.isRetired ? { retired: acc.vaultCount.retired + 1 } : { active: acc.vaultCount.active + 1 }),
      };

      // Include ALL vaults in tvlByChain (active + retired).
      // DL counts any vault with on-chain TVL regardless of retirement status.
      const updatedChain = { ...acc.tvlByChain, [chainName]: (acc.tvlByChain[chainName] || 0) + tvl };

      if (vault.isRetired) {
        return {
          ...acc,
          retiredTvlByCategory: { ...acc.retiredTvlByCategory, [cat]: acc.retiredTvlByCategory[cat] + tvl },
          tvlByChain: updatedChain,
          vaultCount: counts,
        };
      }

      return {
        ...acc,
        tvlByCategory: { ...acc.tvlByCategory, [cat]: acc.tvlByCategory[cat] + tvl },
        tvlByChain: updatedChain,
        vaultCount: counts,
      };
    },
    {
      tvlByCategory: initCat(),
      retiredTvlByCategory: initCat(),
      tvlByChain: {} as Record<string, number>,
      vaultCount: { total: 0, v1: 0, v2: 0, v3: 0, curation: 0, active: 0, retired: 0 },
    },
  );

  const { tvlByCategory, retiredTvlByCategory, tvlByChain, vaultCount } = agg;
  const activeRaw = tvlByCategory.v1 + tvlByCategory.v2 + tvlByCategory.v3 + tvlByCategory.curation;
  const retiredRaw = retiredTvlByCategory.v1 + retiredTvlByCategory.v2 + retiredTvlByCategory.v3 + retiredTvlByCategory.curation;

  // Cross-chain overlap: retired vaults whose capital migrated to another chain.
  // Deduct their TVL to avoid double-counting with the destination vaults.
  const crossChainAddresses = new Set(CROSS_CHAIN_OVERLAP_REGISTRY.map((e) => `${e.sourceChainId}:${e.sourceVaultAddress.toLowerCase()}`));
  const crossChainVaults = snapshots.filter(
    ({ vault }) => vault.isRetired && crossChainAddresses.has(`${vault.chainId}:${vault.address.toLowerCase()}`),
  );
  const crossChainOverlapByCategory = crossChainVaults.reduce(
    (acc, { vault, snapshot }) => {
      const cat = vault.category as VaultCategory;
      return { ...acc, [cat]: acc[cat] + (snapshot.tvlUsd ?? 0) };
    },
    { v1: 0, v2: 0, v3: 0, curation: 0 } as Record<VaultCategory, number>,
  );
  const crossChainOverlap = crossChainVaults.reduce((sum, { snapshot }) => sum + (snapshot.tvlUsd ?? 0), 0);

  // Per-chain cross-chain overlap (deducted from source chain)
  const crossChainOverlapByChain = crossChainVaults.reduce(
    (acc, { vault, snapshot }) => {
      const chainName = CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`;
      return { ...acc, [chainName]: (acc[chainName] || 0) + (snapshot.tvlUsd ?? 0) };
    },
    {} as Record<string, number>,
  );

  return {
    totalTvl: activeRaw + retiredRaw - totalOverlap - crossChainOverlap,
    activeTvl: activeRaw,
    retiredTvl: retiredRaw,
    v1Tvl: tvlByCategory.v1,
    v2Tvl: tvlByCategory.v2,
    v3Tvl: tvlByCategory.v3,
    curationTvl: tvlByCategory.curation,
    overlapAmount: totalOverlap,
    crossChainOverlap,
    crossChainOverlapByCategory,
    overlapByChain,
    crossChainOverlapByChain,
    tvlByChain,
    tvlByCategory,
    retiredTvlByCategory,
    vaultCount,
  };
};

export const getVaultTvls = async (filters?: {
  chainId?: number;
  category?: VaultCategory;
  vaultType?: number;
  includeRetired?: boolean;
}): Promise<VaultTvl[]> => {
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
};

export const getOverlapDetails = async (): Promise<OverlapDetail[]> => computeOverlap();
