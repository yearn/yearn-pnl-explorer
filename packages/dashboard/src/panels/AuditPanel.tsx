import { useState, useContext, useMemo, useCallback } from "react";
import { DashboardContext } from "../App";
import { useFetch, fmt, shortAddr, CHAIN_NAMES, CHAIN_SHORT, EXPLORER_URLS, SkeletonCards, SkeletonChart, useDebouncedValue } from "../hooks";

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
    cat === "v2" ? "badge badge-v2"
    : cat === "v3" ? "badge badge-v3"
    : cat === "curation" ? "badge badge-curation"
    : "badge badge-v1";
  return <span className={cls}>{cat}</span>;
}

function typeBadge(vaultType: number | null) {
  if (vaultType === 1) return <span className="badge" style={{ background: "var(--green-dim)", color: "var(--green)", fontSize: "0.6rem" }}>allocator</span>;
  if (vaultType === 2) return <span className="badge" style={{ background: "var(--blue-dim)", color: "var(--blue)", fontSize: "0.6rem" }}>strategy</span>;
  return null;
}

function ExplorerLink({ address, chainId }: { address: string; chainId: number }) {
  const url = EXPLORER_URLS[chainId];
  if (url) {
    return (
      <a href={`${url}/${address}`} target="_blank" rel="noopener noreferrer" className="explorer-link" style={{ marginLeft: 0 }}>
        {shortAddr(address)}
      </a>
    );
  }
  return <span className="text-dim">{shortAddr(address)}</span>;
}

/** Recursive strategy tree node */
function StrategyNode({
  strategy,
  vaultMap,
  depth,
  visited,
}: {
  strategy: AuditStrategy;
  vaultMap: Map<string, AuditVault>;
  depth: number;
  visited: Set<string>;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const targetVault = strategy.targetVaultAddress
    ? vaultMap.get(`${strategy.targetVaultChainId}:${strategy.targetVaultAddress.toLowerCase()}`)
    : null;

  const hasTarget = targetVault != null;
  const targetKey = targetVault ? `${targetVault.chainId}:${targetVault.address.toLowerCase()}` : null;
  const isCycle = targetKey ? visited.has(targetKey) : false;

  return (
    <div className="audit-strategy-node">
      <div className="audit-row audit-strategy-row" style={{ paddingLeft: `${depth * 1.5 + 1.5}rem` }}>
        <span className="audit-arrow">&#8594;</span>
        <span className="audit-strategy-name" title={strategy.name || strategy.address}>
          {strategy.name || shortAddr(strategy.address)}
        </span>
        <ExplorerLink address={strategy.address} chainId={strategy.targetVaultChainId ?? 0} />
        {strategy.debtUsd > 0 && (
          <span className="audit-debt">{fmt(strategy.debtUsd)}</span>
        )}
        {strategy.detectionMethod && (
          <span className={`audit-overlap-tag ${strategy.detectionMethod === "auto" ? "auto" : "registry"}`}>
            {strategy.detectionMethod === "auto" ? "overlap (auto)" : strategy.label || "overlap (registry)"}
          </span>
        )}
        {hasTarget && !isCycle && (
          <button
            className="audit-expand-btn"
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "\u25BC" : "\u25B6"}
          </button>
        )}
        {isCycle && (
          <span className="audit-cycle-tag">cycle</span>
        )}
      </div>

      {/* If this strategy deposits into another vault, render that vault's subtree */}
      {hasTarget && expanded && !isCycle && targetVault && (
        <VaultSubtree
          vault={targetVault}
          vaultMap={vaultMap}
          depth={depth + 1}
          visited={visited}
        />
      )}
    </div>
  );
}

/** Render a vault's strategies as a subtree (used recursively) */
function VaultSubtree({
  vault,
  vaultMap,
  depth,
  visited,
}: {
  vault: AuditVault;
  vaultMap: Map<string, AuditVault>;
  depth: number;
  visited: Set<string>;
}) {
  const vaultKey = `${vault.chainId}:${vault.address.toLowerCase()}`;
  const nextVisited = new Set(visited);
  nextVisited.add(vaultKey);

  return (
    <div className="audit-vault-subtree">
      <div className="audit-row audit-target-vault-row" style={{ paddingLeft: `${depth * 1.5 + 1.5}rem` }}>
        <span className="audit-arrow">&#8594;</span>
        <span className="audit-vault-indicator">VAULT</span>
        <span className="audit-vault-name" title={vault.name || vault.address}>
          {vault.name || shortAddr(vault.address)}
        </span>
        <ExplorerLink address={vault.address} chainId={vault.chainId} />
        {categoryBadge(vault.category)}
        {typeBadge(vault.vaultType)}
        <span className="audit-tvl">{fmt(vault.tvlUsd)}</span>
        {vault.isRetired && (
          <span className="badge" style={{ background: "var(--red-dim)", color: "var(--red)", fontSize: "0.6rem", padding: "0.05rem 0.35rem" }}>
            retired
          </span>
        )}
      </div>

      {vault.strategies.map((strat) => (
        <StrategyNode
          key={strat.address}
          strategy={strat}
          vaultMap={vaultMap}
          depth={depth + 1}
          visited={nextVisited}
        />
      ))}
    </div>
  );
}

