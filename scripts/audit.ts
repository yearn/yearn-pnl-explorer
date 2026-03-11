/**
 * Interactive TUI audit — per-chain/vault/strategy TVL breakdown.
 *
 * Usage: bun run audit [--include-retired] [--min-tvl=N] [--json]
 *
 * Controls:
 *   ↑/↓  Navigate          Enter/→  Expand chain/category/vault
 *   ←    Collapse (or jump to parent)   q/Esc  Quit
 *   1-3  Toggle categories: 1=Allocation(V3 alloc+V2) 2=Strategies 3=Curators
 */
import { db, vaults, vaultSnapshots, strategies, strategyDebts } from "@yearn-tvl/db";
import { eq, and, sql } from "drizzle-orm";
import { CHAIN_NAMES } from "@yearn-tvl/shared";

// --- Types ---

interface StrategyInfo {
  address: string;
  name: string | null;
  debtUsd: number;
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

// --- Data loading (unchanged) ---

async function buildAudit(): Promise<ChainInfo[]> {
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
    .innerJoin(latestIds, and(
      eq(vaultSnapshots.vaultId, latestIds.vaultId),
      eq(vaultSnapshots.id, latestIds.maxId),
    ));

  const vaultNameByAddr = new Map<string, string>();
  for (const r of rows) {
    if (r.name) vaultNameByAddr.set(`${r.chainId}:${r.address.toLowerCase()}`, r.name);
  }

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
    .innerJoin(latestDebtIds, and(
      eq(strategyDebts.strategyId, latestDebtIds.strategyId),
      eq(strategyDebts.id, latestDebtIds.maxId),
    ));

  const debtsByVault = new Map<number, StrategyInfo[]>();
  for (const d of debtRows) {
    if (!debtsByVault.has(d.vaultId)) debtsByVault.set(d.vaultId, []);
    const resolvedName = d.name
      || vaultNameByAddr.get(`${d.chainId}:${d.address.toLowerCase()}`)
      || null;
    debtsByVault.get(d.vaultId)!.push({
      address: d.address,
      name: resolvedName,
      debtUsd: d.debtUsd ?? 0,
    });
  }

  const IGNORED_CHAINS = new Set([999]);
  const chainMap = new Map<number, ChainInfo>();
  for (const r of rows) {
    if (IGNORED_CHAINS.has(r.chainId)) continue;
    if (!chainMap.has(r.chainId)) {
      chainMap.set(r.chainId, {
        chainId: r.chainId,
        name: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
        tvlUsd: 0,
        vaults: [],
      });
    }
    const chain = chainMap.get(r.chainId)!;
    const strats = (debtsByVault.get(r.id) || [])
      .filter((s) => s.debtUsd > 0)
      .sort((a, b) => b.debtUsd - a.debtUsd);

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
  }

  for (const chain of chainMap.values()) {
    const catOrder: Record<string, number> = { v3: 0, v2: 1, curation: 2 };
    chain.vaults.sort((a, b) => (catOrder[a.category] ?? 3) - (catOrder[b.category] ?? 3) || b.tvlUsd - a.tvlUsd);
  }

  return [...chainMap.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
}

// --- ANSI helpers ---

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const WHITE = `${ESC}37m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const RED = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;
const BG_BLUE = `${ESC}44m`;
const BG_GRAY = `${ESC}48;5;236m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

function colorTvl(n: number): string {
  const s = fmtUsd(n);
  if (n >= 10e6) return `${BOLD}${GREEN}${s}${RESET}`;
  if (n >= 1e6) return `${GREEN}${s}${RESET}`;
  if (n >= 100e3) return `${YELLOW}${s}${RESET}`;
  if (n >= 10e3) return `${WHITE}${s}${RESET}`;
  return `${DIM}${s}${RESET}`;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function padRight(s: string, len: number): string {
  // Strip ANSI for length calc
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= len) return s;
  return s + " ".repeat(len - visible.length);
}

function padLeft(s: string, len: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= len) return s;
  return " ".repeat(len - visible.length) + s;
}

// --- TUI row model ---

type RowKind = "chain" | "category" | "vault" | "strategy";

// Display categories: Allocation (V3 alloc + V2), Strategies (V3 strat), Curators (curation)
const DISPLAY_CATS = ["allocation", "strategies", "curators"] as const;
type DisplayCat = (typeof DISPLAY_CATS)[number];
const DCAT_LABELS: Record<string, string> = { allocation: "Allocation", strategies: "Strategies", curators: "Curators" };
const DCAT_COLORS: Record<string, string> = { allocation: CYAN, strategies: MAGENTA, curators: YELLOW };

function displayCat(v: VaultInfo): DisplayCat {
  if (v.category === "curation") return "curators";
  if (v.category === "v3" && v.vaultType === 2) return "strategies";
  return "allocation"; // V3 allocators + V2
}

// Category visibility — toggle keys 1-3
const DCAT_KEYS: Record<string, DisplayCat> = { "1": "allocation", "2": "strategies", "3": "curators" };
const DCAT_SHORT: Record<DisplayCat, string> = { allocation: "Alloc", strategies: "Strat", curators: "Cur" };

function allCatsVisible(): Set<DisplayCat> {
  return new Set(DISPLAY_CATS);
}

interface Row {
  kind: RowKind;
  chainIdx: number;
  category?: string;
  vaultIdx?: number;
  stratIdx?: number;
  expandable: boolean;
}

interface Opts {
  includeRetired: boolean;
  minTvl: number;
  visibleCats: Set<DisplayCat>;
}

function applyFilters(chain: ChainInfo, opts: Opts): VaultInfo[] {
  let out = opts.includeRetired ? chain.vaults : chain.vaults.filter((v) => !v.isRetired);
  out = out.filter((v) => v.tvlUsd >= opts.minTvl);
  out = out.filter((v) => opts.visibleCats.has(displayCat(v)));
  return out;
}

function buildRows(
  chains: ChainInfo[],
  expanded: Set<string>,
  opts: Opts,
): Row[] {
  const rows: Row[] = [];
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const filtered = applyFilters(chain, opts);
    if (filtered.length === 0) continue;

    rows.push({ kind: "chain", chainIdx: ci, expandable: true });
    if (!expanded.has(`chain:${ci}`)) continue;

    for (const dcat of DISPLAY_CATS) {
      if (!opts.visibleCats.has(dcat)) continue;
      const catVaults = filtered.filter((v) => displayCat(v) === dcat);
      if (catVaults.length === 0) continue;

      rows.push({ kind: "category", chainIdx: ci, category: dcat, expandable: true });
      if (!expanded.has(`cat:${ci}:${dcat}`)) continue;

      for (let vi = 0; vi < chain.vaults.length; vi++) {
        const vault = chain.vaults[vi];
        if (displayCat(vault) !== dcat) continue;
        if (!opts.includeRetired && vault.isRetired) continue;
        if (vault.tvlUsd < opts.minTvl) continue;
        const hasStrats = vault.strategies.length > 0;
        rows.push({ kind: "vault", chainIdx: ci, category: dcat, vaultIdx: vi, expandable: hasStrats });

        if (hasStrats && expanded.has(`${ci}:${vi}`)) {
          for (let si = 0; si < vault.strategies.length; si++) {
            rows.push({ kind: "strategy", chainIdx: ci, category: dcat, vaultIdx: vi, stratIdx: si, expandable: false });
          }
        }
      }
    }
  }
  return rows;
}

