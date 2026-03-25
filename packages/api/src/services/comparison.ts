/**
 * DefiLlama comparison service.
 * Compares our TVL calculations against DefiLlama's reported figures.
 */
import { db, defillamaSnapshots } from "@yearn-tvl/db";
import type { DefillamaComparison, GapComponent } from "@yearn-tvl/shared";
import { CHAIN_NAMES } from "@yearn-tvl/shared";
import { desc, eq } from "drizzle-orm";
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
        .reduce((acc, s) => ({ ...acc, [s.chain!]: s.tvlUsd ?? 0 }), {} as Record<string, number>);

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
  const dlTotal = (dlFinance.total || 0) + (dlCurating.total || 0);

  // Per-chain — collect all unique chains from both sources
  // tvlByChain already includes retired vault TVL (matching DL behavior)
  const allChains = new Set([
    ...Object.keys(ourTvl.tvlByChain),
    ...Object.keys(dlFinance).filter((c) => c !== "total"),
    ...Object.keys(dlCurating).filter((c) => c !== "total"),
  ]);

  const byChain = [...allChains]
    .map((chain) => {
      const raw = ourTvl.tvlByChain[chain] || 0;
      const chainOverlap = (ourTvl.overlapByChain[chain] || 0) + (ourTvl.crossChainOverlapByChain[chain] || 0);
      const ours = raw - chainOverlap;
      const defillama = (dlFinance[chain] || 0) + (dlCurating[chain] || 0);
      return { chain, ours, defillama, difference: ours - defillama };
    })
    .filter((c) => c.ours > 0 || c.defillama > 0)
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  // Per-category — includes retired TVL, deducts both auto/registry overlap AND cross-chain overlap
  const retiredV1V2V3 =
    (ourTvl.retiredTvlByCategory.v1 || 0) + (ourTvl.retiredTvlByCategory.v2 || 0) + (ourTvl.retiredTvlByCategory.v3 || 0);
  const retiredCuration = ourTvl.retiredTvlByCategory.curation || 0;
  const ccV1V2V3 =
    (ourTvl.crossChainOverlapByCategory.v1 || 0) +
    (ourTvl.crossChainOverlapByCategory.v2 || 0) +
    (ourTvl.crossChainOverlapByCategory.v3 || 0);
  const ccCuration = ourTvl.crossChainOverlapByCategory.curation || 0;
  const v2v3Ours = ourTvl.v1Tvl + ourTvl.v2Tvl + ourTvl.v3Tvl + retiredV1V2V3 - ourTvl.overlapAmount - ccV1V2V3;
  const v2v3DL = dlFinance.total || 0;
  const curationDL = dlCurating.total || 0;

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
      ours: ourTvl.curationTvl + retiredCuration - ccCuration,
      defillama: curationDL,
      difference: ourTvl.curationTvl + retiredCuration - ccCuration - curationDL,
    },
  ];

  // Generate notes explaining discrepancies
  const diffPct = dlTotal > 0 ? Math.abs((ourTvl.totalTvl - dlTotal) / dlTotal) * 100 : 0;
  const v2v3DiffPct = v2v3DL > 0 ? Math.abs((v2v3Ours - v2v3DL) / v2v3DL) * 100 : 0;
  const curationDiff = ourTvl.curationTvl + retiredCuration - ccCuration - curationDL;

  const retiredV2 = ourTvl.retiredTvlByCategory.v2 || 0;
  const v1Tvl = ourTvl.v1Tvl;

  const notes = [
    diffPct < 5 && `Total TVL within ${diffPct.toFixed(1)}% of DefiLlama — good alignment.`,
    v2v3DiffPct < 2 && `V2+V3 TVL matches DefiLlama yearn-finance within ${v2v3DiffPct.toFixed(1)}%.`,
    ourTvl.retiredTvl > 1e6 &&
      `$${(ourTvl.retiredTvl / 1e6).toFixed(0)}M in retired vaults included in total (DL counts any vault with on-chain TVL).`,
    ourTvl.overlapAmount > 1e6 && `$${(ourTvl.overlapAmount / 1e6).toFixed(0)}M vault→vault overlap deducted to avoid double-counting.`,
    retiredV2 > 1e6 &&
      `$${(retiredV2 / 1e6).toFixed(0)}M in retired V2 vaults still holds real on-chain capital (users haven't withdrawn). DL's yearn-finance adapter likely no longer tracks these deprecated vaults, but the funds are verified on-chain.`,
    v1Tvl > 1e6 && `$${(v1Tvl / 1e6).toFixed(0)}M in V1 legacy vaults not tracked by DL's adapter. Capital verified on-chain.`,
    curationDiff < -5e6 &&
      `Curation gap of $${(Math.abs(curationDiff) / 1e6).toFixed(0)}M — some Morpho vaults not discoverable without archive RPC for factory event scanning.`,
  ].filter((n): n is string => Boolean(n));

  // Structured gap components explaining the difference
  const totalDiff = ourTvl.totalTvl - dlTotal;
  const gapComponents: GapComponent[] = [];

  if (retiredV2 > 1e5) {
    gapComponents.push({
      label: "Retired V2 Vaults",
      amount: retiredV2,
      explanation: "Deprecated V2 vaults still holding on-chain capital. DL's adapter likely no longer tracks these.",
    });
  }
  if (v1Tvl > 1e5) {
    gapComponents.push({
      label: "V1 Legacy Vaults",
      amount: v1Tvl,
      explanation: "Hardcoded V1 vault list not tracked by DL's yearn-finance adapter. Capital verified on-chain.",
    });
  }
  const retiredV3NonCC = (ourTvl.retiredTvlByCategory.v3 || 0) - (ourTvl.crossChainOverlapByCategory.v3 || 0);
  if (retiredV3NonCC > 1e5) {
    gapComponents.push({
      label: "Retired V3 Vaults (non-Katana)",
      amount: retiredV3NonCC,
      explanation: "Retired V3 vaults not in the cross-chain registry, still holding on-chain capital.",
    });
  }
  const retiredCurationNonCC = (ourTvl.retiredTvlByCategory.curation || 0) - ccCuration;
  if (retiredCurationNonCC > 1e5) {
    gapComponents.push({
      label: "Retired Curation Vaults",
      amount: retiredCurationNonCC,
      explanation: "Retired curation vaults still holding deposits.",
    });
  }
  const explained = gapComponents.reduce((sum, g) => sum + g.amount, 0);
  const residual = totalDiff - explained;
  if (Math.abs(residual) > 1e5) {
    gapComponents.push({
      label: "Other Differences",
      amount: residual,
      explanation: "Remaining difference from pricing discrepancies, timing, or DL adapter coverage.",
    });
  }

  // Retired TVL by chain
  const snapshots = await (await import("./queries.js")).getLatestSnapshots();
  const retiredTvlByChain = snapshots
    .filter(({ vault }) => vault.isRetired)
    .reduce(
      (acc, { vault, snapshot }) => {
        const chainName = CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`;
        return { ...acc, [chainName]: (acc[chainName] || 0) + (snapshot.tvlUsd ?? 0) };
      },
      {} as Record<string, number>,
    );

  const grossTvl = ourTvl.activeTvl + ourTvl.retiredTvl;

  return {
    ourTotal: ourTvl.totalTvl,
    defillamaTotal: dlTotal,
    difference: totalDiff,
    differencePercent: dlTotal > 0 ? (totalDiff / dlTotal) * 100 : 0,
    retiredTvl: ourTvl.retiredTvl,
    overlapDeducted: ourTvl.overlapAmount,
    crossChainOverlap: ourTvl.crossChainOverlap,
    grossTvl,
    gapComponents,
    retiredTvlByChain,
    notes,
    byChain,
    byCategory,
  };
};
