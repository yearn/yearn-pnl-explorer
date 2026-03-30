/**
 * Fee stacking analysis service.
 * Builds a tree of vault→vault fee chains where capital flows through
 * multiple fee-taking allocator vaults.
 */
import { db, feeConfigs, vaults } from "@yearn-tvl/db";
import type { FeeStackNode, FeeStackSummary } from "@yearn-tvl/shared";
import { and, eq } from "drizzle-orm";
import { type AuditVault, getAuditTree } from "./audit.js";
import { latestFeeConfigIds } from "./queries.js";

const MAX_DEPTH = 10;

interface FeeRate {
  performanceFee: number;
  managementFee: number;
}

/** Load fee rates keyed by chainId:address in a single query */
async function loadFeeRatesByAddress(): Promise<Map<string, FeeRate>> {
  const latestFees = latestFeeConfigIds();
  const rows = await db
    .select({
      address: vaults.address,
      chainId: vaults.chainId,
      performanceFee: feeConfigs.performanceFee,
      managementFee: feeConfigs.managementFee,
    })
    .from(feeConfigs)
    .innerJoin(latestFees, and(eq(feeConfigs.vaultId, latestFees.vaultId), eq(feeConfigs.id, latestFees.maxId)))
    .innerJoin(vaults, eq(feeConfigs.vaultId, vaults.id));

  return new Map(
    rows.map((r) => [
      `${r.chainId}:${r.address.toLowerCase()}`,
      { performanceFee: r.performanceFee || 0, managementFee: r.managementFee || 0 },
    ]),
  );
}

function buildVaultLookup(auditVaults: AuditVault[]): Map<string, AuditVault> {
  return new Map(auditVaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));
}

/**
 * Recursively build a tree node for a vault.
 * Each child is a downstream vault that this vault deposits into via an overlapping strategy.
 *
 * `capitalUsd` is the capital flowing into this vault from the parent.
 * `shareRatio` is what fraction of this vault's TVL the parent represents (0-1).
 * Child strategy debts are multiplied by shareRatio so capital shows the
 * proportional amount attributable to the root vault, not the target's total.
 */
function buildNode(
  vault: AuditVault,
  capitalUsd: number,
  shareRatio: number,
  fees: FeeRate,
  vaultLookup: Map<string, AuditVault>,
  feeByAddress: Map<string, FeeRate>,
  visited: Set<string>,
  depth: number,
): FeeStackNode {
  const children =
    depth < MAX_DEPTH
      ? vault.strategies
          .filter((strat) => strat.detectionMethod && strat.targetVaultAddress && strat.debtUsd > 0)
          .map((strat) => {
            const targetKey = `${strat.targetVaultChainId || vault.chainId}:${strat.targetVaultAddress!.toLowerCase()}`;
            if (visited.has(targetKey)) return null;

            const targetVault = vaultLookup.get(targetKey);
            if (!targetVault) return null;

            const targetFees = feeByAddress.get(targetKey) || { performanceFee: 0, managementFee: 0 };

            // Capital flowing through this path = strategy debt × parent's share
            const childCapital = strat.debtUsd * shareRatio;
            // Child's share of the target vault, capped at 1.0 (snapshot timing can cause >100%)
            const childShareRatio = targetVault.tvlUsd > 0 ? Math.min(childCapital / targetVault.tvlUsd, 1.0) : 0;

            // Clone visited per-branch so sibling paths don't block each other
            // (only prevents cycles within a single path)
            const branchVisited = new Set([...visited, targetKey]);
            return buildNode(targetVault, childCapital, childShareRatio, targetFees, vaultLookup, feeByAddress, branchVisited, depth + 1);
          })
          .filter((c): c is FeeStackNode => c !== null)
      : [];

  return {
    vault: { address: vault.address, chainId: vault.chainId, name: vault.name },
    perfFee: fees.performanceFee,
    mgmtFee: fees.managementFee,
    capitalUsd,
    children,
  };
}

/** Get max depth of a tree */
function treeDepth(node: FeeStackNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(treeDepth));
}

/**
 * Compute capital-weighted effective fee across all paths in the tree.
 *
 * Each leaf represents a terminal allocation. The compound fee for that leaf
 * is 1 - product(1 - fee_i) along the path from root to leaf. The effective
 * fee for the whole tree is the capital-weighted average of all leaf compound
 * fees, where weight = leaf.capitalUsd / root.capitalUsd.
 */