function renderRow(
  row: Row,
  chains: ChainInfo[],
  expanded: Set<string>,
  isSelected: boolean,
  width: number,
  opts: Opts,
): string {
  const chain = chains[row.chainIdx];
  const TVL_COL = 12;
  const highlight = isSelected ? BG_GRAY : "";
  const reset = isSelected ? `${RESET}${BG_GRAY}` : RESET;

  if (row.kind === "chain") {
    const filtered = applyFilters(chain, opts);
    const chainTvl = filtered.reduce((s, v) => s + v.tvlUsd, 0);
    const isExp = expanded.has(`chain:${row.chainIdx}`);
    const arrow = isExp ? `${DIM}▼${reset}` : `${DIM}▶${reset}`;
    const vaultCount = `${DIM}${filtered.length} vaults${RESET}`;
    const label = `${BOLD}${CYAN}${chain.name}${reset} ${DIM}(${chain.chainId})${reset}`;
    return `${highlight} ${arrow} ${label}  ${colorTvl(chainTvl)}  ${vaultCount}${RESET}`;
  }

  if (row.kind === "category") {
    const dcat = row.category!;
    const filtered = applyFilters(chain, opts).filter((v) => displayCat(v) === dcat);
    const catTvl = filtered.reduce((s, v) => s + v.tvlUsd, 0);
    const isExp = expanded.has(`cat:${row.chainIdx}:${dcat}`);
    const arrow = isExp ? `${DIM}▼${reset}` : `${DIM}▶${reset}`;
    const color = DCAT_COLORS[dcat] || WHITE;
    const label = `${BOLD}${color}${DCAT_LABELS[dcat] || dcat}${reset}`;
    const count = `${DIM}${filtered.length} vaults${RESET}`;
    return `${highlight}   ${arrow} ${label}  ${colorTvl(catTvl)}  ${count}${RESET}`;
  }

  if (row.kind === "vault") {
    const vault = chain.vaults[row.vaultIdx!];
    const key = `${row.chainIdx}:${row.vaultIdx}`;
    const isExpanded = expanded.has(key);

    // Expand indicator
    let arrow = "  ";
    if (vault.strategies.length > 0) {
      arrow = isExpanded ? `${DIM}▼ ${reset}` : `${DIM}▶ ${reset}`;
    }

    // Type tag
    const vType = vault.vaultType === 1 ? `${DIM}alloc${reset}` : vault.vaultType === 2 ? `${DIM}strat${reset}` : `${DIM}     ${reset}`;

    // Name
    const maxName = width - 35;
    let name = vault.name || vault.address;
    if (name.length > maxName) name = name.slice(0, maxName - 1) + "…";
    const nameStr = vault.isRetired ? `${RED}${name}${reset}` : `${WHITE}${name}${reset}`;

    // TVL right-aligned
    const tvl = padLeft(colorTvl(vault.tvlUsd), TVL_COL);

    return `${highlight}      ${arrow}${vType} ${padRight(nameStr, maxName)} ${tvl}${RESET}`;
  }

  if (row.kind === "strategy") {
    const vault = chain.vaults[row.vaultIdx!];
    const strat = vault.strategies[row.stratIdx!];
    const isLast = row.stratIdx === vault.strategies.length - 1;
    const prefix = isLast ? "└─" : "├─";
    const stratName = strat.name || `${strat.address.slice(0, 42)}`;
    const maxName = width - 35;
    const truncName = stratName.length > maxName ? stratName.slice(0, maxName - 1) + "…" : stratName;

    const tvl = padLeft(colorTvl(strat.debtUsd), TVL_COL);
    return `${highlight}           ${DIM}${prefix}${reset} ${DIM}${truncName.padEnd(maxName)}${reset} ${tvl}${RESET}`;
  }

  return "";
}

