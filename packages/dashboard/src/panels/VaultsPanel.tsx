import { useContext, useMemo, useState } from "react";
import { DashboardContext } from "../App";
import { type VaultDetail, VaultDrawer } from "../components/VaultDrawer";
import {
  CHAIN_NAMES,
  CHAIN_SHORT,
  EXPLORER_URLS,
  exportCSV,
  fmt,
  SkeletonCards,
  SkeletonChart,
  shortAddr,
  useDebouncedValue,
  useFetch,
  useSort,
} from "../hooks";

interface VaultTvl {
  address: string;
  chainId: number;
  name: string | null;
  category: string;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
}

interface Overlap {
  totalOverlap: number;
  autoOverlap: number;
  registryOverlap: number;
  count: number;
  overlaps: Array<{
    sourceVault: string;
    targetVault: string;
    strategyAddress: string;
    overlapUsd: number;
    sourceCategory: string;
    targetCategory: string;
    detectionMethod: "auto" | "registry";
    label?: string;
  }>;
}

const PAGE_SIZE = 50;

function categoryBadge(cat: string) {
  const cls =
    cat === "v2" ? "badge badge-v2" : cat === "v3" ? "badge badge-v3" : cat === "curation" ? "badge badge-curation" : "badge badge-v1";
  return <span className={cls}>{cat}</span>;
}

