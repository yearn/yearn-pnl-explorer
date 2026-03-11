/**
 * DefiLlama comparison service.
 * Compares our TVL calculations against DefiLlama's reported figures.
 */
import { db, vaults, vaultSnapshots, defillamaSnapshots } from "@yearn-tvl/db";
import { eq, desc } from "drizzle-orm";
import type { DefillamaComparison } from "@yearn-tvl/shared";
import { calculateTvl } from "./tvl.js";

async function getLatestDefillamaData() {
  const protocols = ["yearn-finance", "yearn-curating"] as const;
  const result: Record<string, Record<string, number>> = {};

  for (const protocol of protocols) {
    result[protocol] = {};
    const snapshots = await db
      .select()
      .from(defillamaSnapshots)
      .where(eq(defillamaSnapshots.protocol, protocol))
      .orderBy(desc(defillamaSnapshots.id));

    if (snapshots.length === 0) continue;
    const latestTs = snapshots[0].timestamp;
    for (const s of snapshots) {
      if (s.timestamp !== latestTs) break;
      if (s.chain) result[protocol][s.chain] = s.tvlUsd ?? 0;
    }
  }

  return result;
}

/** Calculate TVL locked in retired vaults */
async function getRetiredTvl(): Promise<number> {
  const allVaults = await db.select({ id: vaults.id, isRetired: vaults.isRetired }).from(vaults);
  let total = 0;
  for (const v of allVaults) {
    if (!v.isRetired) continue;
    const snap = await db.query.vaultSnapshots.findFirst({
      where: eq(vaultSnapshots.vaultId, v.id),
      orderBy: [desc(vaultSnapshots.id)],
    });
    total += snap?.tvlUsd ?? 0;
  }
  return total;
}

export async function getComparison(): Promise<DefillamaComparison> {
  const ourTvl = await calculateTvl();
  const dlData = await getLatestDefillamaData();
  const retiredTvl = await getRetiredTvl();

  const dlFinance = dlData["yearn-finance"] || {};
  const dlCurating = dlData["yearn-curating"] || {};
  const dlTotal = (dlFinance["total"] || 0) + (dlCurating["total"] || 0);

  // Per-chain
  const allChains = new Set<string>();
  for (const chain of Object.keys(ourTvl.tvlByChain)) allChains.add(chain);
  for (const chain of Object.keys(dlFinance)) if (chain !== "total") allChains.add(chain);
  for (const chain of Object.keys(dlCurating)) if (chain !== "total") allChains.add(chain);

  const byChain = [...allChains]
    .map((chain) => ({
      chain,
      ours: ourTvl.tvlByChain[chain] || 0,
      defillama: (dlFinance[chain] || 0) + (dlCurating[chain] || 0),
      difference: (ourTvl.tvlByChain[chain] || 0) - ((dlFinance[chain] || 0) + (dlCurating[chain] || 0)),
    }))
    .filter((c) => c.ours > 0 || c.defillama > 0)
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  // Per-category
  const v2v3Ours = ourTvl.v1Tvl + ourTvl.v2Tvl + ourTvl.v3Tvl - ourTvl.overlapAmount;
  const v2v3DL = dlFinance["total"] || 0;
  const curationDL = dlCurating["total"] || 0;

  const byCategory = [
    {
      category: "V1 + V2 + V3",
      defillamaProtocol: "yearn-finance",
      ours: v2v3Ours,
      defillama: v2v3DL,
      difference: v2v3Ours - v2v3DL,
    },
    {
      category: "Curation",
      defillamaProtocol: "yearn-curating",
      ours: ourTvl.curationTvl,
      defillama: curationDL,
      difference: ourTvl.curationTvl - curationDL,
    },
  ];

  // Generate notes explaining discrepancies
  const notes: string[] = [];

  const diffPct = dlTotal > 0 ? Math.abs((ourTvl.totalTvl - dlTotal) / dlTotal) * 100 : 0;
  if (diffPct < 5) {
    notes.push(`Total TVL within ${diffPct.toFixed(1)}% of DefiLlama — good alignment.`);
  }

  const v2v3DiffPct = v2v3DL > 0 ? Math.abs((v2v3Ours - v2v3DL) / v2v3DL) * 100 : 0;
  if (v2v3DiffPct < 2) {
    notes.push(`V2+V3 TVL matches DefiLlama yearn-finance within ${v2v3DiffPct.toFixed(1)}%.`);
  }

  if (retiredTvl > 1e6) {
    notes.push(`$${(retiredTvl / 1e6).toFixed(0)}M in retired vaults excluded from our active total (DefiLlama also excludes these).`);
  }

  if (ourTvl.overlapAmount > 1e6) {
    notes.push(`$${(ourTvl.overlapAmount / 1e6).toFixed(0)}M V3 allocator→strategy overlap deducted to avoid double-counting.`);
  }

  const curationDiff = ourTvl.curationTvl - curationDL;
  if (curationDiff < -5e6) {
    notes.push(`Curation gap of $${(Math.abs(curationDiff) / 1e6).toFixed(0)}M — some Morpho vaults not discoverable without archive RPC for factory event scanning.`);
  }

  return {
    ourTotal: ourTvl.totalTvl,
    defillamaTotal: dlTotal,
    difference: ourTvl.totalTvl - dlTotal,
    differencePercent: dlTotal > 0 ? ((ourTvl.totalTvl - dlTotal) / dlTotal) * 100 : 0,
    retiredTvl,
    overlapDeducted: ourTvl.overlapAmount,
    notes,
    byChain,
    byCategory,
  };
}
