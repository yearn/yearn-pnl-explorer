/**
 * CLI audit tool — per-chain/vault/strategy TVL breakdown.
 *
 * Usage: bun run audit [subcommand] [flags]
 *
 * Subcommands:
 *   tvl          TVL summary by chain/category (default)
 *   overlaps     All detected strategy→vault overlaps
 *   vault <addr> Single vault detail with strategies
 *   fees         Fee summary per chain/category
 *   depositors   Depositor concentration summary
 *   help         Show usage info
 *
 * Flags:
 *   --json       JSON output (default)
 *   --table      Human-readable aligned columns
 *   --chain=<id> Filter by chain
 *   --min-tvl=N  Minimum TVL filter
 *   --include-retired
 *   --category=<allocation|strategies|curators>
 */
import { db, depositors, strategies, strategyDebts, vaultSnapshots, vaults } from "@yearn-tvl/db";
import { CHAIN_NAMES, STRATEGY_OVERLAP_REGISTRY } from "@yearn-tvl/shared";
import { and, eq, sql } from "drizzle-orm";
// Direct import from api package internals — workspace packages allow this
import { getFeeSummary } from "../packages/api/src/services/fees.js";

// --- Types ---

interface StrategyInfo {
  address: string;
  name: string | null;
  debtUsd: number;
  overlap?: "auto" | "registry";
  overlapTarget?: string;
}

interface VaultInfo {
  address: string;
  name: string | null;
  category: string;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
  strategies: StrategyInfo[];
}

interface ChainInfo {
  chainId: number;
  name: string;
  tvlUsd: number;
  vaults: VaultInfo[];
}

// --- Data loading ---