export function VaultsPanel() {
  const { chainFilter, density } = useContext(DashboardContext);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [drawerVault, setDrawerVault] = useState<VaultDetail | null>(null);
  const vaultSort = useSort("tvl");
  const overlapSort = useSort("overlap");

  const url = `/api/tvl/vaults?includeRetired=${includeRetired}${categoryFilter !== "all" ? `&category=${categoryFilter}` : ""}`;
  const { data, loading } = useFetch<{ count: number; vaults: VaultTvl[] }>(url);
  const { data: overlap } = useFetch<Overlap>("/api/tvl/overlap");

  // Reset page when filters change
  const handleCategoryChange = (val: string) => {
    setCategoryFilter(val);
    setPage(0);
  };
  const handleRetiredToggle = (checked: boolean) => {
    setIncludeRetired(checked);
    setPage(0);
  };

  // Build per-vault overlap map (source vault address → total overlap deducted)
  const vaultOverlapMap = useMemo(() => {
    if (!overlap) return new Map<string, number>();
    return overlap.overlaps.reduce((map, o) => {
      const key = o.sourceVault.toLowerCase();
      return map.set(key, (map.get(key) || 0) + o.overlapUsd);
    }, new Map<string, number>());
  }, [overlap]);

  // Filter vaults by global chain + search
  const searchFiltered = useMemo(() => {
    if (!data) return [];
    const chainFiltered = chainFilter !== "all" ? data.vaults.filter((v) => String(v.chainId) === chainFilter) : data.vaults;
    return debouncedSearch
      ? chainFiltered.filter((v) => (v.name || v.address).toLowerCase().includes(debouncedSearch.toLowerCase()))
      : chainFiltered;
  }, [data, debouncedSearch, chainFilter]);

  const sortedVaults = useMemo(
    () =>
      vaultSort.sorted(searchFiltered, {
        name: (v) => v.name || "",
        address: (v) => v.address,
        chain: (v) => CHAIN_NAMES[v.chainId] || String(v.chainId),
        category: (v) => v.category,
        type: (v) => v.vaultType ?? 0,
        tvl: (v) => v.tvlUsd,
      }),
    [searchFiltered, vaultSort.sorted],
  );

  const filteredTvl = useMemo(() => searchFiltered.reduce((sum, v) => sum + v.tvlUsd, 0), [searchFiltered]);

  const filteredCount = useMemo(() => searchFiltered.length, [searchFiltered]);

  const maxTvl = useMemo(() => (sortedVaults.length > 0 ? Math.max(...sortedVaults.map((v) => v.tvlUsd)) : 1), [sortedVaults]);

  const sortedOverlaps = useMemo(
    () =>
      overlap
        ? overlapSort.sorted(overlap.overlaps, {
            source: (o) => o.sourceVault,
            target: (o) => o.targetVault,
            strategy: (o) => o.strategyAddress,
            flow: (o) => `${o.sourceCategory} → ${o.targetCategory}`,
            detection: (o) => o.detectionMethod,
            overlap: (o) => o.overlapUsd,
          })
        : [],
    [overlap, overlapSort.sorted],
  );

  if (loading)
    return (
      <>
        <SkeletonCards count={3} />
        <SkeletonChart />
      </>
    );
  if (!data) return null;

  const totalPages = Math.max(1, Math.ceil(sortedVaults.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pagedVaults = sortedVaults.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <>
      {/* ── Summary Metrics ── */}
      <div className="metric-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="metric metric-accent">
          <div className="label">Total Vaults</div>
          <div className="value">{filteredCount.toLocaleString()}</div>
          <div className="sub">
            {categoryFilter !== "all" ? categoryFilter.toUpperCase() : "All categories"}
            {includeRetired ? " (incl. retired)" : ""}
          </div>
        </div>
        <div className="metric metric-green">
          <div className="label">Net TVL</div>
          <div className="value" style={{ color: "var(--green)" }}>
            {fmt(filteredTvl - (overlap?.totalOverlap ?? 0))}
          </div>
          <div className="sub">Gross {fmt(filteredTvl)} minus overlap</div>
        </div>
        <div className="metric metric-yellow">
          <div className="label">Overlap Deducted</div>
          <div className="value" style={{ color: "var(--yellow)" }}>
            {overlap ? `-${fmt(overlap.totalOverlap)}` : "-"}
          </div>
          <div className="sub">
            {overlap
              ? `${overlap.count} flows (auto: ${fmt(overlap.autoOverlap)}, registry: ${fmt(overlap.registryOverlap)})`
              : "Loading..."}
          </div>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        <label className={`filter-pill${includeRetired ? " active" : ""}`} style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includeRetired} onChange={(e) => handleRetiredToggle(e.target.checked)} />
          Include retired
        </label>

        <select className="filter-select" value={categoryFilter} onChange={(e) => handleCategoryChange(e.target.value)}>
          <option value="all">All categories</option>
          <option value="v2">V2</option>
          <option value="v3">V3</option>
          <option value="curation">Curation</option>
        </select>

        <input
          className="search-input"
          placeholder="Search vaults..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />

        <span className="text-dim" style={{ fontSize: "0.78rem", marginLeft: "auto" }}>
          {filteredCount} vaults &middot; {fmt(filteredTvl)} TVL
        </span>
        <button
          className="btn-export"
          onClick={() =>
            exportCSV(
              "vaults.csv",
              ["Vault", "Address", "Chain", "Category", "Type", "TVL"],
              sortedVaults.map((v) => [
                v.name || "",
                v.address,
                CHAIN_NAMES[v.chainId] || String(v.chainId),
                v.category,
                v.vaultType === 1 ? "Allocator" : v.vaultType === 2 ? "Strategy" : "-",
                v.tvlUsd,
              ]),
            )
          }
        >
          Export CSV
        </button>
      </div>

      {/* ── Vaults Table ── */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-scroll">
          <table className={density === "compact" ? "density-compact" : ""}>
            <thead>
              <tr>
                <th {...vaultSort.th("name", "Vault")} />
                <th {...vaultSort.th("address", "Address")} />
                <th {...vaultSort.th("chain", "Chain")} />
                <th {...vaultSort.th("category", "Category")} />
                <th {...vaultSort.th("type", "Type")} />
                <th {...vaultSort.th("tvl", "TVL", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {pagedVaults.map((v) => {
                const overlapAmt = vaultOverlapMap.get(v.address.toLowerCase());
                const barPct = maxTvl > 0 ? (v.tvlUsd / maxTvl) * 100 : 0;
                const fillClass =
                  v.category === "v2" ? "fill-blue" : v.category === "v3" ? "fill-green" : v.category === "curation" ? "fill-yellow" : "";

                return (
                  <tr key={`${v.chainId}:${v.address}`} onClick={() => setDrawerVault(v)} style={{ cursor: "pointer" }}>
                    {/* Vault Name */}
                    <td>
                      <div className="vault-name">
                        <span title={v.name || v.address}>
                          {v.name ? (v.name.length > 30 ? `${v.name.slice(0, 30)}...` : v.name) : "-"}
                        </span>
                        {v.isRetired && (
                          <span
                            className="badge"
                            style={{
                              background: "var(--red-dim)",
                              color: "var(--red)",
                              fontSize: "0.6rem",
                              padding: "0.05rem 0.35rem",
                              flexShrink: 0,
                            }}
                          >
                            retired
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Address */}
                    <td>
                      {EXPLORER_URLS[v.chainId] ? (
                        <a
                          href={`${EXPLORER_URLS[v.chainId]}/${v.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="explorer-link"
                          style={{ marginLeft: 0 }}
                        >
                          {shortAddr(v.address)}
                        </a>
                      ) : (
                        <span className="text-dim">{shortAddr(v.address)}</span>
                      )}
                    </td>

                    {/* Chain */}
                    <td>
                      <span className="text-dim" style={{ fontSize: "0.75rem" }}>
                        {CHAIN_SHORT[v.chainId] || CHAIN_NAMES[v.chainId] || v.chainId}
                      </span>
                    </td>

                    {/* Category */}
                    <td>{categoryBadge(v.category)}</td>

                    {/* Type */}
                    <td className="text-dim">{v.vaultType === 1 ? "Allocator" : v.vaultType === 2 ? "Strategy" : "-"}</td>

                    {/* TVL with inline bar */}
                    <td className="text-right">
                      <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmt(v.tvlUsd)}</div>
                      {overlapAmt != null && overlapAmt > 0 && (
                        <div className="text-yellow" style={{ fontSize: "0.68rem" }}>
                          -{fmt(overlapAmt)} overlap
                        </div>
                      )}
                      <div className="inline-bar-track" style={{ maxWidth: 80, marginTop: 3, marginLeft: "auto" }}>
                        <div className={`inline-bar-fill ${fillClass}`} style={{ width: `${barPct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.75rem 1.25rem",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button className="page-btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            Prev
          </button>
          <span className="text-dim" style={{ fontSize: "0.78rem" }}>
            Page {currentPage + 1} of {totalPages}
            <span style={{ marginLeft: "0.5rem", color: "var(--text-3)" }}>({filteredCount} vaults)</span>
          </span>
          <button className="page-btn" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>
            Next
          </button>
        </div>
      </div>

      {/* ── Overlap Flows ── */}
      {overlap && overlap.count > 0 && (
        <div className="card">
          <h2>Overlap Flows</h2>

          {/* Overlap header stats */}
          <div
            style={{
              display: "flex",
              gap: "1.5rem",
              alignItems: "baseline",
              marginBottom: "1rem",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--yellow)" }}>{fmt(overlap.totalOverlap)}</span>
            <span className="text-dim" style={{ fontSize: "0.78rem" }}>
              {overlap.count} flows
            </span>
            <span style={{ fontSize: "0.75rem" }}>
              <span className="text-dim">Auto: </span>
              <span style={{ color: "var(--text)" }}>{fmt(overlap.autoOverlap)}</span>
            </span>
            <span style={{ fontSize: "0.75rem" }}>
              <span className="text-dim">Registry: </span>
              <span className="text-yellow">{fmt(overlap.registryOverlap)}</span>
            </span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th {...overlapSort.th("source", "Source")} />
                  <th {...overlapSort.th("target", "Target")} />
                  <th {...overlapSort.th("strategy", "Strategy")} />
                  <th {...overlapSort.th("flow", "Flow")} />
                  <th {...overlapSort.th("detection", "Detection")} />
                  <th {...overlapSort.th("overlap", "Amount", "text-right")} />
                </tr>
              </thead>
              <tbody>
                {sortedOverlaps.slice(0, 20).map((o, i) => (
                  <tr key={i}>
                    <td>
                      <span className="text-dim" style={{ fontSize: "0.75rem" }}>
                        {shortAddr(o.sourceVault)}
                      </span>
                    </td>
                    <td>
                      <span className="text-dim" style={{ fontSize: "0.75rem" }}>
                        {shortAddr(o.targetVault)}
                      </span>
                    </td>
                    <td>
                      <span className="text-dim" style={{ fontSize: "0.75rem" }}>
                        {shortAddr(o.strategyAddress)}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                        {categoryBadge(o.sourceCategory)}
                        <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                          &#8594;
                        </span>
                        {categoryBadge(o.targetCategory)}
                      </div>
                    </td>
                    <td>
                      {o.detectionMethod === "registry" ? (
                        <span className="text-yellow" title={o.label || "registry"}>
                          {o.label || "registry"}
                        </span>
                      ) : (
                        <span className="text-dim">auto</span>
                      )}
                    </td>
                    <td className="text-right">
                      <span className="text-yellow" style={{ fontWeight: 600 }}>
                        {fmt(o.overlapUsd)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {overlap.count > 20 && (
            <div className="text-dim" style={{ textAlign: "center", padding: "0.75rem 0 0.25rem", fontSize: "0.75rem" }}>
              Showing top 20 of {overlap.count} overlap flows
            </div>
          )}
        </div>
      )}

      <VaultDrawer vault={drawerVault} onClose={() => setDrawerVault(null)} />
    </>
  );
}