function capitalWeightedFee(root: FeeStackNode): { perfFee: number; mgmtFee: number } {
  const rootCapital = root.capitalUsd;
  if (rootCapital <= 0) return { perfFee: 0, mgmtFee: 0 };

  // Collect all leaf paths with their compound fees and capital
  const leaves: Array<{ compoundPerf: number; additiveMgmt: number; capital: number }> = [];

  function walk(node: FeeStackNode, pathPerfProduct: number, pathMgmtSum: number) {
    const perf = node.perfFee / 10000;
    const mgmt = node.mgmtFee / 10000;
    const newProduct = pathPerfProduct * (1 - perf);
    const newMgmt = pathMgmtSum + mgmt;

    if (node.children.length === 0) {
      // Leaf — record the compound fee for this path
      leaves.push({
        compoundPerf: 1 - newProduct, // effective rate for this path
        additiveMgmt: newMgmt,
        capital: node.capitalUsd,
      });
    } else {
      // Capital that stays at this level (not allocated to children)
      const childCapital = node.children.reduce((s, c) => s + c.capitalUsd, 0);
      const unallocated = Math.max(0, node.capitalUsd - childCapital);
      if (unallocated > 0) {
        // This portion only pays fees up to this node, not deeper
        leaves.push({
          compoundPerf: 1 - newProduct,
          additiveMgmt: newMgmt,
          capital: unallocated,
        });
      }
      node.children.forEach((child) => walk(child, newProduct, newMgmt));
    }
  }

  walk(root, 1, 0);

  // Capital-weighted average
  const totalLeafCapital = leaves.reduce((s, l) => s + l.capital, 0);
  if (totalLeafCapital <= 0) return { perfFee: 0, mgmtFee: 0 };

  const weightedPerf = leaves.reduce((s, l) => s + l.compoundPerf * l.capital, 0) / totalLeafCapital;
  const weightedMgmt = leaves.reduce((s, l) => s + l.additiveMgmt * l.capital, 0) / totalLeafCapital;

  return {
    perfFee: Math.round(weightedPerf * 10000),
    mgmtFee: Math.round(weightedMgmt * 10000),
  };
}

export async function getFeeStackAnalysis(): Promise<FeeStackSummary> {
  const [auditTree, feeByAddress] = await Promise.all([getAuditTree(), loadFeeRatesByAddress()]);
  const vaultLookup = buildVaultLookup(auditTree.vaults);

  const chains = auditTree.vaults
    .filter((vault) =>
      vault.strategies.some((s) => {
        if (!s.detectionMethod || !s.targetVaultAddress || s.debtUsd <= 0) return false;
        const targetKey = `${s.targetVaultChainId || vault.chainId}:${s.targetVaultAddress.toLowerCase()}`;
        return vaultLookup.has(targetKey);
      }),
    )
    .map((vault) => {
      const rootKey = `${vault.chainId}:${vault.address.toLowerCase()}`;
      const rootFees = feeByAddress.get(rootKey) || { performanceFee: 0, managementFee: 0 };

      const visited = new Set<string>([rootKey]);
      const root = buildNode(vault, vault.tvlUsd, 1.0, rootFees, vaultLookup, feeByAddress, visited, 0);

      const maxDepth = treeDepth(root);
      const { perfFee, mgmtFee } = capitalWeightedFee(root);

      return {
        root,
        maxDepth,
        effectivePerfFee: perfFee,
        effectiveMgmtFee: mgmtFee,
      };
    })
    .filter((chain) => chain.root.children.length > 0);

  chains.sort((a, b) => b.effectivePerfFee - a.effectivePerfFee);

  const maxDepth = chains.reduce((m, c) => Math.max(m, c.maxDepth), 0);
  const maxEffectivePerfFee = chains.reduce((m, c) => Math.max(m, c.effectivePerfFee), 0);
  const avgEffectivePerfFee = chains.length > 0 ? Math.round(chains.reduce((s, c) => s + c.effectivePerfFee, 0) / chains.length) : 0;
  const totalStackedCapital = chains.reduce((s, c) => s + c.root.capitalUsd, 0);

  return {
    chains,
    maxDepth,
    maxEffectivePerfFee,
    avgEffectivePerfFee,
    totalStackedCapital,
  };
}
