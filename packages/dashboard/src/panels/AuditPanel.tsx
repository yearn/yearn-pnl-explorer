import { useContext, useEffect, useMemo, useState } from "react";
import { DashboardContext } from "../App";
import {
  CHAIN_NAMES,
  CHAIN_SHORT,
  EXPLORER_URLS,
  fmt,
  SkeletonCards,
  SkeletonChart,
  shortAddr,
  useDebouncedValue,
  useFetch,
} from "../hooks";

interface AuditStrategy {
  address: string;
  name: string | null;
  debtUsd: number;
  targetVaultAddress: string | null;
  targetVaultChainId: number | null;
  detectionMethod: "auto" | "registry" | null;
  label: string | null;
}

interface AuditVault {
  address: string;
  chainId: number;
  name: string | null;
  category: string;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
  strategies: AuditStrategy[];
}

interface AuditTreeResponse {
  summedTvl: number;
  overlapTvl: number;
  crossChainOverlap: number;
  vaultCount: number;
  vaults: AuditVault[];
}

function categoryBadge(cat: string) {
  const cls =
    cat === "v2" ? "badge badge-v2" : cat === "v3" ? "badge badge-v3" : cat === "curation" ? "badge badge-curation" : "badge badge-v1";
  return <span className={cls}>{cat}</span>;
}

function typeBadge(vaultType: number | null) {
  if (vaultType === 1)
    return (
      <span className="badge" style={{ background: "var(--green-dim)", color: "var(--green)", fontSize: "0.6rem" }}>
        allocator
      </span>
    );
  if (vaultType === 2)
    return (
      <span className="badge" style={{ background: "var(--blue-dim)", color: "var(--blue)", fontSize: "0.6rem" }}>
        strategy
      </span>
    );
  return null;
}

/** Compute the "counted TVL" for a vault: raw TVL minus overlap from its strategies */
function computeCountedTvl(vault: AuditVault): number {
  const overlapDeduction = vault.strategies.filter((s) => s.detectionMethod != null).reduce((sum, s) => sum + s.debtUsd, 0);
  return Math.max(0, vault.tvlUsd - overlapDeduction);
}