/** Top-level vault node */
function VaultNode({
  vault,
  vaultMap,
}: {
  vault: AuditVault;
  vaultMap: Map<string, AuditVault>;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasStrategies = vault.strategies.length > 0;
  const hasOverlap = vault.strategies.some((s) => s.targetVaultAddress != null);
  const overlapCount = vault.strategies.filter((s) => s.targetVaultAddress != null).length;

  const visited = new Set<string>();
  visited.add(`${vault.chainId}:${vault.address.toLowerCase()}`);

  return (
    <div className={`audit-vault-node${hasOverlap ? " has-overlap" : ""}`}>
      <div
        className="audit-row audit-vault-row"
        onClick={() => hasStrategies && setExpanded((e) => !e)}
        style={{ cursor: hasStrategies ? "pointer" : "default" }}
      >
        {hasStrategies && (
          <span className="audit-toggle">{expanded ? "\u25BC" : "\u25B6"}</span>
        )}
        {!hasStrategies && <span className="audit-toggle-placeholder" />}

        <span className="audit-vault-name" title={vault.name || vault.address}>
          {vault.name || shortAddr(vault.address)}
        </span>

        <ExplorerLink address={vault.address} chainId={vault.chainId} />

        <span className="text-dim" style={{ fontSize: "0.7rem" }}>
          {CHAIN_SHORT[vault.chainId] || CHAIN_NAMES[vault.chainId] || vault.chainId}
        </span>

        {categoryBadge(vault.category)}
        {typeBadge(vault.vaultType)}

        {vault.isRetired && (
          <span className="badge" style={{ background: "var(--red-dim)", color: "var(--red)", fontSize: "0.6rem", padding: "0.05rem 0.35rem" }}>
            retired
          </span>
        )}

        <span className="audit-tvl" style={{ marginLeft: "auto" }}>{fmt(vault.tvlUsd)}</span>

        {hasStrategies && (
          <span className="text-dim" style={{ fontSize: "0.68rem", minWidth: "3rem" }}>
            {vault.strategies.length} strat{vault.strategies.length > 1 ? "s" : ""}
          </span>
        )}

        {overlapCount > 0 && (
          <span className="audit-overlap-count">
            {overlapCount} overlap{overlapCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {expanded && vault.strategies.map((strat) => (
        <StrategyNode
          key={strat.address}
          strategy={strat}
          vaultMap={vaultMap}
          depth={1}
          visited={visited}
        />
      ))}
    </div>
  );
}

export function AuditPanel() {
  const { chainFilter } = useContext(DashboardContext);
  const [search, setSearch] = useState("");
  const [showOverlapOnly, setShowOverlapOnly] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const debouncedSearch = useDebouncedValue(search);

  const url = `/api/audit/tree${chainFilter !== "all" ? `?chainId=${chainFilter}` : ""}`;
  const { data, loading } = useFetch<AuditTreeResponse>(url);

  // Build vault lookup map for recursive tree
  const vaultMap = useMemo(() => {
    if (!data) return new Map<string, AuditVault>();
    return new Map(data.vaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));
  }, [data]);

  const filteredVaults = useMemo(() => {
    if (!data) return [];
    let result = data.vaults;
    if (!includeRetired) result = result.filter((v) => !v.isRetired);
    if (showOverlapOnly) result = result.filter((v) => v.strategies.some((s) => s.targetVaultAddress != null));
    if (typeFilter === "curation") result = result.filter((v) => v.category === "curation");
    else if (typeFilter === "allocator") result = result.filter((v) => v.vaultType === 1);
    else if (typeFilter === "strategy") result = result.filter((v) => v.vaultType === 2);
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((v) =>
        (v.name || "").toLowerCase().includes(q) ||
        v.address.toLowerCase().includes(q),
      );
    }
    return result;
  }, [data, debouncedSearch, showOverlapOnly, includeRetired, typeFilter]);

  const totalOverlapStrategies = useMemo(
    () => data ? data.vaults.reduce((sum, v) => sum + v.strategies.filter((s) => s.targetVaultAddress != null).length, 0) : 0,
    [data],
  );

  if (loading) return <><SkeletonCards count={3} /><SkeletonChart /></>;
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
          <div className="value" style={{ color: "var(--red)" }}>-{fmt(data.overlapTvl)}</div>
          <div className="sub">{totalOverlapStrategies} vault-to-vault</div>
        </div>
        <div className="metric metric-red">
          <div className="label">Cross-Chain Overlap</div>
          <div className="value" style={{ color: "var(--red)" }}>-{fmt(data.crossChainOverlap)}</div>
          <div className="sub">retired, capital migrated</div>
        </div>
        <div className="metric metric-green">
          <div className="label">Net TVL</div>
          <div className="value" style={{ color: "var(--green)" }}>{fmt(data.summedTvl - data.overlapTvl - data.crossChainOverlap)}</div>
          <div className="sub">after all deductions</div>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        <label className={`filter-pill${showOverlapOnly ? " active" : ""}`} style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showOverlapOnly}
            onChange={(e) => setShowOverlapOnly(e.target.checked)}
          />
          Overlap only
        </label>

        <label className={`filter-pill${includeRetired ? " active" : ""}`} style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => setIncludeRetired(e.target.checked)}
          />
          Include retired
        </label>

        <select className="filter-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="curation">Curation</option>
          <option value="allocator">Allocator</option>
          <option value="strategy">Strategy</option>
        </select>

        <input
          className="search-input"
          placeholder="Search vaults..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <span className="text-dim" style={{ fontSize: "0.78rem", marginLeft: "auto" }}>
          {filteredVaults.length} vaults
        </span>
      </div>

      {/* ── Audit Tree ── */}
      <div className="card audit-tree">
        <div className="audit-tree-header">
          <span style={{ fontWeight: 600 }}>Vault</span>
          <span className="text-dim" style={{ marginLeft: "auto", fontSize: "0.75rem" }}>
            Click a vault to expand its strategy tree. Overlaps chain recursively.
          </span>
        </div>

        {filteredVaults.map((vault) => (
          <VaultNode
            key={`${vault.chainId}:${vault.address}`}
            vault={vault}
            vaultMap={vaultMap}
          />
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
