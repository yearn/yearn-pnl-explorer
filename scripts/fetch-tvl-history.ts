/**
 * Fetch historical TVL data from DefiLlama and backfill from vault snapshots.
 * Stores daily per-chain protocol TVL history for charting and stickiness analysis.
 */
import { db, tvlHistory, vaultSnapshots } from "@yearn-tvl/db";
import { CHAIN_NAMES, DEFILLAMA_PROTOCOLS } from "@yearn-tvl/shared";
import { eq, sql } from "drizzle-orm";

interface DefillamaProtocol {
  chainTvls: Record<string, { tvl: Array<{ date: number; totalLiquidityUSD: number }> }>;
}

const CHAIN_NAME_TO_ID: Record<string, number> = Object.fromEntries(Object.entries(CHAIN_NAMES).map(([id, name]) => [name, Number(id)]));

const isValidChain = (chain: string): boolean => !chain.includes("-") && chain !== "staking" && chain !== "pool2";

async function fetchProtocolHistory(slug: string): Promise<DefillamaProtocol> {
  const res = await fetch(`https://api.llama.fi/protocol/${slug}`);
  if (!res.ok) throw new Error(`DefiLlama error for ${slug}: ${res.status}`);
  return res.json() as Promise<DefillamaProtocol>;
}

async function backfillDefillamaHistory() {
  let totalStored = 0;

  for (const protocol of DEFILLAMA_PROTOCOLS) {
    console.log(`Fetching DL history for ${protocol}...`);
    const data = await fetchProtocolHistory(protocol);

    for (const [chain, series] of Object.entries(data.chainTvls)) {
      if (!isValidChain(chain)) continue;
      const chainId = CHAIN_NAME_TO_ID[chain];
      if (chainId === undefined) continue;

      // Check what we already have
      const existing = db
        .select({ cnt: sql<number>`count(*)` })
        .from(tvlHistory)
        .where(sql`${tvlHistory.chainId} = ${chainId} AND ${tvlHistory.protocol} = ${protocol} AND ${tvlHistory.source} = 'defillama'`)
        .get();

      if (existing && existing.cnt > 0) {
        console.log(`  ${chain} (${protocol}): ${existing.cnt} existing, skipping`);
        continue;
      }

      const points = series.tvl;
      if (!points || points.length === 0) continue;

      // Batch insert
      const batchSize = 500;
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await db.insert(tvlHistory).values(
          batch.map((p) => ({
            chainId,
            protocol,
            tvlUsd: p.totalLiquidityUSD,
            source: "defillama" as const,
            timestamp: p.date,
          })),
        );
      }

      totalStored += points.length;
      console.log(`  ${chain} (${protocol}): ${points.length} data points stored`);
    }
  }

  return totalStored;
}

async function backfillVaultSnapshots() {
  // Copy existing vault snapshots into tvl_history for vault-level time-series
  const existing = db.select({ cnt: sql<number>`count(*)` }).from(tvlHistory).where(eq(tvlHistory.source, "snapshot")).get();

  if (existing && existing.cnt > 0) {
    console.log(`Already have ${existing.cnt} vault snapshot entries, skipping`);
    return 0;
  }

  const snapshots = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      tvlUsd: vaultSnapshots.tvlUsd,
      timestamp: vaultSnapshots.timestamp,
    })
    .from(vaultSnapshots)
    .all();

  if (snapshots.length === 0) {
    console.log("No vault snapshots to backfill");
    return 0;
  }

  const batchSize = 500;
  let stored = 0;
  for (let i = 0; i < snapshots.length; i += batchSize) {
    const batch = snapshots.slice(i, i + batchSize);
    await db.insert(tvlHistory).values(
      batch.map((s) => ({
        vaultId: s.vaultId,
        tvlUsd: s.tvlUsd ?? 0,
        source: "snapshot" as const,
        timestamp: Math.floor(new Date(s.timestamp).getTime() / 1000),
      })),
    );
    stored += batch.length;
  }

  console.log(`Backfilled ${stored} vault snapshot entries`);
  return stored;
}

export async function fetchTvlHistory() {
  console.log("=== Backfilling DefiLlama protocol history ===");
  const dlCount = await backfillDefillamaHistory();
  console.log(`Stored ${dlCount} DL history points`);

  console.log("\n=== Backfilling vault snapshots ===");
  const snapCount = await backfillVaultSnapshots();

  return { defillamaPoints: dlCount, snapshotPoints: snapCount };
}

if (import.meta.main) {
  const result = await fetchTvlHistory();
  console.log("\nDone:", result);
}