export async function buildAudit(): Promise<ChainInfo[]> {
  const latestIds = db
    .select({
      vaultId: vaultSnapshots.vaultId,
      maxId: sql<number>`MAX(${vaultSnapshots.id})`.as("max_id"),
    })
    .from(vaultSnapshots)
    .groupBy(vaultSnapshots.vaultId)
    .as("latest");

  const rows = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      vaultType: vaults.vaultType,
      isRetired: vaults.isRetired,
      tvlUsd: vaultSnapshots.tvlUsd,
    })
    .from(vaults)
    .innerJoin(vaultSnapshots, eq(vaultSnapshots.vaultId, vaults.id))
    .innerJoin(latestIds, and(eq(vaultSnapshots.vaultId, latestIds.vaultId), eq(vaultSnapshots.id, latestIds.maxId)));

  const vaultNameByAddr = new Map<string, string>(
    rows.filter((r) => r.name).map((r) => [`${r.chainId}:${r.address.toLowerCase()}`, r.name!]),
  );

  const latestDebtIds = db
    .select({
      strategyId: strategyDebts.strategyId,
      maxId: sql<number>`MAX(${strategyDebts.id})`.as("max_id"),
    })
    .from(strategyDebts)
    .groupBy(strategyDebts.strategyId)
    .as("latestDebt");

  const debtRows = await db
    .select({
      strategyId: strategies.id,
      address: strategies.address,
      name: strategies.name,
      vaultId: strategies.vaultId,
      chainId: strategies.chainId,
      debtUsd: strategyDebts.currentDebtUsd,
    })
    .from(strategies)
    .innerJoin(strategyDebts, eq(strategyDebts.strategyId, strategies.id))
    .innerJoin(latestDebtIds, and(eq(strategyDebts.strategyId, latestDebtIds.strategyId), eq(strategyDebts.id, latestDebtIds.maxId)));

  const vaultAddrSet = new Set(rows.map((r) => `${r.chainId}:${r.address.toLowerCase()}`));
  const registryByKey = new Map(STRATEGY_OVERLAP_REGISTRY.map((e) => [`${e.chainId}:${e.strategyAddress.toLowerCase()}`, e]));

  const debtsByVault = debtRows.reduce((acc, d) => {
    if (!acc.has(d.vaultId)) acc.set(d.vaultId, []);
    const key = `${d.chainId}:${d.address.toLowerCase()}`;

    const overlapInfo = vaultAddrSet.has(key)
      ? {
          overlap: "auto" as const,
          overlapTarget: vaultNameByAddr.get(key) ?? undefined,
          resolvedName: d.name || vaultNameByAddr.get(key) || null,
        }
      : (() => {
          const regEntry = registryByKey.get(key);
          return regEntry
            ? {
                overlap: "registry" as const,
                overlapTarget: vaultNameByAddr.get(`${regEntry.chainId}:${regEntry.targetVaultAddress.toLowerCase()}`) ?? undefined,
                resolvedName: d.name || regEntry.label || null,
              }
            : { overlap: undefined, overlapTarget: undefined, resolvedName: d.name };
        })();

    acc.get(d.vaultId)!.push({
      address: d.address,
      name: overlapInfo.resolvedName,
      debtUsd: d.debtUsd ?? 0,
      overlap: overlapInfo.overlap,
      overlapTarget: overlapInfo.overlapTarget,
    });
    return acc;
  }, new Map<number, StrategyInfo[]>());

  const IGNORED_CHAINS = new Set([999]);
  const chainMap = rows
    .filter((r) => !IGNORED_CHAINS.has(r.chainId))
    .reduce((acc, r) => {
      if (!acc.has(r.chainId)) {
        acc.set(r.chainId, {
          chainId: r.chainId,
          name: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
          tvlUsd: 0,
          vaults: [],
        });
      }
      const chain = acc.get(r.chainId)!;
      const strats = (debtsByVault.get(r.id) || []).filter((s) => s.debtUsd > 0).sort((a, b) => b.debtUsd - a.debtUsd);

      const tvl = r.tvlUsd ?? 0;
      chain.tvlUsd += tvl;
      chain.vaults.push({
        address: r.address,
        name: r.name,
        category: r.category,
        vaultType: r.vaultType,
        tvlUsd: tvl,
        isRetired: r.isRetired ?? false,
        strategies: strats,
      });
      return acc;
    }, new Map<number, ChainInfo>());

  const catOrder: Record<string, number> = { v3: 0, v2: 1, curation: 2 };
  [...chainMap.values()].forEach((chain) => {
    chain.vaults.sort((a, b) => (catOrder[a.category] ?? 3) - (catOrder[b.category] ?? 3) || b.tvlUsd - a.tvlUsd);
  });

  return [...chainMap.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
}

// --- Shared utilities ---

type DisplayCat = "allocation" | "strategies" | "curators";

