/**
 * Fee stacking analysis service.
 * Builds a tree of vault→vault fee chains where capital flows through
 * multiple fee-taking allocator vaults.
 */
import { db, vaults, feeConfigs } from "@yearn-tvl/db";
import { eq, and } from "drizzle-orm";
import type { FeeStackNode, FeeStackChain, FeeStackSummary } from "@yearn-tvl/shared";
import { getAuditTree, type AuditVault } from "./audit.js";
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
    .innerJoin(latestFees, and(
      eq(feeConfigs.vaultId, latestFees.vaultId),
      eq(feeConfigs.id, latestFees.maxId),
    ))
    .innerJoin(vaults, eq(feeConfigs.vaultId, vaults.id));

  return new Map(rows.map((r) => [
    `${r.chainId}:${r.address.toLowerCase()}`,
    { performanceFee: r.performanceFee || 0, managementFee: r.managementFee || 0 },
  ]));
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
  const children: FeeStackNode[] = [];

  if (depth < MAX_DEPTH) {
    for (const strat of vault.strategies) {
      if (!strat.detectionMethod || !strat.targetVaultAddress) continue;
      if (strat.debtUsd <= 0) continue;

      const targetKey = `${strat.targetVaultChainId || vault.chainId}:${strat.targetVaultAddress.toLowerCase()}`;
      if (visited.has(targetKey)) continue;

      const targetVault = vaultLookup.get(targetKey);
      if (!targetVault) continue;

      const targetFees = feeByAddress.get(targetKey) || { performanceFee: 0, managementFee: 0 };

      // Capital flowing through this path = strategy debt × parent's share
      const childCapital = strat.debtUsd * shareRatio;
      // Child's share of the target vault, capped at 1.0 (snapshot timing can cause >100%)
      const childShareRatio = targetVault.tvlUsd > 0 ? Math.min(childCapital / targetVault.tvlUsd, 1.0) : 0;

      // Clone visited per-branch so sibling paths don't block each other
      // (only prevents cycles within a single path)
      const branchVisited = new Set(visited);
      branchVisited.add(targetKey);
      const child = buildNode(targetVault, childCapital, childShareRatio, targetFees, vaultLookup, feeByAddress, branchVisited, depth + 1);
      children.push(child);
    }
  }

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

/** Collect all nodes in DFS order (for compound fee calc) */
function collectNodes(node: FeeStackNode): FeeStackNode[] {
  const result: FeeStackNode[] = [node];
  for (const child of node.children) {
    result.push(...collectNodes(child));
  }
  return result;
}

/** Find the deepest path and compute compound perf fee along it */
function deepestPathCompoundFee(node: FeeStackNode): { perfFee: number; mgmtFee: number } {
  if (node.children.length === 0) {
    return {
      perfFee: node.capitalUsd > 0 ? node.perfFee : 0,
      mgmtFee: node.capitalUsd > 0 ? node.mgmtFee : 0,
    };
  }

  // Find deepest child path
  let bestChild = node.children[0];
  let bestDepth = treeDepth(bestChild);
  for (const child of node.children.slice(1)) {
    const d = treeDepth(child);
    if (d > bestDepth) { bestChild = child; bestDepth = d; }
  }

  const childResult = deepestPathCompoundFee(bestChild);
  const myPerf = node.capitalUsd > 0 ? node.perfFee : 0;
  const myMgmt = node.capitalUsd > 0 ? node.mgmtFee : 0;

  // Compound: 1 - (1-a)(1-b)
  const compoundPerf = Math.round((1 - (1 - myPerf / 10000) * (1 - childResult.perfFee / 10000)) * 10000);
  return {
    perfFee: compoundPerf,
    mgmtFee: myMgmt + childResult.mgmtFee,
  };
}

export async function getFeeStackAnalysis(): Promise<FeeStackSummary> {
  const [auditTree, feeByAddress] = await Promise.all([
    getAuditTree(),
    loadFeeRatesByAddress(),
  ]);
  const vaultLookup = buildVaultLookup(auditTree.vaults);

  const chains: FeeStackChain[] = [];

  for (const vault of auditTree.vaults) {
    // Only consider vaults that have funded overlapping strategies into other vaults
    const hasFundedOverlap = vault.strategies.some((s) => {
      if (!s.detectionMethod || !s.targetVaultAddress || s.debtUsd <= 0) return false;
      const targetKey = `${s.targetVaultChainId || vault.chainId}:${s.targetVaultAddress.toLowerCase()}`;
      return vaultLookup.has(targetKey);
    });
    if (!hasFundedOverlap) continue;

    const rootKey = `${vault.chainId}:${vault.address.toLowerCase()}`;
    const rootFees = feeByAddress.get(rootKey) || { performanceFee: 0, managementFee: 0 };

    const visited = new Set<string>([rootKey]);
    const root = buildNode(vault, vault.tvlUsd, 1.0, rootFees, vaultLookup, feeByAddress, visited, 0);

    if (root.children.length === 0) continue;

    const maxDepth = treeDepth(root);
    const { perfFee, mgmtFee } = deepestPathCompoundFee(root);

    chains.push({
      root,
      maxDepth,
      effectivePerfFee: perfFee,
      effectiveMgmtFee: mgmtFee,
    });
  }

  chains.sort((a, b) => b.effectivePerfFee - a.effectivePerfFee);

  const maxDepth = chains.reduce((m, c) => Math.max(m, c.maxDepth), 0);
  const maxEffectivePerfFee = chains.reduce((m, c) => Math.max(m, c.effectivePerfFee), 0);
  const avgEffectivePerfFee = chains.length > 0
    ? Math.round(chains.reduce((s, c) => s + c.effectivePerfFee, 0) / chains.length)
    : 0;
  const totalStackedCapital = chains.reduce((s, c) => s + c.root.capitalUsd, 0);

  return {
    chains,
    maxDepth,
    maxEffectivePerfFee,
    avgEffectivePerfFee,
    totalStackedCapital,
  };
}
