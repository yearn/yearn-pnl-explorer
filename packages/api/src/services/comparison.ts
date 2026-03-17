/**
 * DefiLlama comparison service.
 * Compares our TVL calculations against DefiLlama's reported figures.
 */
import { db, defillamaSnapshots } from "@yearn-tvl/db";
import { eq, desc } from "drizzle-orm";
import type { DefillamaComparison } from "@yearn-tvl/shared";
import { calculateTvl } from "./tvl.js";

const getLatestDefillamaData = async () => {
  const protocols = ["yearn-finance", "yearn-curating"] as const;

  const entries = await Promise.all(
    protocols.map(async (protocol) => {
      const snapshots = await db
        .select()
        .from(defillamaSnapshots)
        .where(eq(defillamaSnapshots.protocol, protocol))
        .orderBy(desc(defillamaSnapshots.id));

      if (snapshots.length === 0) return [protocol, {}] as const;

      const latestTs = snapshots[0].timestamp;
      const chainTvl = snapshots
        .filter((s) => s.timestamp === latestTs && s.chain)
        .reduce(
          (acc, s) => ({ ...acc, [s.chain!]: s.tvlUsd ?? 0 }),
          {} as Record<string, number>,
        );

      return [protocol, chainTvl] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<string, Record<string, number>>;
};

export const getComparison = async (): Promise<DefillamaComparison> => {
  const ourTvl = await calculateTvl();
  const dlData = await getLatestDefillamaData();

  const dlFinance = dlData["yearn-finance"] || {};
  const dlCurating = dlData["yearn-curating"] || {};
  const dlTotal = (dlFinance["total"] || 0) + (dlCurating["total"] || 0);

  // Per-chain — collect all unique chains from both sources
  // tvlByChain already includes retired vault TVL (matching DL behavior)
  const allChains = new Set([
    ...Object.keys(ourTvl.tvlByChain),
    ...Object.keys(dlFinance).filter((c) => c !== "total"),
    ...Object.keys(dlCurating).filter((c) => c !== "total"),
  ]);

  const byChain = [...allChains]
    .map((chain) => ({
      chain,
      ours: ourTvl.tvlByChain[chain] || 0,
      defillama: (dlFinance[chain] || 0) + (dlCurating[chain] || 0),
      difference: (ourTvl.tvlByChain[chain] || 0) - ((dlFinance[chain] || 0) + (dlCurating[chain] || 0)),
    }))
    .filter((c) => c.ours > 0 || c.defillama > 0)
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  // Per-category — includes retired TVL since totalTvl now counts it
  const retiredV1V2V3 = (ourTvl.retiredTvlByCategory.v1 || 0) + (ourTvl.retiredTvlByCategory.v2 || 0) + (ourTvl.retiredTvlByCategory.v3 || 0);
  const retiredCuration = ourTvl.retiredTvlByCategory.curation || 0;
  const v2v3Ours = ourTvl.v1Tvl + ourTvl.v2Tvl + ourTvl.v3Tvl + retiredV1V2V3 - ourTvl.overlapAmount;
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
      ours: ourTvl.curationTvl + retiredCuration,
      defillama: curationDL,
      difference: ourTvl.curationTvl + retiredCuration - curationDL,
    },
  ];

  // Generate notes explaining discrepancies
  const diffPct = dlTotal > 0 ? Math.abs((ourTvl.totalTvl - dlTotal) / dlTotal) * 100 : 0;
  const v2v3DiffPct = v2v3DL > 0 ? Math.abs((v2v3Ours - v2v3DL) / v2v3DL) * 100 : 0;
  const curationDiff = ourTvl.curationTvl + retiredCuration - curationDL;

  const notes = [
    diffPct < 5 && `Total TVL within ${diffPct.toFixed(1)}% of DefiLlama — good alignment.`,
    v2v3DiffPct < 2 && `V2+V3 TVL matches DefiLlama yearn-finance within ${v2v3DiffPct.toFixed(1)}%.`,
    ourTvl.retiredTvl > 1e6 && `$${(ourTvl.retiredTvl / 1e6).toFixed(0)}M in retired vaults included in total (DL counts any vault with on-chain TVL).`,
    ourTvl.overlapAmount > 1e6 && `$${(ourTvl.overlapAmount / 1e6).toFixed(0)}M vault→vault overlap deducted to avoid double-counting.`,
    curationDiff < -5e6 && `Curation gap of $${(Math.abs(curationDiff) / 1e6).toFixed(0)}M — some Morpho vaults not discoverable without archive RPC for factory event scanning.`,
  ].filter((n): n is string => Boolean(n));

  return {
    ourTotal: ourTvl.totalTvl,
    defillamaTotal: dlTotal,
    difference: ourTvl.totalTvl - dlTotal,
    differencePercent: dlTotal > 0 ? ((ourTvl.totalTvl - dlTotal) / dlTotal) * 100 : 0,
    retiredTvl: ourTvl.retiredTvl,
    overlapDeducted: ourTvl.overlapAmount,
    notes,
    byChain,
    byCategory,
  };
};
