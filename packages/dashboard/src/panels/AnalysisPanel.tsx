import { useMemo } from "react";
import { useFetch, fmt, useSort, CHAIN_SHORT, CHAIN_NAMES, EXPLORER_URLS, exportCSV, SkeletonCards, SkeletonChart } from "../hooks";

interface DeadTvlResult {
  summary: {
    totalDeadTvl: number;
    totalLowYieldTvl: number;
    healthyTvl: number;
    deadVaultCount: number;
    lowYieldCount: number;
    healthyCount: number;
  };
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: string;
    tvlUsd: number;
    gains365d: number;
    gainToTvlRatio: number;
    feeRevenue365d: number;
    classification: string;
    reportCount365d: number;
  }>;
}

interface RetiredResult {
  count: number;
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: string;
    tvlUsd: number;
  }>;
}

interface StickyResult {
  count: number;
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    tvlUsd: number;
    depositorCount: number;
    topDepositorPercent: number;
    isSingleDepositor: boolean;
  }>;
}

function ExplorerLink({ address, chainId }: { address: string; chainId: number }) {
  const base = EXPLORER_URLS[chainId];
  if (!base) return null;
  return (
    <a
      href={`${base}/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      title="View on explorer"
      className="explorer-link"
    >
      &#x2197;
    </a>
  );
}

function badgeClass(c: string) {
  return c === "dead"
    ? "badge badge-dead"
    : c === "low-yield"
      ? "badge badge-low-yield"
      : "badge badge-healthy";
}

function concentrationColor(pct: number): string {
  if (pct > 80) return "text-red";
  if (pct > 50) return "text-yellow";
  return "text-green";
}

export function AnalysisPanel() {
  const { data: dead, loading: l1 } = useFetch<DeadTvlResult>("/api/analysis/dead");
  const { data: retired, loading: l2 } = useFetch<RetiredResult>("/api/analysis/retired");
  const { data: sticky, loading: l3 } = useFetch<StickyResult>("/api/analysis/sticky");
  const healthSort = useSort("tvl");
  const retiredSort = useSort("tvl");
  const stickySort = useSort("tvl");

  // All hooks must be called unconditionally (before any early returns)
  const retiredTvl = useMemo(
    () => (retired ? retired.vaults.reduce((a, v) => a + v.tvlUsd, 0) : 0),
    [retired],
  );

  const { totalAnalyzed, healthyPct, deadPct, lowYieldPct, healthyBarPct } = useMemo(() => {
    if (!dead) return { totalAnalyzed: 0, healthyPct: "0", deadPct: 0, lowYieldPct: 0, healthyBarPct: 0 };
    const s = dead.summary;
    const total = s.totalDeadTvl + s.totalLowYieldTvl + s.healthyTvl;
    return {
      totalAnalyzed: total,
      healthyPct: total > 0 ? ((s.healthyTvl / total) * 100).toFixed(1) : "0",
      deadPct: total > 0 ? (s.totalDeadTvl / total) * 100 : 0,
      lowYieldPct: total > 0 ? (s.totalLowYieldTvl / total) * 100 : 0,
      healthyBarPct: total > 0 ? (s.healthyTvl / total) * 100 : 0,
    };
  }, [dead]);

  const healthVaults = useMemo(
    () => (dead ? dead.vaults.filter((v) => v.tvlUsd > 10_000) : []),
    [dead],
  );

  const sortedHealth = useMemo(
    () => healthSort.sorted(healthVaults, {
      name: (v) => v.name || "",
      chain: (v) => CHAIN_SHORT[v.chainId] || String(v.chainId),
      category: (v) => v.category, tvl: (v) => v.tvlUsd,
      gains: (v) => v.gains365d, ratio: (v) => v.gainToTvlRatio,
      reports: (v) => v.reportCount365d, status: (v) => v.classification,
    }),
    [healthVaults, healthSort.sorted],
  );

  const sortedRetired = useMemo(
    () => (retired ? retiredSort.sorted(retired.vaults, {
      name: (v) => v.name || "",
      chain: (v) => CHAIN_SHORT[v.chainId] || String(v.chainId),
      category: (v) => v.category, tvl: (v) => v.tvlUsd,
    }) : []),
    [retired, retiredSort.sorted],
  );

  const stickyFiltered = useMemo(
    () => (sticky ? sticky.vaults.filter((v) => v.tvlUsd > 100_000) : []),
    [sticky],
  );

  const sortedSticky = useMemo(
    () => stickySort.sorted(stickyFiltered, {
      name: (v) => v.name || "", tvl: (v) => v.tvlUsd,
      depositors: (v) => v.depositorCount, topHolder: (v) => v.topDepositorPercent,
    }),
    [stickyFiltered, stickySort.sorted],
  );

  if (l1 || l2 || l3) return <><SkeletonCards count={5} /><SkeletonChart /></>;
  if (!dead || !retired || !sticky) return null;

  const s = dead.summary;

  return (
    <>
      {/* Metric cards */}
      <div className="metric-grid">
        <div className="metric metric-red">
          <div className="label">Dead TVL</div>
          <div className="value text-red">{fmt(s.totalDeadTvl)}</div>
          <div className="sub">{s.deadVaultCount} vaults — no reports in 365d</div>
        </div>
        <div className="metric metric-yellow">
          <div className="label">Low-Yield TVL</div>
          <div className="value text-yellow">{fmt(s.totalLowYieldTvl)}</div>
          <div className="sub">{s.lowYieldCount} vaults — &lt;0.1% gain/TVL</div>
        </div>
        <div className="metric metric-green">
          <div className="label">Healthy TVL</div>
          <div className="value text-green">{fmt(s.healthyTvl)}</div>
          <div className="sub">{s.healthyCount} vaults</div>
        </div>
        <div className="metric">
          <div className="label">Retired TVL</div>
          <div className="value text-dim">{fmt(retiredTvl)}</div>
          <div className="sub">{retired.count} vaults still holding funds</div>
        </div>
        <div className="metric metric-accent">
          <div className="label">Healthy %</div>
          <div className="value" style={{ color: "var(--accent)" }}>{healthyPct}%</div>
          <div className="sub">of analyzed TVL</div>
        </div>
      </div>

      {/* Health Composition Bar */}
      <div className="card" style={{ paddingTop: "16px", paddingBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <h2 style={{ margin: 0 }}>TVL Health Composition</h2>
          <span className="text-dim" style={{ fontSize: "13px" }}>
            {fmt(totalAnalyzed)} analyzed
          </span>
        </div>
        <div className="composition-bar">
          {deadPct > 0 && (
            <div
              style={{
                width: `${deadPct}%`,
                backgroundColor: "#f6465d",
                borderRadius: "4px",
                minWidth: deadPct > 0.5 ? undefined : "4px",
              }}
              title={`Dead: ${fmt(s.totalDeadTvl)} (${deadPct.toFixed(1)}%)`}
            />
          )}
          {lowYieldPct > 0 && (
            <div
              style={{
                width: `${lowYieldPct}%`,
                backgroundColor: "#f0b90b",
                borderRadius: "4px",
                minWidth: lowYieldPct > 0.5 ? undefined : "4px",
              }}
              title={`Low-Yield: ${fmt(s.totalLowYieldTvl)} (${lowYieldPct.toFixed(1)}%)`}
            />
          )}
          {healthyBarPct > 0 && (
            <div
              style={{
                width: `${healthyBarPct}%`,
                backgroundColor: "#0ecb81",
                borderRadius: "4px",
                minWidth: healthyBarPct > 0.5 ? undefined : "4px",
              }}
              title={`Healthy: ${fmt(s.healthyTvl)} (${healthyBarPct.toFixed(1)}%)`}
            />
          )}
        </div>
        <div className="composition-legend">
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span className="legend-dot" style={{ backgroundColor: "#f6465d" }} />
            <span className="text-dim" style={{ fontSize: "12px" }}>Dead {fmt(s.totalDeadTvl)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span className="legend-dot" style={{ backgroundColor: "#f0b90b" }} />
            <span className="text-dim" style={{ fontSize: "12px" }}>Low-Yield {fmt(s.totalLowYieldTvl)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span className="legend-dot" style={{ backgroundColor: "#0ecb81" }} />
            <span className="text-dim" style={{ fontSize: "12px" }}>Healthy {fmt(s.healthyTvl)}</span>
          </div>
        </div>
      </div>

      {/* Vault Health Table */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Vault Health</h2>
          <button className="btn-export" onClick={() => exportCSV("vault-health.csv", ["Vault", "Chain", "Category", "TVL", "365d Gains", "Gain/TVL", "Reports", "Status"], sortedHealth.map(v => [v.name || v.address, CHAIN_SHORT[v.chainId] || String(v.chainId), v.category, v.tvlUsd, v.gains365d, (v.gainToTvlRatio * 100).toFixed(2) + "%", v.reportCount365d, v.classification]))}>Export CSV</button>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th {...healthSort.th("name", "Vault")} />
                <th {...healthSort.th("chain", "Chain")} />
                <th {...healthSort.th("category", "Cat")} />
                <th {...healthSort.th("tvl", "TVL", "text-right")} />
                <th {...healthSort.th("gains", "365d Gains", "text-right")} />
                <th {...healthSort.th("ratio", "Gain/TVL", "text-right")} />
                <th {...healthSort.th("reports", "365d Reports", "text-right")} />
                <th {...healthSort.th("status", "Status")} />
              </tr>
            </thead>
            <tbody>
              {sortedHealth.slice(0, 30).map((v) => (
                <tr key={`health-${v.chainId}:${v.address}`}>
                  <td>
                    <span className="vault-name">
                      {v.name ? v.name.slice(0, 28) : v.address.slice(0, 10)}
                    </span>
                    <ExplorerLink address={v.address} chainId={v.chainId} />
                  </td>
                  <td className="text-dim">{CHAIN_SHORT[v.chainId] || v.chainId}</td>
                  <td className="text-dim">{v.category}</td>
                  <td className="text-right">{fmt(v.tvlUsd)}</td>
                  <td className="text-right">{fmt(v.gains365d)}</td>
                  <td className="text-right">{(v.gainToTvlRatio * 100).toFixed(2)}%</td>
                  <td className="text-right">{v.reportCount365d}</td>
                  <td>
                    <span className={badgeClass(v.classification)}>{v.classification}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Retired + Depositor Concentration side-by-side */}
      <div className="row">
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Retired Vaults</h2>
            <button className="btn-export" onClick={() => exportCSV("retired-vaults.csv", ["Vault", "Chain", "Category", "TVL"], sortedRetired.map(v => [v.name || v.address, CHAIN_SHORT[v.chainId] || String(v.chainId), v.category, v.tvlUsd]))}>Export CSV</button>
          </div>
          <div className="stat-row" style={{ marginBottom: "12px" }}>
            <span className="stat-label">Total retired TVL</span>
            <span className="stat-value text-dim">{fmt(retiredTvl)}</span>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th {...retiredSort.th("name", "Vault")} />
                  <th {...retiredSort.th("chain", "Chain")} />
                  <th {...retiredSort.th("category", "Category")} />
                  <th {...retiredSort.th("tvl", "TVL", "text-right")} />
                </tr>
              </thead>
              <tbody>
                {sortedRetired.slice(0, 10).map((v) => (
                  <tr key={`retired-${v.chainId}:${v.address}`}>
                    <td>
                      <span className="vault-name">
                        {v.name ? v.name.slice(0, 28) : v.address.slice(0, 10)}
                      </span>
                      <ExplorerLink address={v.address} chainId={v.chainId} />
                    </td>
                    <td className="text-dim">{CHAIN_SHORT[v.chainId] || v.chainId}</td>
                    <td className="text-dim">{v.category}</td>
                    <td className="text-right">{fmt(v.tvlUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>Depositor Concentration</h2>
          <div className="stat-row" style={{ marginBottom: "12px" }}>
            <span className="stat-label">Vaults &gt; $100K</span>
            <span className="stat-value">{stickyFiltered.length}</span>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th {...stickySort.th("name", "Vault")} />
                  <th {...stickySort.th("tvl", "TVL", "text-right")} />
                  <th {...stickySort.th("depositors", "Depositors", "text-right")} />
                  <th {...stickySort.th("topHolder", "Top Holder %", "text-right")} />
                </tr>
              </thead>
              <tbody>
                {sortedSticky.slice(0, 15).map((v) => (
                  <tr key={`sticky-${v.chainId}:${v.address}`}>
                    <td>
                      <span className="vault-name">
                        {v.name ? v.name.slice(0, 28) : v.address.slice(0, 10)}
                      </span>
                      <ExplorerLink address={v.address} chainId={v.chainId} />
                    </td>
                    <td className="text-right">{fmt(v.tvlUsd)}</td>
                    <td className="text-right">{v.depositorCount}</td>
                    <td className={`text-right ${concentrationColor(v.topDepositorPercent)}`}>
                      {v.topDepositorPercent.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