/** Recursive strategy tree node */
function StrategyNode({
  strategy,
  vaultMap,
  depth,
  visited,
  topLevelAddresses,
  isLast,
  parentChainId,
}: {
  strategy: AuditStrategy;
  vaultMap: Map<string, AuditVault>;
  depth: number;
  visited: Set<string>;
  topLevelAddresses: Set<string>;
  isLast: boolean;
  parentChainId: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const targetVault = strategy.targetVaultAddress
    ? vaultMap.get(`${strategy.targetVaultChainId}:${strategy.targetVaultAddress.toLowerCase()}`)
    : null;

  const hasTarget = targetVault != null;
  const targetKey = targetVault ? `${targetVault.chainId}:${targetVault.address.toLowerCase()}` : null;
  const isCycle = targetKey ? visited.has(targetKey) : false;
  const isTopLevelTarget = targetKey ? topLevelAddresses.has(targetKey) : false;

  const nextVisited = targetKey
    ? (() => {
        const s = new Set(visited);
        s.add(targetKey);
        return s;
      })()
    : visited;

  return (
    <div className="audit-strategy-node">
      {/* Strategy row */}
      <div
        className={`audit-row audit-strategy-row${strategy.detectionMethod ? " audit-strategy-deducted" : ""}`}
        style={{
          paddingLeft: `${depth * 1.5 + 1.5}rem`,
          background: `rgba(46, 230, 182, ${0.015 + depth * 0.015})`,
          cursor: hasTarget ? "pointer" : "default",
        }}
        onClick={() => hasTarget && setExpanded((e) => !e)}
      >
        <span className="text-dim" style={{ fontSize: "0.75rem", flexShrink: 0 }}>
          {isLast ? "\u2514\u2500" : "\u251C\u2500"}
        </span>
        <span style={{ color: "var(--accent)", fontSize: "0.65rem", flexShrink: 0, opacity: 0.6 }}>{"\u2192"}</span>
        {hasTarget && (
          <span className="audit-toggle" style={{ width: 14 }}>
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
        )}
        {EXPLORER_URLS[parentChainId] ? (
          <a
            href={`${EXPLORER_URLS[parentChainId]}/${strategy.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="audit-strategy-name"
            title={strategy.name || strategy.address}
            onClick={(e) => e.stopPropagation()}
          >
            {strategy.name || shortAddr(strategy.address)}
          </a>
        ) : (
          <span className="audit-strategy-name" title={strategy.name || strategy.address}>
            {strategy.name || shortAddr(strategy.address)}
          </span>
        )}
        {strategy.debtUsd > 0 && (
          <span className={`audit-debt${!strategy.detectionMethod ? " audit-debt-prominent" : ""}`}>{fmt(strategy.debtUsd)}</span>
        )}
        {strategy.detectionMethod && (
          <span className={`audit-overlap-tag-prominent ${strategy.detectionMethod === "auto" ? "auto" : "registry"}`}>
            {strategy.detectionMethod === "auto" ? "overlap (auto)" : strategy.label || "overlap (registry)"}
          </span>
        )}
        {isCycle && <span className="audit-cycle-tag">cycle</span>}
      </div>

      {/* Target vault + its strategies (collapsed by default) */}
      {expanded && hasTarget && targetVault && (
        <>
          <div
            className={`audit-row audit-target-vault-row${strategy.detectionMethod ? " audit-strategy-deducted" : ""}`}
            style={{
              paddingLeft: `${(depth + 1) * 1.5 + 1.5}rem`,
              background: `rgba(46, 230, 182, ${0.015 + (depth + 1) * 0.015})`,
            }}
          >
            <span className="text-dim" style={{ fontSize: "0.75rem", flexShrink: 0 }}>
              {"\u2514\u2500"}
            </span>
            <span style={{ color: "var(--accent)", fontSize: "0.65rem", flexShrink: 0, opacity: 0.6 }}>{"\u2192"}</span>
            <span className="audit-vault-indicator">VAULT</span>
            {EXPLORER_URLS[targetVault.chainId] ? (
              <a
                href={`${EXPLORER_URLS[targetVault.chainId]}/${targetVault.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="audit-vault-name"
                title={targetVault.name || targetVault.address}
                onClick={(e) => e.stopPropagation()}
              >
                {targetVault.name || shortAddr(targetVault.address)}
              </a>
            ) : (
              <span className="audit-vault-name" title={targetVault.name || targetVault.address}>
                {targetVault.name || shortAddr(targetVault.address)}
              </span>
            )}
            {categoryBadge(targetVault.category)}
            {typeBadge(targetVault.vaultType)}
            <span className="audit-tvl">{fmt(targetVault.tvlUsd)}</span>
            {targetVault.isRetired && (
              <span
                className="badge"
                style={{ background: "var(--red-dim)", color: "var(--red)", fontSize: "0.6rem", padding: "0.05rem 0.35rem" }}
              >
                retired
              </span>
            )}
          </div>
          {!isCycle &&
            !isTopLevelTarget &&
            targetVault.strategies.map((strat, i) => (
              <StrategyNode
                key={strat.address}
                strategy={strat}
                vaultMap={vaultMap}
                depth={depth + 2}
                visited={nextVisited}
                topLevelAddresses={topLevelAddresses}
                isLast={i === targetVault.strategies.length - 1}
                parentChainId={targetVault.chainId}
              />
            ))}
        </>
      )}
    </div>
  );
}

/** Top-level vault node */
function VaultNode({
  vault,
  vaultMap,
  topLevelAddresses,
}: {
  vault: AuditVault;
  vaultMap: Map<string, AuditVault>;
  topLevelAddresses: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasStrategies = vault.strategies.length > 0;
  const hasOverlap = vault.strategies.some((s) => s.targetVaultAddress != null);
  const overlapCount = vault.strategies.filter((s) => s.targetVaultAddress != null).length;

  const visited = new Set<string>();
  visited.add(`${vault.chainId}:${vault.address.toLowerCase()}`);

  const countedTvl = computeCountedTvl(vault);
  const hasDeduction = countedTvl < vault.tvlUsd - 1; // $1 tolerance for rounding

  return (
    <div className={`audit-vault-node${hasOverlap ? " has-overlap" : ""}`}>
      <div
        className="audit-row audit-vault-row"
        onClick={() => hasStrategies && setExpanded((e) => !e)}
        style={{ cursor: hasStrategies ? "pointer" : "default" }}
      >
        {hasStrategies && <span className="audit-toggle">{expanded ? "\u25BC" : "\u25B6"}</span>}
        {!hasStrategies && <span className="audit-toggle-placeholder" />}

        {EXPLORER_URLS[vault.chainId] ? (
          <a
            href={`${EXPLORER_URLS[vault.chainId]}/${vault.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="audit-vault-name"
            title={vault.name || vault.address}
            onClick={(e) => e.stopPropagation()}
          >
            {vault.name || shortAddr(vault.address)}
          </a>
        ) : (
          <span className="audit-vault-name" title={vault.name || vault.address}>
            {vault.name || shortAddr(vault.address)}
          </span>
        )}

        <span className="text-dim" style={{ fontSize: "0.7rem" }}>
          {CHAIN_SHORT[vault.chainId] || CHAIN_NAMES[vault.chainId] || vault.chainId}
        </span>

        {categoryBadge(vault.category)}
        {typeBadge(vault.vaultType)}

        {vault.isRetired && (
          <span
            className="badge"
            style={{ background: "var(--red-dim)", color: "var(--red)", fontSize: "0.6rem", padding: "0.05rem 0.35rem" }}
          >
            retired
          </span>
        )}

        {/* ── Right-aligned columns: strats | TVL | overlaps | counted ── */}
        <span className="audit-cols">
          <span className="audit-col-strats">
            {hasStrategies ? `${vault.strategies.length} strat${vault.strategies.length > 1 ? "s" : ""}` : "\u2014"}
          </span>
          <span className="audit-col-tvl">{fmt(vault.tvlUsd)}</span>
          <span className="audit-col-overlaps">
            {overlapCount > 0 ? (
              <span className="audit-overlap-count">
                {overlapCount} overlap{overlapCount > 1 ? "s" : ""}
              </span>
            ) : (
              <span className="audit-col-empty">{"\u2014"}</span>
            )}
          </span>
          <span className="audit-col-counted" title="TVL after deducting overlap from this vault's strategies">
            {hasDeduction ? fmt(countedTvl) : fmt(vault.tvlUsd)}
          </span>
        </span>
      </div>

      {expanded &&
        vault.strategies.map((strat, i) => (
          <StrategyNode
            key={strat.address}
            strategy={strat}
            vaultMap={vaultMap}
            depth={1}
            visited={visited}
            topLevelAddresses={topLevelAddresses}
            isLast={i === vault.strategies.length - 1}
            parentChainId={vault.chainId}
          />
        ))}
    </div>
  );
}

export function AuditPanel() {
  const { chainFilter, setLastFetchedAt } = useContext(DashboardContext);
  const [search, setSearch] = useState("");
  const [showOverlapOnly, setShowOverlapOnly] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const debouncedSearch = useDebouncedValue(search);

  const url = `/api/audit/tree${chainFilter !== "all" ? `?chainId=${chainFilter}` : ""}`;
  const { data, loading, fetchedAt } = useFetch<AuditTreeResponse>(url);

  useEffect(() => {
    if (fetchedAt) setLastFetchedAt(fetchedAt);
  }, [fetchedAt, setLastFetchedAt]);

  // Build vault lookup map for recursive tree
  const vaultMap = useMemo(() => {
    if (!data) return new Map<string, AuditVault>();
    return new Map(data.vaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));
  }, [data]);

  const filteredVaults = useMemo(() => {
    if (!data) return [];
    const typeFilterFn = (v: AuditVault) =>
      typeFilter === "curation"
        ? v.category === "curation"
        : typeFilter === "allocator"
          ? v.vaultType === 1
          : typeFilter === "strategy"
            ? v.vaultType === 2
            : true;

    const searchFilterFn = debouncedSearch
      ? (
          (q) => (v: AuditVault) =>
            (v.name || "").toLowerCase().includes(q) || v.address.toLowerCase().includes(q)
        )(debouncedSearch.toLowerCase())
      : () => true;

    return data.vaults
      .filter((v) => includeRetired || !v.isRetired)
      .filter((v) => !showOverlapOnly || v.strategies.some((s) => s.targetVaultAddress != null))
      .filter(typeFilterFn)
      .filter(searchFilterFn);
  }, [data, debouncedSearch, showOverlapOnly, includeRetired, typeFilter]);

  // Set of top-level vault addresses for depth limiting
  const topLevelAddresses = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.vaults.map((v) => `${v.chainId}:${v.address.toLowerCase()}`));
  }, [data]);

  const totalOverlapStrategies = useMemo(
    () => (data ? data.vaults.reduce((sum, v) => sum + v.strategies.filter((s) => s.targetVaultAddress != null).length, 0) : 0),
    [data],
  );

  if (loading)
    return (
      <>
        <SkeletonCards count={3} />
        <SkeletonChart />
      </>
    );
  if (!data) return null;

  return (
    <>
      {/* ── Summary Metrics ── */}
      <div className="metric-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="metric metric-accent">
          <div className="label">Summed TVL (raw)</div>
          <div className="value">{fmt(data.summedTvl)}</div>
          <div className="sub">{data.vaultCount} vaults total</div>
        </div>
        <div className="metric metric-red">
          <div className="label">Strategy Overlap</div>
          <div className="value" style={{ color: "var(--red)" }}>
            -{fmt(data.overlapTvl)}
          </div>
          <div className="sub">{totalOverlapStrategies} vault-to-vault</div>
        </div>
        <div className="metric metric-red">
          <div className="label">Cross-Chain Overlap</div>
          <div className="value" style={{ color: "var(--red)" }}>
            -{fmt(data.crossChainOverlap)}
          </div>
          <div className="sub">retired, capital migrated</div>
        </div>
        <div className="metric metric-green">
          <div className="label">Net TVL</div>
          <div className="value" style={{ color: "var(--green)" }}>
            {fmt(data.summedTvl - data.overlapTvl - data.crossChainOverlap)}
          </div>
          <div className="sub">after all deductions</div>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        <label className={`filter-pill${showOverlapOnly ? " active" : ""}`} style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={showOverlapOnly} onChange={(e) => setShowOverlapOnly(e.target.checked)} />
          Overlap only
        </label>

        <label className={`filter-pill${includeRetired ? " active" : ""}`} style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includeRetired} onChange={(e) => setIncludeRetired(e.target.checked)} />
          Include retired
        </label>

        <select className="filter-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="curation">Curation</option>
          <option value="allocator">Allocator</option>
          <option value="strategy">Strategy</option>
        </select>

        <input className="search-input" placeholder="Search vaults..." value={search} onChange={(e) => setSearch(e.target.value)} />

        <span className="text-dim" style={{ fontSize: "0.78rem", marginLeft: "auto" }}>
          {filteredVaults.length} vaults
        </span>
      </div>

      {/* ── Audit Tree ── */}
      <div className="card audit-tree">
        <div className="audit-tree-header">
          <span style={{ fontWeight: 600 }}>Vault</span>
          <span className="audit-cols audit-cols-header">
            <span className="audit-col-strats">Strats</span>
            <span className="audit-col-tvl">Vault TVL</span>
            <span className="audit-col-overlaps">Overlaps</span>
            <span className="audit-col-counted">Counted</span>
          </span>
        </div>

        {filteredVaults.map((vault) => (
          <VaultNode key={`${vault.chainId}:${vault.address}`} vault={vault} vaultMap={vaultMap} topLevelAddresses={topLevelAddresses} />
        ))}

        {filteredVaults.length === 0 && (
          <div className="text-dim" style={{ textAlign: "center", padding: "2rem" }}>
            No vaults match the current filters
          </div>
        )}
      </div>
    </>
  );
}