function displayCat(v: VaultInfo): DisplayCat {
  if (v.category === "curation") return "curators";
  if (v.category === "v3" && v.vaultType === 2) return "strategies";
  return "allocation";
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

interface FilterOpts {
  includeRetired: boolean;
  minTvl: number;
  chainId?: number;
  category?: DisplayCat;
}

function applyFilters(chain: ChainInfo, opts: FilterOpts): VaultInfo[] {
  const base = opts.includeRetired ? chain.vaults : chain.vaults.filter((v) => !v.isRetired);
  const withMinTvl = base.filter((v) => v.tvlUsd >= opts.minTvl);
  return opts.category ? withMinTvl.filter((v) => displayCat(v) === opts.category) : withMinTvl;
}

function computeOverlapTotal(chains: ChainInfo[], opts: FilterOpts): number {
  return chains
    .flatMap((c) => applyFilters(c, opts))
    .flatMap((v) => v.strategies)
    .filter((s) => s.overlap && s.debtUsd > 0)
    .reduce((sum, s) => sum + s.debtUsd, 0);
}

// --- Subcommands ---

async function cmdTvl(chains: ChainInfo[], opts: FilterOpts, tableMode: boolean) {
  const filtered = chains
    .filter((c) => !opts.chainId || c.chainId === opts.chainId)
    .map((c) => ({ ...c, vaults: applyFilters(c, opts) }))
    .filter((c) => c.vaults.length > 0);

  const { totalTvl, totalVaults, byChain, byCategory } = filtered.reduce(
    (acc, c) => {
      const chainTvl = c.vaults.reduce((sum, v) => sum + v.tvlUsd, 0);
      c.vaults.forEach((v) => {
        const cat = displayCat(v);
        if (!acc.byCategory[cat]) acc.byCategory[cat] = { tvl: 0, count: 0 };
        acc.byCategory[cat].tvl += v.tvlUsd;
        acc.byCategory[cat].count++;
      });
      acc.totalTvl += chainTvl;
      acc.totalVaults += c.vaults.length;
      acc.byChain.push({ chain: c.name, chainId: c.chainId, tvl: chainTvl, vaults: c.vaults.length });
      return acc;
    },
    {
      totalTvl: 0,
      totalVaults: 0,
      byChain: [] as Array<{ chain: string; chainId: number; tvl: number; vaults: number }>,
      byCategory: {} as Record<string, { tvl: number; count: number }>,
    },
  );

  const overlapTvl = computeOverlapTotal(filtered, opts);
  const netTvl = totalTvl - overlapTvl;

  if (tableMode) {
    console.log(`Total TVL: ${fmtUsd(netTvl)} (${fmtUsd(totalTvl)} - ${fmtUsd(overlapTvl)} overlap)`);
    console.log(`Vaults: ${totalVaults}\n`);
    console.log(padRight("Chain", 15) + padLeft("TVL", 14) + padLeft("Vaults", 10));
    console.log("-".repeat(39));
    byChain.forEach((row) => {
      console.log(padRight(row.chain, 15) + padLeft(fmtUsd(row.tvl), 14) + padLeft(String(row.vaults), 10));
    });
    console.log();
    console.log(padRight("Category", 15) + padLeft("TVL", 14) + padLeft("Count", 10));
    console.log("-".repeat(39));
    Object.entries(byCategory)
      .sort((a, b) => b[1].tvl - a[1].tvl)
      .forEach(([cat, data]) => {
        console.log(padRight(cat, 15) + padLeft(fmtUsd(data.tvl), 14) + padLeft(String(data.count), 10));
      });
  } else {
    console.log(JSON.stringify({ totalTvl, overlapTvl, netTvl, vaultCount: totalVaults, byChain, byCategory }, null, 2));
  }
}

async function cmdOverlaps(chains: ChainInfo[], opts: FilterOpts, tableMode: boolean) {
  const overlaps = chains
    .filter((chain) => !opts.chainId || chain.chainId === opts.chainId)
    .flatMap((chain) =>
      applyFilters(chain, opts).flatMap((vault) =>
        vault.strategies
          .filter((strat) => strat.overlap)
          .map((strat) => ({
            sourceVault: vault.name || vault.address,
            sourceAddress: vault.address,
            strategy: strat.address,
            targetVault: strat.overlapTarget || "unknown",
            chainId: chain.chainId,
            debtUsd: strat.debtUsd,
            method: strat.overlap!,
          })),
      ),
    );

  overlaps.sort((a, b) => b.debtUsd - a.debtUsd);

  if (tableMode) {
    console.log(`Found ${overlaps.length} overlaps\n`);
    console.log(`${padRight("Source", 30) + padRight("Target", 30) + padLeft("Debt USD", 14)}  Method`);
    console.log("-".repeat(80));
    overlaps.forEach((o) => {
      console.log(
        padRight((o.sourceVault || "").slice(0, 28), 30) +
          padRight((o.targetVault || "").slice(0, 28), 30) +
          padLeft(fmtUsd(o.debtUsd), 14) +
          "  " +
          o.method,
      );
    });
  } else {
    console.log(JSON.stringify(overlaps, null, 2));
  }
}

async function cmdVault(chains: ChainInfo[], address: string, tableMode: boolean) {
  const addr = address.toLowerCase();
  const found = chains.reduce<{ vault: VaultInfo; chainName: string; chainId: number } | null>((result, chain) => {
    if (result) return result;
    const vault = chain.vaults.find((v) => v.address.toLowerCase() === addr);
    return vault ? { vault, chainName: chain.name, chainId: chain.chainId } : null;
  }, null);

  if (!found) {
    console.error(`Vault ${address} not found`);
    process.exit(1);
  }

  const { vault, chainName, chainId } = found;

  if (tableMode) {
    console.log(`${vault.name || vault.address}`);
    console.log(`Chain: ${chainName} (${chainId})`);
    console.log(`Category: ${vault.category}  Type: ${vault.vaultType ?? "N/A"}  Retired: ${vault.isRetired}`);
    console.log(`TVL: ${fmtUsd(vault.tvlUsd)}`);
    if (vault.strategies.length > 0) {
      console.log(`\nStrategies (${vault.strategies.length}):`);
      vault.strategies.forEach((s) => {
        const overlapTag = s.overlap ? ` [${s.overlap} -> ${s.overlapTarget || "?"}]` : "";
        console.log(`  ${s.name || s.address.slice(0, 42)}  ${fmtUsd(s.debtUsd)}${overlapTag}`);
      });
    }
  } else {
    console.log(
      JSON.stringify(
        {
          address: vault.address,
          name: vault.name,
          chain: chainName,
          chainId,
          category: vault.category,
          vaultType: vault.vaultType,
          tvlUsd: vault.tvlUsd,
          isRetired: vault.isRetired,
          strategies: vault.strategies,
        },
        null,
        2,
      ),
    );
  }
}

async function cmdFees(tableMode: boolean) {
  const summary = await getFeeSummary();

  if (tableMode) {
    console.log(`Total Fee Revenue: ${fmtUsd(summary.totalFeeRevenue)}`);
    console.log(`Performance: ${fmtUsd(summary.performanceFeeRevenue)}  Management: ${fmtUsd(summary.managementFeeRevenue)}`);
    console.log(`Total Gains: ${fmtUsd(summary.totalGains)}  Reports: ${summary.reportCount}\n`);
    console.log(padRight("Chain", 15) + padLeft("Fee Revenue", 14) + padLeft("Gains", 14) + padLeft("Vaults", 10));
    console.log("-".repeat(53));
    Object.entries(summary.byChain)
      .sort((a, b) => b[1].feeRevenue - a[1].feeRevenue)
      .forEach(([chain, data]) => {
        console.log(
          padRight(chain, 15) +
            padLeft(fmtUsd(data.feeRevenue), 14) +
            padLeft(fmtUsd(data.gains), 14) +
            padLeft(String(data.vaultCount), 10),
        );
      });
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

async function cmdDepositors(tableMode: boolean) {
  const stats = await db
    .select({
      vaultId: depositors.vaultId,
      depositorCount: sql<number>`COUNT(DISTINCT ${depositors.address})`,
      totalBalanceUsd: sql<number>`COALESCE(SUM(${depositors.balanceUsd}), 0)`,
      maxBalanceUsd: sql<number>`COALESCE(MAX(${depositors.balanceUsd}), 0)`,
    })
    .from(depositors)
    .groupBy(depositors.vaultId);

  const statsMap = new Map(stats.map((s) => [s.vaultId, s]));

  const vaultRows = await db.select({ id: vaults.id, address: vaults.address, chainId: vaults.chainId, name: vaults.name }).from(vaults);

  const result = vaultRows
    .filter((v) => statsMap.has(v.id))
    .map((v) => {
      const s = statsMap.get(v.id)!;
      const topPct = s.totalBalanceUsd > 0 ? (s.maxBalanceUsd / s.totalBalanceUsd) * 100 : 0;
      return {
        address: v.address,
        chainId: v.chainId,
        name: v.name,
        depositorCount: s.depositorCount,
        totalBalanceUsd: s.totalBalanceUsd,
        topDepositorPercent: Math.round(topPct * 100) / 100,
      };
    })
    .sort((a, b) => b.totalBalanceUsd - a.totalBalanceUsd);

  if (tableMode) {
    console.log(`${result.length} vaults with depositor data\n`);
    console.log(padRight("Vault", 30) + padLeft("Balance", 14) + padLeft("Depositors", 12) + padLeft("Top %", 10));
    console.log("-".repeat(66));
    result.slice(0, 30).forEach((r) => {
      console.log(
        padRight((r.name || r.address.slice(0, 10)).slice(0, 28), 30) +
          padLeft(fmtUsd(r.totalBalanceUsd), 14) +
          padLeft(String(r.depositorCount), 12) +
          padLeft(`${r.topDepositorPercent.toFixed(1)}%`, 10),
      );
    });
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

function printHelp() {
  process.stderr.write(`
Yearn Metrics CLI Audit Tool

Usage: bun run audit [subcommand] [flags]

Subcommands:
  tvl          TVL summary by chain/category (default)
  overlaps     All detected strategy→vault overlaps
  vault <addr> Single vault detail with strategies
  fees         Fee summary per chain/category
  depositors   Depositor concentration summary
  help         Show this help

Flags:
  --json             JSON output (default)
  --table            Human-readable aligned columns
  --chain=<id>       Filter by chain ID
  --min-tvl=<N>      Minimum TVL filter (default: 0)
  --include-retired  Include retired vaults
  --category=<cat>   Filter: allocation, strategies, or curators

Examples:
  bun run audit                          # TVL summary as JSON
  bun run audit tvl --table              # TVL table
  bun run audit overlaps --json          # Overlaps as JSON
  bun run audit vault 0xabc... --table   # Vault detail
  bun run audit fees --table             # Fee summary table
  bun run audit tvl --chain=1 --table    # Ethereum only
`);
}

// --- CLI entry point ---

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Parse flags
  const includeRetired = args.includes("--include-retired");
  const minTvlArg = args.find((a) => a.startsWith("--min-tvl="));
  const minTvl = minTvlArg ? Number(minTvlArg.split("=")[1]) : 0;
  const chainArg = args.find((a) => a.startsWith("--chain="));
  const chainId = chainArg ? Number(chainArg.split("=")[1]) : undefined;
  const catArg = args.find((a) => a.startsWith("--category="));
  const category = catArg ? (catArg.split("=")[1] as DisplayCat) : undefined;
  const tableMode = args.includes("--table");

  // Parse subcommand (first non-flag arg)
  const positional = args.filter((a) => !a.startsWith("--"));
  const subcommand = positional[0] || "tvl";

  const filterOpts: FilterOpts = { includeRetired, minTvl, chainId, category };

  switch (subcommand) {
    case "help":
      printHelp();
      break;

    case "tvl": {
      const chains = await buildAudit();
      await cmdTvl(chains, filterOpts, tableMode);
      break;
    }

    case "overlaps": {
      const chains = await buildAudit();
      await cmdOverlaps(chains, filterOpts, tableMode);
      break;
    }

    case "vault": {
      const addr = positional[1];
      if (!addr) {
        process.stderr.write("Error: vault subcommand requires an address\n");
        process.exit(1);
      }
      const chains = await buildAudit();
      await cmdVault(chains, addr, tableMode);
      break;
    }

    case "fees":
      await cmdFees(tableMode);
      break;

    case "depositors":
      await cmdDepositors(tableMode);
      break;

    default:
      // If it looks like an address, treat as vault lookup
      if (subcommand.startsWith("0x")) {
        const chains = await buildAudit();
        await cmdVault(chains, subcommand, tableMode);
      } else {
        process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
        printHelp();
        process.exit(1);
      }
  }
}
