/**
 * TVL stickiness analysis service.
 * Computes per-vault and protocol-level TVL stability scores.
 */
import { db, tvlHistory, vaultSnapshots, vaults } from "@yearn-tvl/db";
import type { TvlHistoryPoint, VaultStickiness } from "@yearn-tvl/shared";
import { CHAIN_NAMES, computeStickiness, filterWindow, STICKINESS_WINDOWS } from "@yearn-tvl/shared";
import { and, desc, eq } from "drizzle-orm";
import { getLatestSnapshots } from "./queries.js";

/**
 * Get stickiness scores for all vaults with sufficient data.
 */
export async function getVaultStickiness(minTvl = 10_000, chainId?: number): Promise<VaultStickiness[]> {
  const snapshots = await getLatestSnapshots();
  const results: VaultStickiness[] = [];

  for (const { vault, snapshot } of snapshots) {
    const tvl = snapshot.tvlUsd ?? 0;
    if (tvl < minTvl || vault.isRetired) continue;
    if (chainId && vault.chainId !== chainId) continue;

    // Get historical data for this vault
    const history = db
      .select({ timestamp: tvlHistory.timestamp, tvlUsd: tvlHistory.tvlUsd })
      .from(tvlHistory)
      .where(eq(tvlHistory.vaultId, vault.id))
      .orderBy(tvlHistory.timestamp)
      .all();

    const scores: VaultStickiness["scores"] = {
      "30d": null,
      "90d": null,
      "365d": null,
    };

    for (const [key, windowSecs] of Object.entries(STICKINESS_WINDOWS)) {
      const windowKey = key as keyof typeof STICKINESS_WINDOWS;
      const values = filterWindow(history, windowSecs);
      scores[windowKey] = computeStickiness(values);
    }

    // Only include vaults that have at least one computable score
    const hasScore = Object.values(scores).some((s) => s !== null);

    results.push({
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      currentTvl: tvl,
      scores,
      history: hasScore ? history : [],
    });
  }

  return results.sort((a, b) => b.currentTvl - a.currentTvl);
}

/**
 * Get stickiness data for a single vault.
 */
export async function getSingleVaultStickiness(address: string, chainId: number): Promise<VaultStickiness | null> {
  const vault = db
    .select()
    .from(vaults)
    .where(and(eq(vaults.address, address), eq(vaults.chainId, chainId)))
    .get();

  if (!vault) return null;

  const history = db
    .select({ timestamp: tvlHistory.timestamp, tvlUsd: tvlHistory.tvlUsd })
    .from(tvlHistory)
    .where(eq(tvlHistory.vaultId, vault.id))
    .orderBy(tvlHistory.timestamp)
    .all();

  const latestSnapshot = db
    .select({ tvlUsd: vaultSnapshots.tvlUsd })
    .from(vaultSnapshots)
    .where(eq(vaultSnapshots.vaultId, vault.id))
    .orderBy(desc(vaultSnapshots.id))
    .limit(1)
    .get();

  const scores: VaultStickiness["scores"] = { "30d": null, "90d": null, "365d": null };
  for (const [key, windowSecs] of Object.entries(STICKINESS_WINDOWS)) {
    const windowKey = key as keyof typeof STICKINESS_WINDOWS;
    const values = filterWindow(history, windowSecs);
    scores[windowKey] = computeStickiness(values);
  }

  return {
    address: vault.address,
    chainId: vault.chainId,
    name: vault.name,
    currentTvl: latestSnapshot?.tvlUsd ?? 0,
    scores,
    history,
  };
}

/**
 * Get protocol-level TVL history from DefiLlama backfill.
 */
export async function getProtocolTvlHistory(protocol?: string): Promise<TvlHistoryPoint[]> {
  const rows = protocol
    ? db
        .select({
          timestamp: tvlHistory.timestamp,
          tvlUsd: tvlHistory.tvlUsd,
          chainId: tvlHistory.chainId,
          protocol: tvlHistory.protocol,
        })
        .from(tvlHistory)
        .where(and(eq(tvlHistory.source, "defillama"), eq(tvlHistory.protocol, protocol)))
        .orderBy(tvlHistory.timestamp)
        .all()
    : db
        .select({
          timestamp: tvlHistory.timestamp,
          tvlUsd: tvlHistory.tvlUsd,
          chainId: tvlHistory.chainId,
          protocol: tvlHistory.protocol,
        })
        .from(tvlHistory)
        .where(eq(tvlHistory.source, "defillama"))
        .orderBy(tvlHistory.timestamp)
        .all();

  return rows.map((r) => ({
    timestamp: r.timestamp,
    tvlUsd: r.tvlUsd,
    chain: r.chainId ? CHAIN_NAMES[r.chainId] : undefined,
    protocol: r.protocol ?? undefined,
  }));
}
