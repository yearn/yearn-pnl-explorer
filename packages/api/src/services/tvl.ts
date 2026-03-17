/**
 * TVL calculation engine.
 * Aggregates vault snapshots, deducts double-counted overlap, produces metrics.
 * Includes retired vault TVL in totals (matching DefiLlama behavior — DL counts
 * any vault with positive on-chain TVL regardless of retirement status).
 */
import { db, vaults, vaultSnapshots, strategies, strategyDebts } from "@yearn-tvl/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type { TvlSummary, VaultTvl, OverlapDetail, VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES, STRATEGY_OVERLAP_REGISTRY, CROSS_CHAIN_OVERLAP_REGISTRY } from "@yearn-tvl/shared";

/** Get the latest snapshot for each vault */
const getLatestSnapshots = async () => {
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
};

/** Detect vault→vault overlap (auto + registry-based) */
const computeOverlap = async (): Promise<OverlapDetail[]> => {
  const allVaults = await db.select({
    id: vaults.id,
    address: vaults.address,
    chainId: vaults.chainId,
    category: vaults.category,
    isRetired: vaults.isRetired,
  }).from(vaults);

  const vaultByAddress = new Map(
    allVaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]),
  );

  // Auto-detection: check ALL active vaults (not just vaultType=1 allocators)
  const activeVaults = allVaults.filter((v) => !v.isRetired);
  const autoDetectedStratKeys = new Set<string>();

  const autoResults = await Promise.all(
    activeVaults.map(async (vault) => {
      const vaultStrategies = await db.select().from(strategies).where(eq(strategies.vaultId, vault.id));

      const stratOverlaps = await Promise.all(
        vaultStrategies.map(async (strat) => {
          const targetVault = vaultByAddress.get(`${vault.chainId}:${strat.address.toLowerCase()}`);
          if (!targetVault) return null;

          const [latestDebt] = await db
            .select()
            .from(strategyDebts)
            .where(eq(strategyDebts.strategyId, strat.id))
            .orderBy(desc(strategyDebts.id))
            .limit(1);

          if (!latestDebt?.currentDebtUsd || latestDebt.currentDebtUsd <= 0) return null;

          autoDetectedStratKeys.add(`${vault.chainId}:${strat.address.toLowerCase()}`);

          return {
            sourceVault: vault.address,
            targetVault: targetVault.address,
            strategyAddress: strat.address,
            overlapUsd: latestDebt.currentDebtUsd,
            sourceCategory: vault.category as VaultCategory,
            targetCategory: targetVault.category as VaultCategory,
            detectionMethod: "auto" as const,
          };
        }),
      );

      return stratOverlaps.filter((o) => o !== null);
    }),
  );

  // Registry-based: intermediary depositor contracts not caught by auto-detection
  const registryResults = await Promise.all(
    STRATEGY_OVERLAP_REGISTRY.map(async (entry) => {
      const key = `${entry.chainId}:${entry.strategyAddress.toLowerCase()}`;
      if (autoDetectedStratKeys.has(key)) return null;

      const targetVault = vaultByAddress.get(`${entry.chainId}:${entry.targetVaultAddress.toLowerCase()}`);
      if (!targetVault) return null;

      // Find strategy in DB by address + chainId
      const [strat] = await db
        .select()
        .from(strategies)
        .where(and(
          eq(strategies.address, entry.strategyAddress),
          eq(strategies.chainId, entry.chainId),
        ))
        .limit(1);

      if (!strat) return null;

      const [latestDebt] = await db
        .select()
        .from(strategyDebts)
        .where(eq(strategyDebts.strategyId, strat.id))
        .orderBy(desc(strategyDebts.id))
        .limit(1);

      if (!latestDebt?.currentDebtUsd || latestDebt.currentDebtUsd <= 0) return null;

      // Find the source vault (the vault that uses this strategy)
      const sourceVault = allVaults.find((v) => v.id === strat.vaultId);
      if (!sourceVault) return null;

      return {
        sourceVault: sourceVault.address,
        targetVault: targetVault.address,
        strategyAddress: strat.address,
        overlapUsd: latestDebt.currentDebtUsd,
        sourceCategory: sourceVault.category as VaultCategory,
        targetCategory: targetVault.category as VaultCategory,
        detectionMethod: "registry" as const,
        label: entry.label,
      };
    }),
  );

  return [
    ...autoResults.flat(),
    ...registryResults.filter((o) => o !== null),
  ] as OverlapDetail[];
};

export const calculateTvl = async (): Promise<TvlSummary> => {
  const snapshots = await getLatestSnapshots();
  const overlaps = await computeOverlap();

  const totalOverlap = overlaps.reduce((sum, o) => sum + o.overlapUsd, 0);

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
        ...(vault.isRetired
          ? { retired: acc.vaultCount.retired + 1 }
          : { active: acc.vaultCount.active + 1 }),
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
  const crossChainAddresses = new Set(
    CROSS_CHAIN_OVERLAP_REGISTRY.map((e) => `${e.sourceChainId}:${e.sourceVaultAddress.toLowerCase()}`),
  );
  const crossChainOverlap = snapshots
    .filter(({ vault }) =>
      vault.isRetired && crossChainAddresses.has(`${vault.chainId}:${vault.address.toLowerCase()}`),
    )
    .reduce((sum, { snapshot }) => sum + (snapshot.tvlUsd ?? 0), 0);

  return {
    totalTvl: activeRaw + retiredRaw - totalOverlap - crossChainOverlap,
    activeTvl: activeRaw,
    retiredTvl: retiredRaw,
    v1Tvl: tvlByCategory.v1,
    v2Tvl: tvlByCategory.v2,
    v3Tvl: tvlByCategory.v3,
    curationTvl: tvlByCategory.curation,
    overlapAmount: totalOverlap,
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
