/**
 * Audit tree service.
 * Returns all vaults with their strategies and recursive allocation chains
 * for the Audit dashboard page.
 */
import { db, strategies, strategyDebts, vaults } from "@yearn-tvl/db";
import type { VaultCategory } from "@yearn-tvl/shared";
import { CROSS_CHAIN_OVERLAP_REGISTRY, groupBy, STRATEGY_OVERLAP_REGISTRY, toMap } from "@yearn-tvl/shared";
import { and, eq, sql } from "drizzle-orm";
import { getLatestSnapshots } from "./queries.js";

export interface AuditStrategy {
  address: string;
  name: string | null;
  debtUsd: number;
  targetVaultAddress: string | null;
  targetVaultChainId: number | null;
  detectionMethod: "auto" | "registry" | null;
  label: string | null;
}

export interface AuditVault {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
  strategies: AuditStrategy[];
}

export interface AuditTreeResponse {
  summedTvl: number;
  overlapTvl: number;
  crossChainOverlap: number;
  vaultCount: number;
  vaults: AuditVault[];
}

export const getAuditTree = async (filters?: { chainId?: number }): Promise<AuditTreeResponse> => {
  const snapshots = await getLatestSnapshots();

  // Load all vaults for lookup
  const allVaults = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      vaultType: vaults.vaultType,
      isRetired: vaults.isRetired,
    })
    .from(vaults);

  const vaultByAddress = new Map(allVaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));

  // Load all strategies grouped by vault
  const allStrategies = await db.select().from(strategies);
  const strategiesByVault = groupBy(allStrategies, (s) => s.vaultId);

  // Load latest debt per strategy
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

  // Build registry lookup: strategyAddr+chainId → target vault info
  const registryByKey = new Map(STRATEGY_OVERLAP_REGISTRY.map((e) => [`${e.chainId}:${e.strategyAddress.toLowerCase()}`, e]));

  // Build audit vaults from snapshots
  const auditVaults: AuditVault[] = [];
  let summedTvl = 0;

  for (const { vault, snapshot } of snapshots) {
    if (filters?.chainId && vault.chainId !== filters.chainId) continue;

    const tvl = snapshot.tvlUsd ?? 0;
    summedTvl += tvl;

    const vaultStrats = strategiesByVault.get(vault.id) ?? [];
    const auditStrats: AuditStrategy[] = [];

    for (const strat of vaultStrats) {
      const debtUsd = debtByStrategy.get(strat.id) ?? 0;

      // Check auto-detection: strategy address = another vault on same chain
      const targetKey = `${vault.chainId}:${strat.address.toLowerCase()}`;
      const autoTarget = vaultByAddress.get(targetKey);
      const isAutoOverlap = autoTarget && autoTarget.id !== vault.id;

      // Check registry-detection
      const registryEntry = registryByKey.get(targetKey);

      let targetVaultAddress: string | null = null;
      let targetVaultChainId: number | null = null;
      let detectionMethod: "auto" | "registry" | null = null;
      let label: string | null = null;

      if (isAutoOverlap) {
        targetVaultAddress = autoTarget.address;
        targetVaultChainId = autoTarget.chainId;
        detectionMethod = "auto";
      } else if (registryEntry) {
        targetVaultAddress = registryEntry.targetVaultAddress;
        targetVaultChainId = registryEntry.chainId;
        detectionMethod = "registry";
        label = registryEntry.label;
      }

      auditStrats.push({
        address: strat.address,
        name: strat.name,
        debtUsd,
        targetVaultAddress,
        targetVaultChainId,
        detectionMethod,
        label,
      });
    }

    // Sort strategies by debt descending
    auditStrats.sort((a, b) => b.debtUsd - a.debtUsd);

    auditVaults.push({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      category: vault.category as VaultCategory,
      vaultType: vault.vaultType,
      tvlUsd: tvl,
      isRetired: vault.isRetired ?? false,
      strategies: auditStrats,
    });
  }

  // Sort vaults by TVL descending
  auditVaults.sort((a, b) => b.tvlUsd - a.tvlUsd);

  // Sum overlap: total debt of strategies that deposit into other vaults
  const overlapTvl = auditVaults.reduce(
    (sum, v) => sum + v.strategies.filter((s) => s.detectionMethod != null).reduce((s, st) => s + st.debtUsd, 0),
    0,
  );

  // Cross-chain overlap: retired vaults whose capital migrated to another chain
  const crossChainAddresses = new Set(CROSS_CHAIN_OVERLAP_REGISTRY.map((e) => `${e.sourceChainId}:${e.sourceVaultAddress.toLowerCase()}`));
  const crossChainOverlap = auditVaults
    .filter((v) => v.isRetired && crossChainAddresses.has(`${v.chainId}:${v.address.toLowerCase()}`))
    .reduce((sum, v) => sum + v.tvlUsd, 0);

  return {
    summedTvl,
    overlapTvl,
    crossChainOverlap,
    vaultCount: auditVaults.length,
    vaults: auditVaults,
  };
};