// --- Interactive TUI ---

async function runTui(chains: ChainInfo[], baseOpts: { includeRetired: boolean; minTvl: number }) {
  const expanded = new Set<string>();
  let cursor = 0;
  let scrollOffset = 0;
  const visibleCats = allCatsVisible();

  const getOpts = (): Opts => ({ ...baseOpts, visibleCats });

  const getTermSize = () => ({
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  });

  function render() {
    const opts = getOpts();
    const { cols, rows: termRows } = getTermSize();
    const allRows = buildRows(chains, expanded, opts);
    const viewHeight = termRows - 4; // header + footer

    // Clamp cursor
    if (cursor < 0) cursor = 0;
    if (cursor >= allRows.length) cursor = allRows.length - 1;

    // Adjust scroll
    if (cursor < scrollOffset) scrollOffset = cursor;
    if (cursor >= scrollOffset + viewHeight) scrollOffset = cursor - viewHeight + 1;

    // Grand total
    let grandTotal = 0;
    let vaultCount = 0;
    for (const c of chains) {
      const fv = applyFilters(c, opts);
      grandTotal += fv.reduce((s, v) => s + v.tvlUsd, 0);
      vaultCount += fv.length;
    }

    // Draw
    process.stdout.write(`${ESC}H${ESC}J`); // clear screen

    // Header
    const titleText = " Yearn TVL Audit";
    const isFiltered = visibleCats.size < DISPLAY_CATS.length;
    const filterTag = isFiltered ? ` [${[...visibleCats].map((c) => DCAT_SHORT[c]).join("+")}]` : "";
    const totalText = `Total: ${fmtUsd(grandTotal)}  ${vaultCount} vaults${filterTag}`;
    const gap = Math.max(1, cols - titleText.length - totalText.length - 1);
    process.stdout.write(`${BG_BLUE}${BOLD}${WHITE}${titleText}${" ".repeat(gap)}${totalText} ${RESET}\n`);

    // Rows
    const visible = allRows.slice(scrollOffset, scrollOffset + viewHeight);
    for (let i = 0; i < viewHeight; i++) {
      if (i < visible.length) {
        const row = visible[i];
        const isSelected = scrollOffset + i === cursor;
        const line = renderRow(row, chains, expanded, isSelected, cols, opts);
        process.stdout.write(line + "\n");
      } else {
        process.stdout.write("\n");
      }
    }

    // Footer — show toggle keys with on/off indicators
    const toggles = DISPLAY_CATS.map((dcat, i) => {
      const on = visibleCats.has(dcat);
      return `${on ? WHITE : DIM}${i + 1}:${DCAT_SHORT[dcat]}${RESET}`;
    }).join(" ");
    const helpPlain = ` ↑↓ navigate  Enter/→ expand  ← collapse  q quit  `;
    const togglePlain = DISPLAY_CATS.map((dcat, i) => `${i + 1}:${DCAT_SHORT[dcat]}`).join(" ");
    const pad = Math.max(0, cols - helpPlain.length - togglePlain.length);
    process.stdout.write(`${BG_BLUE}${DIM}${helpPlain}${RESET}${BG_BLUE}${toggles}${" ".repeat(pad)}${RESET}`);
  }

  // Raw mode for keyboard input
  process.stdout.write(HIDE_CURSOR);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  render();

  for await (const chunk of process.stdin) {
    const key = chunk.toString();

    if (key === "q" || key === "\x1b" || key === "\x03") {
      // q, Esc, Ctrl-C
      break;
    }

    if (key in DCAT_KEYS) {
      // 1-4 toggle category visibility
      const cat = DCAT_KEYS[key];
      if (visibleCats.has(cat)) {
        if (visibleCats.size > 1) visibleCats.delete(cat); // prevent empty
      } else {
        visibleCats.add(cat);
      }
    }

    const allRows = buildRows(chains, expanded, getOpts());

    if (key === "\x1b[A") {
      // Up
      cursor--;
      // Skip chain headers when navigating? No, keep them selectable for context
    } else if (key === "\x1b[B") {
      // Down
      cursor++;
    } else if (key === "\r" || key === "\x1b[C") {
      // Enter or Right — expand
      const row = allRows[cursor];
      if (row?.kind === "chain") {
        expanded.add(`chain:${row.chainIdx}`);
      } else if (row?.kind === "category") {
        expanded.add(`cat:${row.chainIdx}:${row.category}`);
      } else if (row?.kind === "vault" && row.expandable) {
        expanded.add(`${row.chainIdx}:${row.vaultIdx}`);
      }
    } else if (key === "\x1b[D") {
      // Left — collapse current, or jump to parent
      const row = allRows[cursor];
      if (row?.kind === "chain") {
        expanded.delete(`chain:${row.chainIdx}`);
      } else if (row?.kind === "category") {
        const catKey = `cat:${row.chainIdx}:${row.category}`;
        if (expanded.has(catKey)) {
          expanded.delete(catKey);
        } else {
          // Jump to parent chain
          expanded.delete(`chain:${row.chainIdx}`);
          for (let i = cursor - 1; i >= 0; i--) {
            if (allRows[i].kind === "chain" && allRows[i].chainIdx === row.chainIdx) { cursor = i; break; }
          }
        }
      } else if (row?.kind === "vault") {
        const vaultKey = `${row.chainIdx}:${row.vaultIdx}`;
        if (expanded.has(vaultKey)) {
          expanded.delete(vaultKey);
        } else {
          // Jump to parent category
          expanded.delete(`cat:${row.chainIdx}:${row.category}`);
          for (let i = cursor - 1; i >= 0; i--) {
            if (allRows[i].kind === "category" && allRows[i].chainIdx === row.chainIdx && allRows[i].category === row.category) { cursor = i; break; }
          }
        }
      } else if (row?.kind === "strategy") {
        // Collapse parent vault and jump to it
        expanded.delete(`${row.chainIdx}:${row.vaultIdx}`);
        for (let i = cursor - 1; i >= 0; i--) {
          if (allRows[i].kind === "vault" && allRows[i].chainIdx === row.chainIdx && allRows[i].vaultIdx === row.vaultIdx) { cursor = i; break; }
        }
      }
    } else if (key === "g") {
      cursor = 0;
      scrollOffset = 0;
    } else if (key === "G") {
      cursor = allRows.length - 1;
    }

    render();
  }

  // Cleanup
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write(`${ESC}H${ESC}J`);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

// --- Static print (for --json or piped output) ---

function printStatic(chains: ChainInfo[], opts: Opts) {
  const width = process.stdout.columns || 100;
  const expanded = new Set<string>();
  for (let ci = 0; ci < chains.length; ci++) {
    expanded.add(`chain:${ci}`);
    for (const dcat of DISPLAY_CATS) expanded.add(`cat:${ci}:${dcat}`);
    for (let vi = 0; vi < chains[ci].vaults.length; vi++) {
      expanded.add(`${ci}:${vi}`);
    }
  }
  const allRows = buildRows(chains, expanded, opts);
  for (const row of allRows) {
    console.log(renderRow(row, chains, expanded, false, width, opts));
  }

  let grandTotal = 0;
  for (const c of chains) {
    grandTotal += applyFilters(c, opts).reduce((s, v) => s + v.tvlUsd, 0);
  }
  console.log(`\n${BOLD}Total: ${colorTvl(grandTotal)}${RESET}`);
}

// --- CLI ---

const args = process.argv.slice(2);
const includeRetired = args.includes("--include-retired");
const minTvlArg = args.find((a) => a.startsWith("--min-tvl="));
const minTvl = minTvlArg ? Number(minTvlArg.split("=")[1]) : 0;
const jsonOutput = args.includes("--json");
const staticOutput = args.includes("--static");

const chains = await buildAudit();
const opts: Opts = { includeRetired, minTvl, visibleCats: allCatsVisible() };

if (jsonOutput) {
  const filtered = chains.map((c) => ({
    ...c,
    vaults: applyFilters(c, opts),
  })).filter((c) => c.vaults.length > 0);
  console.log(JSON.stringify(filtered, null, 2));
} else if (staticOutput || !process.stdin.isTTY) {
  printStatic(chains, opts);
} else {
  await runTui(chains, opts);
}
